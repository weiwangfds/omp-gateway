import * as fs from "node:fs/promises";
import path from "node:path";
import { fromStorePath, toStorePath, userSnapshotsDir } from "./paths.ts";
import {
  autoSnapshotRing,
  autoSnapshotSessionIds,
  deleteSnapshotRow,
  expiredSnapshots,
  getSession,
  getSnapshot,
  insertSnapshot,
  listSnapshots,
  type SnapshotRow,
} from "./tenant-store.ts";

/**
 * 快照服务（DESIGN §5，M4）：Tier 2 checkpoint，**v1 总是物化**。
 * - 创建：把当前会话 JSONL（完整行，容忍截断尾行）复制到 users/<uid>/snapshots/<sid>/<snapId>.jsonl
 * - 自动触发（kind=auto，turn 边界）：每 5 turn / 距上次 auto ≥15min 的下一个 turn 边界；ring 保留最近 K=20
 * - 手动（kind=manual）：TTL 90 天
 * - 恢复：fork = forkFrom(snapshotFile)；rollback = 同 sid 换新文件重建（先自动打 pre_restore 快照）
 */

export const AUTO_RING_K = 20;
export const AUTO_EVERY_TURNS = 5;
export const AUTO_INTERVAL_MS = 15 * 60_000;
export const MANUAL_TTL_DAYS = 90;

/** 快照业务异常；code 由路由映射（EMPTY→409、NOT_FOUND→404、其余→500）。 */
export class SnapshotError extends Error {
  constructor(
    public code: "SNAPSHOT_EMPTY" | "SNAPSHOT_NOT_FOUND" | "SESSION_BUSY" | "SESSION_NOT_LIVE",
    message: string,
  ) {
    super(message);
  }
}

export interface SnapshotMeta extends SnapshotRow {
  bytes: number | null;
}

/** 快照列表（bytes 恒 null——文件大小按需 stat，列表不付出 IO）。 */
export function listSnapshotMetas(sessionId: string): SnapshotMeta[] {
  return listSnapshots(sessionId).map((row) => ({ ...row, bytes: null }));
}

/** 复制 JSONL 的完整行（丢弃截断尾行），返回 {entryCount}。 */
/**
 * 复制 JSONL 的完整行（丢弃截断尾行——崩溃半写保护），返回保留行数。
 * 空内容返回 0，调用方据此判定 SNAPSHOT_EMPTY。
 */
export async function copySnapshotLines(src: string, dest: string): Promise<number> {
  const raw = await fs.readFile(src, "utf8");
  const lines = raw.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop(); // 结尾换行
  let last = lines.length ? lines[lines.length - 1] : "";
  if (last && !raw.endsWith("\n")) {
    // 截断尾行：容不下 JSON 就丢弃（崩溃半写）
    try {
      JSON.parse(last);
    } catch {
      lines.pop();
    }
  }
  last = "";
  const kept = lines;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, kept.length ? `${kept.join("\n")}\n` : "", "utf8");
  return kept.length;
}

/** 创建快照；会话无 JSONL（零 turn）→ SNAPSHOT_EMPTY。 */
/** 创建快照并物化到 users/<uid>/snapshots/<sid>/；零 turn 会话抛 SNAPSHOT_EMPTY。 */
export async function createSnapshot(
  userId: string,
  sid: string,
  opts: {
    kind: "auto" | "manual";
    trigger: string;
    name?: string;
    note?: string;
    turn?: number | null;
    expiresAt?: string | null;
  },
): Promise<SnapshotMeta> {
  const row = getSession(sid);
  if (!row?.session_file) throw new SnapshotError("SNAPSHOT_EMPTY", "session has no transcript file yet");
  const srcFile = fromStorePath(row.session_file);
  if (!(await Bun.file(srcFile).exists()))
    throw new SnapshotError("SNAPSHOT_EMPTY", "session transcript file does not exist yet");

  const snapId = crypto.randomUUID();
  const dest = path.join(userSnapshotsDir(userId), sid, `${snapId}.jsonl`);
  const entryCount = await copySnapshotLines(srcFile, dest);
  if (entryCount === 0) {
    await fs.rm(dest, { force: true });
    throw new SnapshotError("SNAPSHOT_EMPTY", "session transcript is empty");
  }

  insertSnapshot({
    id: snapId,
    session_id: sid,
    kind: opts.kind,
    trigger: opts.trigger,
    name: opts.name ?? null,
    note: opts.note ?? null,
    entry_count: entryCount,
    turn: opts.turn ?? null,
    model_provider: row.model_provider,
    model_id: row.model_id,
    file_path: toStorePath(dest),
    expires_at: opts.expiresAt ?? null,
  });
  const meta = getSnapshot(sid, snapId);
  if (!meta) throw new SnapshotError("SNAPSHOT_NOT_FOUND", "snapshot vanished after insert");
  return { ...meta, bytes: null };
}

