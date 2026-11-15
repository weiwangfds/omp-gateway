import { runSnapshotPruner } from "../core/snapshot-service.ts";
import { config } from "../config.ts";

/** SnapshotPruner（M4）：auto ring 滚动（K=20）+ manual TTL 90d + 孤儿快照文件清理。 */
let timer: ReturnType<typeof setInterval> | undefined;

/** 启动 Pruner（10 分钟一次）。 */
export function startSnapshotPruner(): void {
  timer = setInterval(
    () => void runSnapshotPruner(config.dataRoot).catch((err) => console.error("[snapshot-pruner]", err)),
    10 * 60_000,
  );
  timer.unref?.();
}

/** 关停。 */
export function stopSnapshotPruner(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
