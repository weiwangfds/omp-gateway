/**
 * 集成门面的**组合根**（DESIGN §22 / §31）。
 *
 * 能力拆分：
 *  - facade           提示词注入 / bootstrap / status / 事件回放 / 自描述
 *  - webhooks         会话级回调订阅
 *  - hooks            会话级生命周期钩子
 *  - business-events  业务事件注入 + correlation
 *  - http-tools       会话级业务工具（热生效）
 *
 * 共享依赖（live / 安全取值 / 类型过滤 / 错误体）见 `session-integration/shared.ts`。
 */
import type { Hono } from "hono";
import { mountBusinessEventRoutes } from "./session-integration/business-events.ts";
import { mountFacadeRoutes } from "./session-integration/facade.ts";
import { mountSessionHookRoutes } from "./session-integration/hooks.ts";
import { mountSessionHttpToolRoutes } from "./session-integration/http-tools.ts";
import { createIntegrationShared, type IntegrationDeps, type IntegrationEnv } from "./session-integration/shared.ts";
import { mountSessionWebhookRoutes } from "./session-integration/webhooks.ts";

export type { IntegrationDeps };

export function mountIntegrationBridge(app: Hono<IntegrationEnv>, deps: IntegrationDeps): void {
  const shared = createIntegrationShared(deps);
  mountFacadeRoutes(app, shared);
  mountSessionWebhookRoutes(app, shared);
  mountSessionHookRoutes(app, shared);
  mountBusinessEventRoutes(app, shared);
  mountSessionHttpToolRoutes(app, shared);
}
