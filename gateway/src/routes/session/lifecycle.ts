/** 会话生命周期路由（组合根）：create（建会话/幂等）与 crud（列表/检索/详情/归档/删除）。 */
import type { Hono } from "hono";
import { mountSessionCreateRoutes } from "./create.ts";
import { mountSessionCrudRoutes } from "./crud.ts";
import type { SessionEnv } from "./shared.ts";

export function mountLifecycleRoutes(app: Hono<SessionEnv>): void {
  mountSessionCreateRoutes(app);
  mountSessionCrudRoutes(app);
}
