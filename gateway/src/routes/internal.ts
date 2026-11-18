/**
 * 内部生命周期契约（DESIGN §7）：上游服务专用（svc-token + X-User-Id）。
 * provision / summary / usage / limits / 级联删除 / 审计查询 / trash 找回与列表。
 */
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import path from "node:path";
import { parseUInt } from "./pagination.ts";
import { ensureUserScaffold } from "../core/paths.ts";
import { generateSecret } from "../core/signature.ts";
import {
  audit,
  createWebhook,
  deleteWebhook,
  getOrCreateTenant,
  activeSessionCount,
  getSession,
  queryAudit,
  listWebhooks,
  setSessionStatus,
  setTenantStatus,
  tenantLimits,
  userUsage,
} from "../core/tenant-store.ts";
import { invalidateHookCache, isWebhookUrlAllowed } from "../core/webhooks.ts";
import { registry } from "../core/session-registry.ts";
import { draining } from "../middleware/auth.ts";
import { config } from "../config.ts";

/** trash 找回：清除 deleted_at（setSessionStatus 的 COALESCE 只写不清）。 */
function dbClearDeletedAt(sid: string): void {
  const db = new Database(path.join(config.dataRoot, "gateway.db"));
  try {
    db.run("UPDATE sessions SET deleted_at = NULL WHERE id = ?", [sid]);
  } finally {
    db.close();
  }
}

type Env = { Variables: { userId: string } };

/** 内部生命周期契约（DESIGN §7）：仅上游调用。 */
export const internalApp = new Hono<Env>();

internalApp.post("/users/:uid/provision", async (c) => {
  const uid = c.req.param("uid");
  await ensureUserScaffold(uid);
  const t = getOrCreateTenant(uid);
  audit("tenant.provision", "tenant", uid, uid);
  return c.json({ user_id: uid, status: t.status, limits: tenantLimits(t) }, 201);
});

internalApp.get("/users/:uid/summary", async (c) => {
  const uid = c.req.param("uid");
  const t = getOrCreateTenant(uid);
  return c.json({
    user_id: uid,
    status: t.status,
    limits: tenantLimits(t),
    active_sessions: activeSessionCount(uid),
    live_sessions: registry.countForUser(uid),
    streaming_sessions: registry.countForUser(uid)
      ? [...registry.values()].filter((s) => s.userId === uid && s.streaming).length
      : 0,
  });
});

/** 上游计费/展示用：用户用量聚合（day|model|session 分桶）。 */
internalApp.get("/users/:uid/usage", (c) => {
  const uid = c.req.param("uid");
  const group = (c.req.query("group") ?? "day") as "day" | "model" | "session";
  if (!["day", "model", "session"].includes(group)) {
    return c.json({ error: { code: "BAD_REQUEST", message: "group must be day|model|session" } }, 400);
  }
  return c.json({
    user_id: uid,
    group,
    buckets: userUsage(uid, group, c.req.query("from") ?? undefined, c.req.query("to") ?? undefined),
  });
});

internalApp.patch("/users/:uid/limits", async (c) => {
  const uid = c.req.param("uid");
  const { updateTenantLimits } = await import("../core/tenant-store.ts");
  const body = await c.req.json().catch(() => ({}) as any);
  updateTenantLimits(uid, {
    ...(body?.maxSessions != null ? { maxSessions: Number(body.maxSessions) } : {}),
    ...(body?.maxConcurrent != null ? { maxConcurrent: Number(body.maxConcurrent) } : {}),
    ...(Array.isArray(body?.allowedProviders) ? { allowedProviders: body.allowedProviders.map(String) } : {}),
  });
  audit("tenant.limits", "tenant", uid, uid, body);
  return c.json({ ok: true });
});

/**
 * 用户级联删除（上游删用户时必须回调，合规契约 DESIGN §7/§10）。
 * M1：置 deleted + 释放进程态；M3 补：会话/文件入 trash、30d 物理清除。
 */
internalApp.delete("/users/:uid", async (c) => {
  const uid = c.req.param("uid");
  if (c.req.query("confirm") !== uid) {
    return c.json({ error: { code: "CONFIRM_REQUIRED", message: `pass ?confirm=${uid}` } }, 400);
  }
  for (const ctx of [...registry.values()]) {
    if (ctx.userId === uid) {
      const { disposeSession } = await import("../core/session-factory.ts");
      await disposeSession(ctx);
    }
  }
  const { setTenantStatus } = await import("../core/tenant-store.ts");
  setTenantStatus(uid, "deleted");
  audit("tenant.delete", "tenant", uid, uid);
  return c.json({ user_id: uid, status: "deleted" });
});

