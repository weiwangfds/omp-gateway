import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.ts";

/**
 * TrashPurger（DESIGN §4）：deleted 超 TTL 的会话/租户物理清除。
 * - 会话：删 JSONL + workspace 目录 + 快照（DB 行一并清）
 * - 租户：rm -rf users/<uid> + 清该用户全部会话/快照行（tenants 行保留作审计墓碑）
 * 可注入 dataRoot（集成测试对服务器数据根直接执行）。
 */
export const TRASH_TTL_DAYS = Number(process.env.GATEWAY_TRASH_TTL_DAYS ?? 30);

/** 执行一次物理清除（deleted 超 TTL 的会话与租户）；可注入 dataRoot 供测试直跑。 */
export async function purgeOnce(dataRoot: string = config.dataRoot): Promise<{ sessions: number; tenants: number }> {
  const cutoff = new Date(Date.now() - TRASH_TTL_DAYS * 86_400_000).toISOString();
  const db = new Database(path.join(dataRoot, "gateway.db"));
  let purgedSessions = 0;
  let purgedTenants = 0;
  try {
    // 1. 过期已删会话
    const sessions = db
      .query(
        "SELECT id, user_id, session_file, workspace_id, deleted_at FROM sessions WHERE status='deleted' AND deleted_at IS NOT NULL AND deleted_at < ?",
      )
      .all(cutoff) as Array<{
      id: string;
      user_id: string;
      session_file: string | null;
      workspace_id: string;
      deleted_at: string;
    }>;
    for (const row of sessions) {
      if (row.session_file) {
        // DB 存相对路径（§32 INV-1）；旧库绝对路径原样透传
        const abs = path.isAbsolute(row.session_file)
          ? row.session_file
          : path.join(dataRoot, ...row.session_file.split("/"));
        await fs.rm(abs, { force: true }).catch(() => {});
      }
      await fs
        .rm(path.join(dataRoot, "users", row.user_id, "workspaces", row.workspace_id), { recursive: true, force: true })
        .catch(() => {});
      await fs
        .rm(path.join(dataRoot, "users", row.user_id, "snapshots", row.id), { recursive: true, force: true })
        .catch(() => {});
      db.run("DELETE FROM snapshots WHERE session_id = ?", [row.id]);
      db.run("DELETE FROM usage WHERE session_id = ?", [row.id]);
      db.run("DELETE FROM sessions WHERE id = ?", [row.id]);
      purgedSessions++;
    }

    // 2. 过期已删租户（整用户目录）
    const tenants = db
      .query("SELECT user_id FROM tenants WHERE status='deleted' AND updated_at IS NOT NULL AND updated_at < ?")
      .all(cutoff) as Array<{ user_id: string }>;
    for (const t of tenants) {
      await fs.rm(path.join(dataRoot, "users", t.user_id), { recursive: true, force: true }).catch(() => {});
      db.run("DELETE FROM snapshots WHERE session_id IN (SELECT id FROM sessions WHERE user_id = ?)", [t.user_id]);
      db.run("DELETE FROM usage WHERE user_id = ?", [t.user_id]);
      db.run("DELETE FROM sessions WHERE user_id = ?", [t.user_id]);
      db.run("DELETE FROM workspaces WHERE user_id = ?", [t.user_id]);
      purgedTenants++;
    }
  } finally {
    db.close();
  }
  if (purgedSessions || purgedTenants) {
    console.log(`[trash-purger] purged ${purgedSessions} session(s), ${purgedTenants} tenant dir(s)`);
  }
  return { sessions: purgedSessions, tenants: purgedTenants };
}

let timer: ReturnType<typeof setInterval> | undefined;

/** 启动 Purger（10 分钟一次）。 */
export function startTrashPurger(): void {
  timer = setInterval(() => void purgeOnce().catch((err) => console.error("[trash-purger]", err)), 10 * 60_000);
  timer.unref?.();
}

/** 关停。 */
export function stopTrashPurger(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