/** 单个快照元数据；不存在返回 null。 */
export function getSnapshotMeta(sessionId: string, snapId: string): SnapshotMeta | null {
  const row = getSnapshot(sessionId, snapId);
  return row ? { ...row, bytes: null } : null;
}

/** 删除快照：文件与 DB 行一起清；不存在返回 false。 */
export async function deleteSnapshot(sessionId: string, snapId: string): Promise<boolean> {
  const row = getSnapshot(sessionId, snapId);
  if (!row) return false;
  await fs.rm(fromStorePath(row.file_path), { force: true });
  return deleteSnapshotRow(sessionId, snapId);
}

/** 自动快照判定（turn 边界调用）：turns 触发 或 interval 触发。 */
export async function maybeAutoSnapshot(userId: string, sid: string, turnCount: number): Promise<SnapshotMeta | null> {
  const existing = listSnapshots(sid).filter((s) => s.kind === "auto" && s.trigger === "turns" && s.turn != null);
  const lastTurnSnapshot = existing[0]?.turn ?? 0;
  const lastAutoAt = listSnapshots(sid)
    .filter((s) => s.kind === "auto")
    .map((s) => s.created_at)
    .sort()
    .at(-1);
  const dueByTurns = turnCount > 0 && turnCount - lastTurnSnapshot >= AUTO_EVERY_TURNS;
  const dueByInterval = turnCount > 0 && (!lastAutoAt || Date.now() - Date.parse(lastAutoAt) >= AUTO_INTERVAL_MS);
  if (!dueByTurns && !dueByInterval) return null;
  try {
    return await createSnapshot(userId, sid, {
      kind: "auto",
      trigger: dueByTurns ? "turns" : "interval",
      turn: turnCount,
    });
  } catch {
    return null; // 无文件/空文件等：静默跳过
  }
}

/** rollback 的文件交换准备：快照完整行 → 用户 sessions 目录下的新会话文件（omp 命名约定）。 */
/** rollback 准备：快照完整行 → sessions 目录下的新会话文件（omp 命名约定），返回新文件路径。 */
export async function materializeRollbackFile(
  userId: string,
  _sessionId: string,
  snapshot: SnapshotRow,
): Promise<string> {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  const sessionsDir = path.resolve(userSnapshotsDir(userId), "..", "sessions");
  const finalDest = path.join(sessionsDir, `${stamp}_${crypto.randomUUID()}.jsonl`);
  const count = await copySnapshotLines(fromStorePath(snapshot.file_path), finalDest);
  if (count === 0) throw new SnapshotError("SNAPSHOT_EMPTY", "snapshot has no entries");
  return finalDest;
}

/** Pruner（SnapshotPruner 一次执行）：auto ring 滚动 + 过期删除 + 孤儿文件清理。 */
/** Pruner 一次执行：auto ring 滚动 + manual TTL 过期 + 孤儿文件清理。 */
export async function runSnapshotPruner(
  dataRoot: string,
): Promise<{ ringDeleted: number; expiredDeleted: number; orphansDeleted: number }> {
  let ringDeleted = 0;
  let expiredDeleted = 0;
  let orphansDeleted = 0;

  // auto ring：每会话保留最新 K 个
  for (const sid of autoSnapshotSessionIds()) {
    const ring = autoSnapshotRing(sid);
    if (ring.length <= AUTO_RING_K) continue;
    const victims = ring.slice(0, ring.length - AUTO_RING_K);
    for (const v of victims) {
      await fs.rm(fromStorePath(v.file_path), { force: true }).catch(() => {});
      deleteSnapshotRow(v.session_id, v.id);
      ringDeleted++;
    }
  }

  // manual/过期 TTL
  const cutoff = new Date(Date.now() - MANUAL_TTL_DAYS * 86_400_000).toISOString();
  for (const v of expiredSnapshots(cutoff)) {
    await fs.rm(fromStorePath(v.file_path), { force: true }).catch(() => {});
    deleteSnapshotRow(v.session_id, v.id);
    expiredDeleted++;
  }

  // 孤儿文件：快照目录下的 .jsonl 无对应 DB 行 → 删
  const usersDir = path.join(dataRoot, "users");
  let userDirs: string[] = [];
  try {
    userDirs = await fs.readdir(usersDir);
  } catch {
    return { ringDeleted, expiredDeleted, orphansDeleted };
  }
  for (const uid of userDirs) {
    const snapsRoot = path.join(usersDir, uid, "snapshots");
    let sids: string[] = [];
    try {
      sids = await fs.readdir(snapsRoot);
    } catch {
      continue;
    }
    for (const sid of sids) {
      const dir = path.join(snapsRoot, sid);
      let files: string[] = [];
      try {
        files = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith(".jsonl")) continue;
        const row = getSnapshot(sid, f.replace(/\.jsonl$/, ""));
        if (!row) {
          await fs.rm(path.join(dir, f), { force: true }).catch(() => {});
          orphansDeleted++;
        }
      }
    }
  }
  return { ringDeleted, expiredDeleted, orphansDeleted };
}
