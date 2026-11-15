/**
 * 会话路由的**组合根**（DESIGN §31）。
 *
 * 本文件只保留三类内容：
 *  1. 分享令牌守卫（Hono 参数化中间件，必须先于所有 /:sid 路由注册）
 *  2. 领域子路由 mount（lifecycle / conversation / model / sharing / events）
 *  3. 其余会话子桥 mount（workspace / SDK / console / integration / import）
 *
 * 守卫与编排（归属、复活、流式槽位、配额、幂等）集中在 `session/shared.ts`，
 * 子路由模块不各自实现，避免新增端点漏掉租户边界。
 */
import { Hono } from "hono";
import { mountConsoleBridge } from "./session-console.ts";
import { mountIntegrationBridge } from "./session-integration.ts";
import { mountSessionImport } from "./session-import.ts";
import { mountSdkBridge } from "./session-sdk.ts";
import { mountConversationRoutes } from "./session/conversation.ts";
import { mountSessionEventsRoutes } from "./session/events.ts";
import { mountLifecycleRoutes } from "./session/lifecycle.ts";
import { mountModelRoutes } from "./session/model.ts";
import { mountSharingRoutes } from "./session/sharing.ts";
import {
  enforceTurnPolicy,
  getOrRevive,
  jsonError,
  ownedSession,
  withTurnSlot,
  type SessionEnv,
} from "./session/shared.ts";
import { mountWorkspaceRoutes } from "./workspace.ts";

export type Env = SessionEnv;

export const sessionsApp = new Hono<Env>();

// 分享令牌守卫（collab"链接即权限"语义，DESIGN §16）。
// Hono 限制：参数化 use 需按路径模式注册——/:sid 与 /:sid/* 各挂一次；无 sid 的路径（列表等）直接拒绝。
const shareGuard = async (c: any, next: () => Promise<void>) => {
  const access = c.get("shareAccess");
  if (!access) return next();
  const sid = c.req.param("sid");
  if (!sid) return jsonError(c, 403, "SHARE_SESSION_SCOPED", "share tokens are session-scoped");
  if (sid !== c.get("shareSid")) return jsonError(c, 404, "NOT_FOUND", "session not found");
  const method = c.req.method.toUpperCase();
  if (method === "GET" || method === "HEAD") return next();
  if (access === "view") return jsonError(c, 403, "SHARE_VIEW_ONLY", "view token is read-only");
  const p = new URL(c.req.url).pathname;
  const writable = [/\/prompt$/, /\/steer$/, /\/abort$/, /\/follow-up$/, /\/messages\/custom$/];
  if (writable.some((re) => re.test(p))) return next();
  return jsonError(c, 403, "SHARE_CONTROL_LIMITED", "control token only allows conversation actions");
};
const shareScopedOnly = async (c: any, next: () => Promise<void>) => {
  if (!c.get("shareAccess")) return next();
  return jsonError(c, 403, "SHARE_SESSION_SCOPED", "share tokens are session-scoped");
};
sessionsApp.use("/", shareScopedOnly); // 会话列表等无 sid 路径：分享令牌拒绝
sessionsApp.use("/:sid", shareGuard);
sessionsApp.use("/:sid/*", shareGuard);

// ---- 会话核心面（按领域拆分，顺序与历史注册顺序一致）----
mountLifecycleRoutes(sessionsApp);
mountConversationRoutes(sessionsApp);
mountModelRoutes(sessionsApp);
mountSharingRoutes(sessionsApp);
mountSessionEventsRoutes(sessionsApp);

// ---- 会话子桥 ----
// workspace 文件管理 + git 基础（DESIGN §15），挂在 /api/sessions/:sid/* 下
mountWorkspaceRoutes(sessionsApp, ownedSession);
// SDK 全能力桥（DESIGN §16）
mountSdkBridge(sessionsApp, { ownedSession, getOrRevive, withTurnSlot, jsonError, enforceTurnPolicy });
// 网页控制台数据面（DESIGN §21：命令面板/模型选择器/todo/上下文/模式/中断等）
mountConsoleBridge(sessionsApp, { ownedSession, getOrRevive, jsonError });
// 集成门面（DESIGN §22/§23/§24：inject/bootstrap/status/hooks/webhooks/business-events/http tools）
mountIntegrationBridge(sessionsApp, { ownedSession, getOrRevive, jsonError, withTurnSlot, enforceTurnPolicy });
// 会话 JSONL 校验/导入（DESIGN §25）
mountSessionImport(sessionsApp, { jsonError });
