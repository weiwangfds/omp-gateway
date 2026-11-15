import * as fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.ts";
import { backupToFile } from "../core/tenant-store.ts";

const KEEP = 8;

/**
 * sqlite 定时备份（M10）：VACUUM INTO 一致性快照到 GATEWAY_BACKUP_DIR，
 * 保留最近 KEEP 份。GATEWAY_BACKUP_DIR 未设置时为 no-op。
 */
/** 启动定时备份（返回停表函数）；未配置 backupDir 时返回 no-op。 */
export function startBackupJob(): () => void {
  if (!config.backupDir) return () => {};
  const timer = setInterval(() => {
    void runBackupOnce().catch((err) => console.error("[gateway] backup failed:", err));
  }, Math.max(config.backupIntervalMin, 1) * 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** 执行一次备份并轮换旧文件；返回快照路径（未配置返回 null）。 */
export async function runBackupOnce(): Promise<string | null> {
  if (!config.backupDir) return null;
  await fs.mkdir(config.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(config.backupDir, `gateway-${stamp}.db`);
  await backupToFile(dest);
  // 轮换：按文件名排序删最旧的
  const files = (await fs.readdir(config.backupDir))
    .filter((f) => f.startsWith("gateway-") && f.endsWith(".db"))
    .sort();
  for (const old of files.slice(0, Math.max(0, files.length - KEEP))) {
    await fs.rm(path.join(config.backupDir, old), { force: true });
  }
  return dest;
}
