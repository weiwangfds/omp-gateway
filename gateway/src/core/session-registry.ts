/**
 * 会话进程态注册表门面（Barrel，DESIGN §31）。
 *  - session-ctx.ts  SessionCtx（SSE 订阅者/环形缓冲/turn 元数据/审批）
 *  - registry.ts     全局活跃会话表
 */
export * from "./session/session-ctx.ts";
export * from "./session/registry.ts";
