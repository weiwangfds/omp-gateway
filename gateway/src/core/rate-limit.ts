/**
 * 用户级 RPM 限流（LiteLLM/One-API 对标）：滑动窗口（60s）内 prompt 类请求数。
 * 上限来自 tenants.limits.rpm（缺省不限）；网关重启即清零（内存态，限流无需持久）。
 */
const windows = new Map<string, number[]>();

/** 超限异常；retryAfterSec 供路由写 Retry-After 头。 */
export class RateLimitedError extends Error {
  constructor(public retryAfterSec: number) {
    super(`rate limit exceeded, retry in ${retryAfterSec}s`);
  }
}

/**
 * 记一次 prompt 类请求；超限抛 RateLimitedError。
 * rpm 传 null/0 表示该用户不限流。
 */
export function checkRpm(userId: string, rpm: number | null): void {
  if (!rpm || rpm <= 0) return;
  const now = Date.now();
  const window = (windows.get(userId) ?? []).filter((t) => now - t < 60_000);
  if (window.length >= rpm) {
    const retryAfter = Math.ceil((60_000 - (now - window[0])) / 1000);
    windows.set(userId, window);
    throw new RateLimitedError(Math.max(retryAfter, 1));
  }
  window.push(now);
  windows.set(userId, window);
}

/** 当前滑动窗口内的请求数与最早一条的剩余秒数（配额面板用）。 */
export function rpmWindowState(userId: string): { used: number; windowResetInSec: number } {
  const now = Date.now();
  const window = (windows.get(userId) ?? []).filter((t) => now - t < 60_000);
  windows.set(userId, window);
  return {
    used: window.length,
    windowResetInSec: window.length ? Math.max(Math.ceil((60_000 - (now - window[0])) / 1000), 0) : 0,
  };
}

// ---- 计数器（/metrics：限流与预算拒绝次数，进程内累计） ----

/** 429 RATE_LIMITED 累计次数。 */
export function rateLimitedCount(): number {
  return rateLimitedCounter;
}

let rateLimitedCounter = 0;

export function countRateLimited(): void {
  rateLimitedCounter++;
}

/** 402 BUDGET_EXCEEDED 累计次数（LiteLLM max_budget 对标）。 */
let budgetExceededCounter = 0;

export function budgetExceededCount(): number {
  return budgetExceededCounter;
}

export function countBudgetExceeded(): void {
  budgetExceededCounter++;
}
