/**
 * SDK 全能力桥的**组合根**（DESIGN §15 / §31）。
 *
 * 把 AgentSession 的编程面按能力拆到 `routes/session-sdk/*`：
 *  - state        状态快照 / 消息 / 运行时工具 / 思考档位 / stats / dump
 *  - control      compact / follow-up / custom message / reset / handoff / cycle / queue / name
 *  - history      entries + labels / snapshots / export
 *  - agents       Agent Hub（definitions/roster/transcript/chat/kill/revive）
 *  - approvals    审批清单 + 决定
 *  - jobs         异步任务 + 孤儿 turn 恢复
 *  - capabilities skills / MCP / LSP / tools info
 *  - lifecycle    fork / branch / fresh
 *
 * 共享依赖（live / modelOf / jsonError / withTurnSlot / parseImages）集中在
 * `session-sdk/shared.ts`，各模块不重复构造会话访问门面。
 */
import type { Hono } from "hono";
import { mountAgentRoutes } from "./session-sdk/agents.ts";
import { mountApprovalRoutes } from "./session-sdk/approvals.ts";
import { mountCapabilityRoutes } from "./session-sdk/capabilities.ts";
import { mountControlRoutes } from "./session-sdk/control.ts";
import { mountHistoryRoutes } from "./session-sdk/history.ts";
import { mountJobRoutes } from "./session-sdk/jobs.ts";
import { mountLifecycleRoutes } from "./session-sdk/lifecycle.ts";
import { createSdkShared, type SdkBridgeDeps, type SdkEnv } from "./session-sdk/shared.ts";
import { mountStateRoutes } from "./session-sdk/state.ts";

export type { SdkBridgeDeps };

export function mountSdkBridge(app: Hono<SdkEnv>, deps: SdkBridgeDeps): void {
  const shared = createSdkShared(deps);
  mountStateRoutes(app, shared);
  mountControlRoutes(app, shared);
  mountHistoryRoutes(app, shared);
  mountAgentRoutes(app, shared);
  mountApprovalRoutes(app, shared);
  mountJobRoutes(app, shared);
  mountCapabilityRoutes(app, shared);
  mountLifecycleRoutes(app, shared);
}
