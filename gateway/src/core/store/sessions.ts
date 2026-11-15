// 会话元数据（tenant-store 拆分，DESIGN §31）
// 注意：语句在调用时内联创建（不缓存模块级 prepared statement）——
// maintenance/import 会整体替换 gateway.db 并 reopenDb()，缓存的 statement 会指向已关闭的旧连接。
import { db, strftimeNow } from "./db.ts";
import type { SessionRow } from "./types.ts";

// ---- sessions ----

export function countSessions(uid: string, status: SessionRow["status"] = "active", q?: string): number {
  if (q?.trim()) {
    const like = `%${q.trim()}%`;
    return (
      db
        .query("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND status = ? AND (title LIKE ? OR id LIKE ?)")
        .get(uid, status, like, like) as { n: number }
    ).n;
  }
  return (
    db.query("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND status = ?").get(uid, status) as {
      n: number;
    }
  ).n;
}

export function listSessions(
  uid: string,
  status: SessionRow["status"] = "active",
  limit = 50,
  offset = 0,
  q?: string,
): SessionRow[] {
  if (q?.trim()) {
    const like = `%${q.trim()}%`;
    return db
      .query(
        "SELECT * FROM sessions WHERE user_id = ? AND status = ? AND (title LIKE ? OR id LIKE ?) ORDER BY updated_at DESC LIMIT ? OFFSET ?",
      )
      .all(uid, status, like, like, limit, offset) as SessionRow[];
  }
  return db
    .query("SELECT * FROM sessions WHERE user_id = ? AND status = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?")
    .all(uid, status, limit, offset) as SessionRow[];
}

export function getSession(sid: string): SessionRow | undefined {
  return db.query("SELECT * FROM sessions WHERE id = ?").get(sid) as SessionRow | undefined;
}

export function activeSessionCount(uid: string): number {
  return (
    db.query("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND status = 'active'").get(uid) as { n: number }
  ).n;
}

export function insertSession(row: {
  id: string;
  user_id: string;
  workspace_id: string;
  parent_id?: string | null;
  title?: string;
  session_file?: string | null;
  model_provider?: string | null;
  model_id?: string | null;
}): void {
  db.run(
    `INSERT INTO sessions (id, user_id, workspace_id, parent_id, title, session_file, model_provider, model_id)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      row.id,
      row.user_id,
      row.workspace_id,
      row.parent_id ?? null,
      row.title ?? "",
      row.session_file ?? null,
      row.model_provider ?? null,
      row.model_id ?? null,
    ],
  );
}

export function touchSession(
  sid: string,
  patch: Partial<Pick<SessionRow, "title" | "status" | "model_provider" | "model_id" | "session_file">> = {},
): void {
  const sets = Object.entries(patch).filter(([, v]) => v !== undefined);
  const cols = [...sets.map(([k]) => `${k} = ?`), "updated_at = ?", "last_live_at = ?"];
  const vals = [...sets.map(([, v]) => v as string), strftimeNow(), strftimeNow()];
  db.run(`UPDATE sessions SET ${cols.join(",")} WHERE id = ?`, [...vals, sid]);
}

export function setSessionStatus(sid: string, status: SessionRow["status"]): void {
  const ts = status === "active" ? null : strftimeNow();
  const col = status === "archived" ? "archived_at" : "deleted_at";
  db.run(`UPDATE sessions SET status = ?, ${col} = COALESCE(${col}, ?), updated_at = ? WHERE id = ?`, [
    status,
    ts,
    strftimeNow(),
    sid,
  ]);
}
