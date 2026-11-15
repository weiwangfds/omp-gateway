// 回调订阅（tenant-store 拆分，DESIGN §31）
import { db } from "./db.ts";

// ---- webhooks（会话事件订阅，HMAC 签名推送）----

export interface WebhookRow {
  id: string;
  user_id: string;
  /** NULL = 用户级（收全部会话事件）；非空 = 只收该会话事件（DESIGN §22） */
  session_id?: string | null;
  url: string;
  secret: string;
  events_json: string;
  disabled: number;
  created_at: string;
}

/** 注册回调（用户级或会话级）；secret 为 whsec_ 密钥。 */
export function createWebhook(row: {
  id: string;
  user_id: string;
  session_id?: string | null;
  url: string;
  secret: string;
  events: string[];
}): void {
  db.run("INSERT INTO webhooks (id, user_id, session_id, url, secret, events_json) VALUES (?,?,?,?,?,?)", [
    row.id,
    row.user_id,
    row.session_id ?? null,
    row.url,
    row.secret,
    JSON.stringify(row.events),
  ]);
}

/** 回调列表（secret 脱敏；opts.sessionId 过滤会话级）。 */
export function listWebhooks(
  userId: string,
  withSecret = false,
  opts?: { sessionId?: string },
): Array<Record<string, unknown>> {
  const rows = (
    opts?.sessionId
      ? db
          .query("SELECT * FROM webhooks WHERE user_id = ? AND session_id = ? AND disabled = 0 ORDER BY created_at")
          .all(userId, opts.sessionId)
      : db.query("SELECT * FROM webhooks WHERE user_id = ? AND disabled = 0 ORDER BY created_at").all(userId)
  ) as WebhookRow[];
  return rows.map((r) => ({
    id: r.id,
    url: r.url,
    sessionId: r.session_id ?? null,
    events: JSON.parse(r.events_json) as string[],
    createdAt: r.created_at,
    ...(withSecret ? { secret: r.secret } : {}),
  }));
}

/** 投递匹配：用户级（session_id IS NULL）收全部会话；会话级只收绑定会话（含 secret）。 */
export function listWebhooksForDispatch(userId: string, sessionId: string): WebhookRow[] {
  return db
    .query("SELECT * FROM webhooks WHERE user_id = ? AND disabled = 0 AND (session_id IS NULL OR session_id = ?)")
    .all(userId, sessionId) as WebhookRow[];
}

/** 注销回调（软删 disabled=1，保留审计痕迹）。 */
export function deleteWebhook(id: string, userId: string, sessionId?: string): boolean {
  const r = sessionId
    ? db.run("UPDATE webhooks SET disabled = 1 WHERE id = ? AND user_id = ? AND session_id = ?", [
        id,
        userId,
        sessionId,
      ])
    : db.run("UPDATE webhooks SET disabled = 1 WHERE id = ? AND user_id = ?", [id, userId]);
  return r.changes > 0;
}
