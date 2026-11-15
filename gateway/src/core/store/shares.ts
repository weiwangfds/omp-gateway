// 分享链接（tenant-store 拆分，DESIGN §31）
import { db } from "./db.ts";

export interface ShareRow {
  id: string;
  user_id: string;
  session_id: string;
  access: "view" | "control";
  token_hash: string;
  created_at: string;
  expires_at: string | null;
  revoked: number;
}

/** 签发分享链接（token 明文不落库，只存 sha256）。 */
export function createShare(row: {
  id: string;
  user_id: string;
  session_id: string;
  access: "view" | "control";
  token_hash: string;
  expires_at?: string | null;
}): void {
  db.run("INSERT INTO shares (id, user_id, session_id, access, token_hash, expires_at) VALUES (?,?,?,?,?,?)", [
    row.id,
    row.user_id,
    row.session_id,
    row.access,
    row.token_hash,
    row.expires_at ?? null,
  ]);
}

/** 校验分享令牌：未吊销且未过期。 */
export function findShareByToken(tokenHash: string): ShareRow | undefined {
  return db
    .query("SELECT * FROM shares WHERE token_hash = ? AND revoked = 0 AND (expires_at IS NULL OR expires_at > ?)")
    .get(tokenHash, new Date().toISOString()) as ShareRow | undefined;
}

/** 会话的分享链接列表（不含 token_hash，列表无泄密面）。 */
export function listShares(sessionId: string): Array<Omit<ShareRow, "token_hash">> {
  return db
    .query(
      "SELECT id, user_id, session_id, access, created_at, expires_at, revoked FROM shares WHERE session_id = ? ORDER BY created_at DESC",
    )
    .all(sessionId) as any[];
}

/** 吊销（归属校验在 SQL 条件里，他人不可吊销）。 */
export function revokeShare(id: string, userId: string): boolean {
  const r = db.run("UPDATE shares SET revoked = 1 WHERE id = ? AND user_id = ?", [id, userId]);
  return r.changes > 0;
}
