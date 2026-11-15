import type { Hono } from "hono";
import type { IntegrationEnv, IntegrationShared } from "./shared.ts";
import { generateSecret } from "../../core/signature.ts";
import { audit, createWebhook, deleteWebhook, listWebhooks } from "../../core/tenant-store.ts";
import { invalidateHookCache, isWebhookUrlAllowed } from "../../core/webhooks.ts";

/** 会话级回调订阅（只收本会话事件；用户级见 /api/me/webhooks）。 */
export function mountSessionWebhookRoutes(app: Hono<IntegrationEnv>, shared: IntegrationShared): void {
  const { jsonError, ownedSession } = shared;

  // ---- 回调（DESIGN §22）：**会话级** webhook 订阅（集成端按会话注册，只收该会话事件）----
  // 用户级（跨会话）订阅见 /api/me/webhooks（session_id NULL，收该用户全部会话事件）。
  app.get("/:sid/webhooks", async (c) => {
    const row = ownedSession(c.req.param("sid"), c.get("userId"));
    if (!row) return jsonError(c, 404, "NOT_FOUND", "session not found");
    return c.json({ webhooks: listWebhooks(c.get("userId"), false, { sessionId: row.id }) });
  });

  app.post("/:sid/webhooks", async (c) => {
    const row = ownedSession(c.req.param("sid"), c.get("userId"));
    if (!row) return jsonError(c, 404, "NOT_FOUND", "session not found");
    const body = await c.req.json().catch(() => null as any);
    const url = String(body?.url ?? "");
    if (!/^https?:\/\//.test(url)) return jsonError(c, 400, "BAD_REQUEST", "body.url (http/https) required");
    if (!isWebhookUrlAllowed(url)) {
      return jsonError(c, 403, "FORBIDDEN", "webhook host not in allowlist (GATEWAY_WEBHOOK_HOSTS_ALLOWLIST)");
    }
    const events = Array.isArray(body?.events) && body.events.length ? body.events.map(String) : ["*"];
    const secret = typeof body?.secret === "string" && body.secret.length >= 8 ? body.secret : generateSecret();
    const id = crypto.randomUUID();
    createWebhook({ id, user_id: c.get("userId"), session_id: row.id, url, secret, events });
    invalidateHookCache(c.get("userId"));
    audit("webhook.create", "session", row.id, c.get("userId"), { url, events, scope: "session" });
    return c.json({ id, url, sessionId: row.id, events, secret }, 201); // secret 仅此一次返回
  });

  app.delete("/:sid/webhooks/:id", async (c) => {
    const row = ownedSession(c.req.param("sid"), c.get("userId"));
    if (!row) return jsonError(c, 404, "NOT_FOUND", "session not found");
    const ok = deleteWebhook(c.req.param("id"), c.get("userId"), row.id);
    if (ok) invalidateHookCache(c.get("userId"));
    return ok ? c.json({ ok: true }) : jsonError(c, 404, "NOT_FOUND", "webhook not found");
  });
}
