/**
 * 集成端钩子引擎门面（Barrel，DESIGN §23 / §31）。
 *
 *  - events.ts    21 个事件清单（14 decide + 7 notify）
 *  - bridge.ts    globalThis 跨模块实例桥（扩展 ↔ 网关）
 *  - types.ts     回答/合并结果形状
 *  - dispatch.ts  订阅缓存 → 匹配 → 并行 POST → 官方合并语义
 */
export * from "./hooks/events.ts";
export * from "./hooks/bridge.ts";
export * from "./hooks/types.ts";
export { invalidateHookEngineCache } from "./hooks/cache.ts";
export * from "./hooks/dispatch.ts";
