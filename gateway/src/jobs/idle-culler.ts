import { config } from "../config.ts";
import { registry } from "../core/session-registry.ts";
import { disposeSession } from "../core/session-factory.ts";

/**
 * IdleCuller（JupyterHub idle-culler 模式，DESIGN §4）：
 * idle && 无 SSE 订阅 && 超过 TTL → dispose 进程态（文件保留，下条消息按 sessionFile 复活）。
 */
let timer: ReturnType<typeof setInterval> | undefined;

/** 启动回收循环（60s 一次）；返回的定时器已 unref，不阻碍进程退出。 */
export function startIdleCuller(): void {
  // cull 是 async：disposeSession 抛错若无 catch 即 unhandledRejection（Bun 默认崩进程），
  // 与 snapshot-pruner/trash-purger 的 () => void run().catch(...) 兜底保持一致
  timer = setInterval(() => void cull().catch((err) => console.error("[idle-culler] cull failed:", err)), 60_000);
  timer.unref?.();
}

/** 关停（index.ts shutdown 用）。 */
export function stopIdleCuller(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

async function cull(): Promise<void> {
  const now = Date.now();
  const victims = [...registry.values()].filter(
    (ctx) => !ctx.streaming && ctx.subscribers.size === 0 && now - ctx.lastLiveAt > config.sessionIdleTtlMs,
  );
  for (const ctx of victims) {
    console.log(`[idle-culler] disposing idle session ${ctx.sid} (user ${ctx.userId})`);
    await disposeSession(ctx);
  }
}
