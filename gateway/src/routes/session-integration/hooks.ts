/** 会话级生命周期钩子 CRUD（语义与合并规则见 core/hooks）。 */
import type { Hono } from "hono";
import type { IntegrationEnv, IntegrationShared } from "./shared.ts";
import { DECIDE_EVENT_SET, HOOK_EVENTS, invalidateHookEngineCache } from "../../core/hook-engine.ts";
import { generateSecret } from "../../core/signature.ts";
import { audit, createIntegrationHook, deleteIntegrationHook, listIntegrationHooks } from "../../core/tenant-store.ts";
import { isWebhookUrlAllowed } from "../../core/webhooks.ts";

/** 会话级生命周期钩子 CRUD（语义见 core/hooks）。 */
export function mountSessionHookRoutes(app: Hono<IntegrationEnv>, shared: IntegrationShared): void {
  const { jsonError, ownedSession } = shared;

  // ---- 集成端钩子（DESIGN §23）：会话级 CRUD。生命周期 HTTP 回调，语义见 core/hook-engine.ts ----
  app.get("/:sid/hooks", async (c) => {
    const row = ownedSession(c.req.param("sid"), c.get("userId"));
    if (!row) return jsonError(c, 404, "NOT_FOUND", "session not found");
    return c.json({
      hooks: listIntegrationHooks(c.get("userId"), { sessionId: row.id }),
      events: HOOK_EVENTS,
      decideEvents: [...DECIDE_EVENT_SET],
      note: "decide 事件同步等待集成端响应；notify 异步投递。合并语义：首/末获胜、累积、链式（对齐 omp hooks）",
    });
  });

  app.post("/:sid/hooks", async (c) => {
    const row = ownedSession(c.req.param("sid"), c.get("userId"));
    if (!row) return jsonError(c, 404, "NOT_FOUND", "session not found");
    const body = await c.req.json().catch(() => null as any);
    const event = String(body?.event ?? "");
    if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
      return jsonError(c, 400, "BAD_REQUEST", `body.event must be one of ${HOOK_EVENTS.join("|")}`);
    }
    const url = String(body?.url ?? "");
    if (!/^https?:\/\//.test(url)) return jsonError(c, 400, "BAD_REQUEST", "body.url (http/https) required");
    if (!isWebhookUrlAllowed(url)) {
      return jsonError(c, 403, "FORBIDDEN", "hook host not in allowlist (GATEWAY_WEBHOOK_HOSTS_ALLOWLIST)");
    }
    const mode = body?.mode === "decide" ? "decide" : "notify";
    if (mode === "decide" && !DECIDE_EVENT_SET.has(event)) {
      return jsonError(
        c,
        400,
        "BAD_REQUEST",
        `event ${event} is notification-only; mode=decide supports ${[...DECIDE_EVENT_SET].join("|")}`,
      );
    }
    const timeoutMs = Math.min(Math.max(Number(body?.timeoutMs ?? 3000), 100), 60_000);
    const onTimeout = body?.onTimeout === "deny" ? "deny" : "allow";
    const secret = typeof body?.secret === "string" && body.secret.length >= 8 ? body.secret : generateSecret();
    const id = crypto.randomUUID();
    createIntegrationHook({
      id,
      user_id: c.get("userId"),
      session_id: row.id,
      event,
      matcher: body?.matcher,
      url,
      secret,
      mode,
      timeout_ms: timeoutMs,
      on_timeout: onTimeout,
    });
    invalidateHookEngineCache(c.get("userId"));
    audit("hook.create", "session", row.id, c.get("userId"), { event, mode, url });
    return c.json(
      { id, sessionId: row.id, event, url, mode, timeoutMs, onTimeout, matcher: body?.matcher ?? null, secret },
      201,
    );
  });

  app.delete("/:sid/hooks/:id", async (c) => {
    const row = ownedSession(c.req.param("sid"), c.get("userId"));
    if (!row) return jsonError(c, 404, "NOT_FOUND", "session not found");
    const ok = deleteIntegrationHook(c.req.param("id"), c.get("userId"), row.id);
    if (ok) invalidateHookEngineCache(c.get("userId"));
    return ok ? c.json({ ok: true }) : jsonError(c, 404, "NOT_FOUND", "hook not found");
  });
}
