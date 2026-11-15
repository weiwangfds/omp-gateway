// 集成端钩子（tenant-store 拆分，DESIGN §31）
import { db } from "./db.ts";

// ---- 集成端钩子（DESIGN §23）----

export interface IntegrationHookRow {
  id: string;
  user_id: string;
  session_id: string | null;
  event: string;
  matcher_json: string | null;
  url: string;
  secret: string;
  mode: "notify" | "decide";
  timeout_ms: number;
  on_timeout: "allow" | "deny";
  disabled: number;
  created_at: string;
}

/** 注册钩子（用户级 session_id=null 或会话级）；secret 为 whsec_ 密钥。 */
export function createIntegrationHook(row: {
  id: string;
  user_id: string;
  session_id?: string | null;
  event: string;
  matcher?: unknown;
  url: string;
  secret: string;
  mode?: "notify" | "decide";
  timeout_ms?: number;
  on_timeout?: "allow" | "deny";
}): void {
  db.run(
    "INSERT INTO integration_hooks (id, user_id, session_id, event, matcher_json, url, secret, mode, timeout_ms, on_timeout) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [
      row.id,
      row.user_id,
      row.session_id ?? null,
      row.event,
      row.matcher === undefined ? null : JSON.stringify(row.matcher),
      row.url,
      row.secret,
      row.mode ?? "notify",
      row.timeout_ms ?? 3000,
      row.on_timeout ?? "allow",
    ],
  );
}

/** 钩子列表（可按会话过滤，secret 脱敏）。 */
export function listIntegrationHooks(
  userId: string,
  opts: { sessionId?: string; withSecret?: boolean } = {},
): Array<Record<string, unknown>> {
  const rows = (
    opts.sessionId
      ? db
          .query(
            "SELECT * FROM integration_hooks WHERE user_id = ? AND session_id = ? AND disabled = 0 ORDER BY created_at",
          )
          .all(userId, opts.sessionId)
      : db.query("SELECT * FROM integration_hooks WHERE user_id = ? AND disabled = 0 ORDER BY created_at").all(userId)
  ) as IntegrationHookRow[];
  return rows.map((r) => ({
    id: r.id,
    sessionId: r.session_id ?? null,
    event: r.event,
    matcher: r.matcher_json ? JSON.parse(r.matcher_json) : null,
    url: r.url,
    mode: r.mode,
    timeoutMs: r.timeout_ms,
    onTimeout: r.on_timeout,
    createdAt: r.created_at,
    ...(opts.withSecret ? { secret: r.secret } : {}),
  }));
}

/** 分发匹配：会话级 + 用户级（session_id IS NULL），返回含 secret 的原始行。 */
export function listIntegrationHooksForDispatch(
  userId: string,
  sessionId: string,
  event: string,
): IntegrationHookRow[] {
  return db
    .query(
      "SELECT * FROM integration_hooks WHERE user_id = ? AND event = ? AND disabled = 0 AND (session_id IS NULL OR session_id = ?)",
    )
    .all(userId, event, sessionId) as IntegrationHookRow[];
}

/**
 * 注销钩子（软删 disabled=1，保留审计痕迹）。
 * 传 sessionId 只删该会话的钩子；不传只删用户级——不跨作用域级联。
 */
export function deleteIntegrationHook(id: string, userId: string, sessionId?: string): boolean {
  const r = sessionId
    ? db.run("UPDATE integration_hooks SET disabled = 1 WHERE id = ? AND user_id = ? AND session_id = ?", [
        id,
        userId,
        sessionId,
      ])
    : db.run("UPDATE integration_hooks SET disabled = 1 WHERE id = ? AND user_id = ?", [id, userId]);
  return r.changes > 0;
}
