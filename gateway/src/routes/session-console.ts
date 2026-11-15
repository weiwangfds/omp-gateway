/**
 * 网页控制台数据面的**组合根**（DESIGN §21 / §31）。
 *
 * - panels.ts   只读面板：命令菜单 / todos / context / modes / session-tree / context-files / plan / maintenance
 * - actions.ts  写端点：细粒度中断 / 队列清空 / 自动标题
 *
 * 共享依赖（live Façade + SDK 宽松视图）见 `console/shared.ts`。
 */
import type { Hono } from "hono";
import { mountConsoleActionRoutes } from "./console/actions.ts";
import { mountConsolePanelRoutes } from "./console/panels.ts";
import { createConsoleShared, type ConsoleBridgeDeps, type ConsoleEnv } from "./console/shared.ts";

export type { ConsoleBridgeDeps };

export function mountConsoleBridge(app: Hono<ConsoleEnv>, deps: ConsoleBridgeDeps): void {
  const shared = createConsoleShared(deps);
  mountConsolePanelRoutes(app, shared);
  mountConsoleActionRoutes(app, shared);
}
