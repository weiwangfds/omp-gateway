/**
 * 兼容层（strangler，DESIGN §40）：WrenAI 挂接已拆分到 ./wren/；新代码请直接用 ./wren。
 * 本文件仅为历史 import 路径（src/index.ts、routes/admin-wren.ts、单测）保留。
 */
export * from "./wren/index.ts";
