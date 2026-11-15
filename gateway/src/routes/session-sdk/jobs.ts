/** SDK 桥·异步任务：bash 后台 / task 子代理的 job 树、单查、取消。 */
import type { Hono } from "hono";
import type { SdkEnv, SdkShared } from "./shared.ts";
import { registry } from "../../core/session-registry.ts";

/** 异步任务：job 树/快照/单查/取消。 */
export function mountJobRoutes(app: Hono<SdkEnv>, shared: SdkShared): void {
  const { jsonError, ownedSession } = shared;

  // ---- 异步任务（bash 后台/task 子代理；M3 完成 chat/kill 同族）----
  app.get("/:sid/jobs", (c) => {
    const row = ownedSession(c.req.param("sid"), c.get("userId"));
    if (!row) return jsonError(c, 404, "NOT_FOUND", "session not found");
    const ctx = registry.get(row.id);
    if (!ctx) return c.json({ tree: null, snapshot: null, live: false });
    const s = ctx.session as unknown as {
      getAsyncJobTree?: (o?: { recentLimit?: number }) => unknown;
      getAsyncJobSnapshot?: (o?: { recentLimit?: number }) => unknown;
    };
    return c.json({
      tree: s.getAsyncJobTree?.({ recentLimit: 20 }) ?? null,
      snapshot: s.getAsyncJobSnapshot?.({ recentLimit: 20 }) ?? null,
      live: true,
    });
  });

  app.get("/:sid/jobs/:jobId", (c) => {
    const row = ownedSession(c.req.param("sid"), c.get("userId"));
    if (!row) return jsonError(c, 404, "NOT_FOUND", "session not found");
    const ctx = registry.get(row.id);
    const inspection = (
      ctx?.session as unknown as { inspectAsyncJob?: (id: string) => unknown } | undefined
    )?.inspectAsyncJob?.(c.req.param("jobId"));
    return inspection ? c.json(inspection) : jsonError(c, 404, "NOT_FOUND", "job not found");
  });

  app.post("/:sid/jobs/:jobId/cancel", (c) => {
    const row = ownedSession(c.req.param("sid"), c.get("userId"));
    if (!row) return jsonError(c, 404, "NOT_FOUND", "session not found");
    const ctx = registry.get(row.id);
    const cancelled = (
      ctx?.session as unknown as { cancelAsyncJob?: (id: string) => boolean } | undefined
    )?.cancelAsyncJob?.(c.req.param("jobId"));
    return c.json({ cancelled: Boolean(cancelled) });
  });
}
