/** 全局活跃会话表（仅 active；归档/回收即注销）。 */
import type { SessionCtx } from "./session-ctx.ts";

/**
 * sid → SessionCtx 的进程内注册表。
 * 仅跟踪 live 会话：归档/删除/IdleCuller 回收时必须 unregister，否则复活与统计都会错。
 */
export class SessionRegistry {
  private map = new Map<string, SessionCtx>();

  /** 注册（创建/复活/快照 fork 后换绑时）。 */
  register(ctx: SessionCtx): void {
    this.map.set(ctx.sid, ctx);
  }

  /** 注销（归档/删除/回收/换绑旧 sid）。 */
  unregister(sid: string): void {
    this.map.delete(sid);
  }

  get(sid: string): SessionCtx | undefined {
    return this.map.get(sid);
  }

  /** 遍历全部 live 会话（HTTP 工具热应用、关停 dispose 用）。 */
  values(): IterableIterator<SessionCtx> {
    return this.map.values();
  }

  /** 该用户当前 live 会话数（/internal/summary 与并发观测用）。 */
  countForUser(userId: string): number {
    let n = 0;
    for (const ctx of this.map.values()) if (ctx.userId === userId) n++;
    return n;
  }

  /** 全局正在流式的会话数（/metrics）。 */
  streamingCount(): number {
    let n = 0;
    for (const ctx of this.map.values()) if (ctx.streaming) n++;
    return n;
  }
}

export const registry = new SessionRegistry();
