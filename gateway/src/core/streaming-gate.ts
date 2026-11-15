import { config } from "../config.ts";

/**
 * 流式并发闸门（DESIGN §8，M2）：
 * - 全局 streaming 槽位上限（防单点 OOM）
 * - 每用户 streaming 槽位上限（tenants.maxConcurrent，provider 注入避免循环依赖）
 * - 超限 **FIFO 排队**而非拒绝；排队超时 → StreamQueueTimeout（上游 429 退避重试）
 *
 * 槽位语义 = 一个"正在流式的会话"。prompt/steer 在 idle 会话上开启新 turn 前持槽，
 * 终态 agent_end / 会话 dispose / 最大持有时长（防泄漏 backstop）三者任一触发释放。
 */
/** 排队超时（acquire 在 timeoutMs 内未等到槽位），路由映射为 429 + Retry-After。 */
export class StreamQueueTimeout extends Error {
  constructor(public timeoutMs: number) {
    super(`stream queue timeout after ${timeoutMs}ms`);
  }
}

interface Waiter {
  userId: string;
  admit: () => void;
  fail: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * 流式槽位闸门实例：全局与每用户双上限，FIFO 排队，由 sessions 组合根创建并注入用户限额来源。
 */
export class StreamingGate {
  private held = 0;
  private perUser = new Map<string, number>();
  private waiters: Waiter[] = [];
  private userLimitProvider: (userId: string) => number = () => Number.MAX_SAFE_INTEGER;

  constructor(private readonly maxGlobal: number) {}

  /** 注入每用户上限来源（tenants.maxConcurrent）；函数形式避免 store ↔ gate 循环依赖。 */
  setUserLimitProvider(fn: (userId: string) => number): void {
    this.userLimitProvider = fn;
  }

  /** 获得一个流式槽位；返回 release 函数（幂等）。超时抛 StreamQueueTimeout。 */
  async acquire(userId: string, timeoutMs: number): Promise<() => void> {
    if (this.tryAdmit(userId)) return this.makeRelease(userId);
    return new Promise<() => void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.timer === timer);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new StreamQueueTimeout(timeoutMs));
      }, timeoutMs);
      timer.unref?.();
      this.waiters.push({
        userId,
        admit: () => resolve(this.makeRelease(userId)),
        fail: reject,
        timer,
      });
    });
  }

  /** 当前持有/排队数（/metrics 与 429 details 用）。 */
  stats(): { held: number; waiting: number } {
    return { held: this.held, waiting: this.waiters.length };
  }

  private tryAdmit(userId: string): boolean {
    if (this.held >= this.maxGlobal) return false;
    if ((this.perUser.get(userId) ?? 0) >= this.userLimitProvider(userId)) return false;
    this.held++;
    this.perUser.set(userId, (this.perUser.get(userId) ?? 0) + 1);
    return true;
  }

  private releaseFor(userId: string): void {
    this.held = Math.max(0, this.held - 1);
    const n = (this.perUser.get(userId) ?? 1) - 1;
    if (n <= 0) this.perUser.delete(userId);
    else this.perUser.set(userId, n);
    this.wake();
  }

  private makeRelease(userId: string): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.releaseFor(userId);
    };
  }

  /** 唤醒排队者：不拘泥严格队头——在能同时满足双上限的等待者中按 FIFO 取第一个，防队头饿死。 */
  private wake(): void {
    let admitted = true;
    while (admitted && this.waiters.length) {
      admitted = false;
      for (let i = 0; i < this.waiters.length; i++) {
        if (this.tryAdmit(this.waiters[i].userId)) {
          const [w] = this.waiters.splice(i, 1);
          w.admit();
          admitted = true;
          break;
        }
      }
    }
  }
}

export const streamingGate = new StreamingGate(config.maxGlobalStreaming);
