/**
 * WrenAI 挂接的公开面（Facade，DESIGN §40）：聚合 env / registry / models /
 * introspect / project / daemon / mcp / skill / operation-queue / service / sync 的导出。
 * 历史 import 路径 `core/wren.ts` 经兼容层 re-export 到这里，签名保持不变。
 */
export * from "./env.ts";
export * from "./registry.ts";
export * from "./models.ts";
export * from "./introspect/index.ts";
export * from "./project.ts";
export * from "./daemon.ts";
export * from "./mcp.ts";
export * from "./skill.ts";
export * from "./operation-queue.ts";
export * from "./service.ts";
export * from "./sync.ts";