/** 审计查询（内部契约）：?user=&action=&page=&per_page= */
internalApp.get("/audit", (c) => {
  const page = Math.max(parseUInt(c.req.query("page"), 1), 1);
  const perPage = Math.min(parseUInt(c.req.query("per_page"), 50), 200);
  const r = queryAudit({
    user: c.req.query("user") ?? undefined,
    action: c.req.query("action") ?? undefined,
    limit: perPage,
    offset: (page - 1) * perPage,
  });
  return c.json({ page, perPage, total: r.total, entries: r.rows });
});

// ---- trash（回收站找回，DESIGN §7 内部契约）----
internalApp.get("/trash", (c) => {
  const db = new Database(path.join(config.dataRoot, "gateway.db"), { readonly: true });
  try {
    const sessions = db
      .query(
        "SELECT id, user_id, title, workspace_id, deleted_at FROM sessions WHERE status='deleted' ORDER BY deleted_at DESC LIMIT 500",
      )
      .all() as Array<Record<string, unknown>>;
    const users = db
      .query("SELECT user_id, updated_at AS deleted_at FROM tenants WHERE status='deleted' ORDER BY updated_at DESC")
      .all() as Array<Record<string, unknown>>;
    return c.json({ sessions, users });
  } finally {
    db.close();
  }
});

/** 找回会话：行恢复 active（清 deleted_at）；purger 未运行前文件仍在原位。 */
internalApp.post("/trash/sessions/:sid/restore", (c) => {
  const sid = c.req.param("sid");
  const row = getSession(sid);
  if (row?.status !== "deleted")
    return c.json({ error: { code: "NOT_FOUND", message: "deleted session not found" } }, 404);
  setSessionStatus(sid, "active");
  dbClearDeletedAt(sid);
  audit("session.restore", "session", sid, row.user_id);
  return c.json({ ok: true, id: sid, userId: row.user_id });
});

/** 找回用户：tenant 恢复 active + 重建目录骨架（若被 purge 过）。 */
internalApp.post("/trash/users/:uid/restore", async (c) => {
  const uid = c.req.param("uid");
  const t = getOrCreateTenant(uid);
  if (t.status !== "deleted") return c.json({ error: { code: "NOT_FOUND", message: "deleted user not found" } }, 404);
  setTenantStatus(uid, "active");
  await ensureUserScaffold(uid);
  audit("tenant.restore", "tenant", uid, uid);
  return c.json({ ok: true, userId: uid });
});

/** drain 模式：拒新会话、健康检查失败摘流量；?off=1 恢复。 */
internalApp.post("/drain", (c) => {
  draining.value = c.req.query("off") !== "1";
  return c.json({ draining: draining.value });
});

// ---- webhooks（会话事件订阅；HMAC 签名推送）----
internalApp.post("/users/:uid/webhooks", async (c) => {
  const uid = c.req.param("uid");
  const body = await c.req.json().catch(() => null as any);
  const url = String(body?.url ?? "");
  if (!/^https?:\/\//.test(url))
    return c.json({ error: { code: "BAD_REQUEST", message: "body.url (http/https) required" } }, 400);
  if (!isWebhookUrlAllowed(url))
    return c.json(
      { error: { code: "FORBIDDEN", message: "webhook host not in allowlist (GATEWAY_WEBHOOK_HOSTS_ALLOWLIST)" } },
      403,
    );
  const events = Array.isArray(body?.events) && body.events.length ? body.events.map(String) : ["*"];
  const secret = typeof body?.secret === "string" && body.secret.length >= 8 ? body.secret : generateSecret();
  const id = crypto.randomUUID();
  createWebhook({ id, user_id: uid, url, secret, events });
  invalidateHookCache(uid);
  audit("webhook.create", "user", uid, uid, { url, events });
  return c.json({ id, url, events, secret }, 201); // secret 仅此一次返回
});

internalApp.get("/users/:uid/webhooks", (c) => {
  const uid = c.req.param("uid");
  return c.json({ webhooks: listWebhooks(uid) });
});

internalApp.delete("/webhooks/:id", (c) => {
  const uid = c.get("userId");
  const ok = deleteWebhook(c.req.param("id"), uid);
  if (ok) invalidateHookCache(uid);
  return ok ? c.json({ ok: true }) : c.json({ error: { code: "NOT_FOUND", message: "webhook not found" } }, 404);
});
