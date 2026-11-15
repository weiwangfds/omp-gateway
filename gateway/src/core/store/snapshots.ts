// 快照元数据（tenant-store 拆分，DESIGN §31）
import { db } from "./db.ts";

// ---- 快照（Tier 2 checkpoint；总是物化，DESIGN §5）----

export interface SnapshotRow {
  id: string;
  session_id: string;
  kind: "auto" | "manual";
  trigger: string;
  name: string | null;
  note: string | null;
  entry_count: number;
  turn: number | null;
  model_provider: string | null;
  model_id: string | null;
  file_path: string;
  created_at: string;
  expires_at: string | null;
}

/** 落一行快照元数据（文件本体由 snapshot-service 物化）。 */
export function insertSnapshot(row: {
  id: string;
  session_id: string;
  kind: "auto" | "manual";
  trigger: string;
  name?: string | null;
  note?: string | null;
  entry_count: number;
  turn?: number | null;
  model_provider?: string | null;
  model_id?: string | null;
  file_path: string;
  expires_at?: string | null;
}): void {
  db.run(
    `INSERT INTO snapshots (id, session_id, kind, trigger, name, note, entry_count, turn, model_provider, model_id, file_path, expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      row.id,
      row.session_id,
      row.kind,
      row.trigger,
      row.name ?? null,
      row.note ?? null,
      row.entry_count,
      row.turn ?? null,
      row.model_provider ?? null,
      row.model_id ?? null,
      row.file_path,
      row.expires_at ?? null,
    ],
  );
}

/** 会话的快照列表（时间倒序）。 */
export function listSnapshots(sessionId: string): SnapshotRow[] {
  return db
    .query("SELECT * FROM snapshots WHERE session_id = ? ORDER BY created_at DESC, id DESC")
    .all(sessionId) as unknown as SnapshotRow[];
}

/** 取单个快照（按会话限定，跨会话不可见）。 */
export function getSnapshot(sessionId: string, snapId: string): SnapshotRow | undefined {
  return db.query("SELECT * FROM snapshots WHERE session_id = ? AND id = ?").get(sessionId, snapId) as unknown as
    | SnapshotRow
    | undefined;
}

/** 删除快照行；文件删除由调用方负责。 */
export function deleteSnapshotRow(sessionId: string, snapId: string): boolean {
  return db.run("DELETE FROM snapshots WHERE session_id = ? AND id = ?", [sessionId, snapId]).changes > 0;
}

/** Pruner：各会话 auto ring 超出 K 的最旧快照（跨会话一次取齐，调用方按会话保留最新 K 个）。 */
export function autoSnapshotRing(sessionId: string): SnapshotRow[] {
  return db
    .query("SELECT * FROM snapshots WHERE session_id = ? AND kind = 'auto' ORDER BY created_at ASC, id ASC")
    .all(sessionId) as unknown as SnapshotRow[];
}

/** Pruner：有 auto 快照的会话全集。 */
export function autoSnapshotSessionIds(): string[] {
  return (
    db.query("SELECT DISTINCT session_id AS sid FROM snapshots WHERE kind = 'auto'").all() as Array<{ sid: string }>
  ).map((r) => r.sid);
}

/** Pruner：过期快照（manual TTL 90d；expires_at 非空即参与过期判定）。 */
export function expiredSnapshots(cutoffIso: string): Array<{ id: string; session_id: string; file_path: string }> {
  return db
    .query("SELECT id, session_id, file_path FROM snapshots WHERE expires_at IS NOT NULL AND expires_at < ?")
    .all(cutoffIso) as unknown as Array<{ id: string; session_id: string; file_path: string }>;
}
