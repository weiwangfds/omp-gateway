/**
 * 审批配置（M7，DESIGN §19/§20）：用户级 mode + 按工具 policies（写 global 层，即时生效）。
 * grants 端点直读 SDK 的 approval-cache.db（官方认可的集成面）。
 */
import { Hono } from "hono";
import * as fs from "node:fs/promises";
import path from "node:path";
import { userAgentDir } from "../../core/paths.ts";
import { userSettings } from "../../core/settings-facade.ts";
import { audit } from "../../core/tenant-store.ts";
import { cfgToolsApproval, cfgToolsApprovalMode } from "@oh-my-pi/pi-coding-agent/tools/settings";
import type { ConfigEnv } from "./env.ts";

const app = new Hono<ConfigEnv>();

/** 审批（M7，DESIGN §19/§20）：用户级 mode + 按工具 policies（config 持久化，按用户隔离）。 */
const APPROVAL_MODES = ["always-ask", "always-ask-cached", "write", "yolo"] as const;
const POLICY_VALUES = ["allow", "deny", "prompt"] as const;
const APPROVAL_KEY_RE = /^[A-Za-z0-9_]{1,128}$/;

app.get("/me/approval", async (c) => {
  const uid = c.get("userId");
  const mode = (await userSettings.read(uid, cfgToolsApprovalMode as never)) ?? "yolo";
  const raw = ((await userSettings.read(uid, cfgToolsApproval as never)) ?? {}) as Record<string, unknown>;
  // 只回显合法策略值，过滤 SDK 内部形状
  const policies: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if ((POLICY_VALUES as readonly string[]).includes(String(v))) policies[k] = String(v);
  }
  return c.json({
    enabled: mode !== "yolo", // 三种询问模式均需审批通道
    mode,
    policies,
  });
});

app.put("/me/approval", async (c) => {
  const uid = c.get("userId");
  const body = await c.req.json().catch(() => null as any);
  // mode：显式 mode 优先；enabled 为向后兼容（true→always-ask，false→yolo）
  let mode: (typeof APPROVAL_MODES)[number] | undefined;
  if (typeof body?.mode === "string") mode = body.mode;
  else if (body?.enabled === true) mode = "always-ask";
  else if (body?.enabled === false) mode = "yolo";
  if (mode !== undefined && !(APPROVAL_MODES as readonly string[]).includes(mode)) {
    return c.json({ error: { code: "BAD_REQUEST", message: `mode must be one of ${APPROVAL_MODES.join("|")}` } }, 400);
  }
  // policies：{工具名: allow|deny|prompt}，整体替换（PUT 语义）
  let policies: Record<string, string> | undefined;
  if (body?.policies !== undefined) {
    if (typeof body.policies !== "object" || Array.isArray(body.policies) || body.policies === null) {
      return c.json(
        { error: { code: "BAD_REQUEST", message: "policies must be an object of toolName → allow|deny|prompt" } },
        400,
      );
    }
    policies = {};
    for (const [k, v] of Object.entries(body.policies)) {
      if (!(POLICY_VALUES as readonly string[]).includes(String(v))) {
        return c.json({ error: { code: "BAD_REQUEST", message: `policy for "${k}" must be allow|deny|prompt` } }, 400);
      }
      if (!APPROVAL_KEY_RE.test(k)) {
        return c.json(
          { error: { code: "BAD_REQUEST", message: `policy key "${k}" invalid (tool name or mcp__server_tool)` } },
          400,
        );
      }
      policies[k] = String(v);
    }
  }
  try {
    if (mode !== undefined) await userSettings.write(uid, cfgToolsApprovalMode as never, mode as never);
    if (policies !== undefined) {
      await userSettings.unset(uid, cfgToolsApproval as never); // 清旧表再写整表
      if (Object.keys(policies).length > 0) await userSettings.write(uid, cfgToolsApproval as never, policies as never);
    }
  } catch (err) {
    return c.json(
      {
        error: {
          code: "BAD_REQUEST",
          message: `settings rejected value: ${err instanceof Error ? err.message : String(err)}`,
        },
      },
      400,
    );
  }
  audit("me.approval", "user", uid, uid, { mode, policies: Object.keys(policies ?? {}).length });
  return c.json({ ok: true, mode: mode ?? (await userSettings.read(uid, cfgToolsApprovalMode as never)) });
});

/** Grants（M7）：always-ask-cached 的持久授权清单（agentDir/approval-cache.db，SDK 官方认可直接读写）。 */
const approvalCachePath = (uid: string) => path.join(userAgentDir(uid), "approval-cache.db");

app.get("/me/approval/grants", async (c) => {
  const uid = c.get("userId");
  const dbFile = approvalCachePath(uid);
  const st = await fs.stat(dbFile).catch(() => null);
  if (!st) return c.json({ grants: [] });
  try {
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbFile, { readonly: true });
    try {
      const rows = db
        .query("SELECT key, tool, approved_at FROM grants ORDER BY approved_at DESC LIMIT 500")
        .all() as Array<{
        key: string;
        tool: string;
        approved_at: string;
      }>;
      return c.json({ grants: rows });
    } finally {
      db.close();
    }
  } catch (err) {
    return c.json(
      {
        error: { code: "INTERNAL", message: `grants read failed: ${err instanceof Error ? err.message : String(err)}` },
      },
      500,
    );
  }
});

app.delete("/me/approval/grants", async (c) => {
  const uid = c.get("userId");
  // 等价 /forget-approvals：清库行（文件保留，避免 SDK 句柄竞争）；live 会话内存 grants 随 dispose 消失
  const dbFile = approvalCachePath(uid);
  let removed = 0;
  try {
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbFile);
    try {
      const info = db.run("DELETE FROM grants");
      removed = info.changes;
    } finally {
      db.close();
    }
  } catch {
    return c.json({ error: { code: "NOT_FOUND", message: "no approval cache" } }, 404);
  }
  audit("me.approval.grants.clear", "user", uid, uid, { removed });
  return c.json({ ok: true, removed });
});

export { app as approvalApp };
