/** 集成端钩子（用户级，跨全部会话）：注册/清单/注销；会话级在 /:sid/hooks。 */
import { Hono } from "hono";
import { DECIDE_EVENT_SET, HOOK_EVENTS, invalidateHookEngineCache } from "../../core/hook-engine.ts";
import { generateSecret } from "../../core/signature.ts";
import { audit, createIntegrationHook, deleteIntegrationHook, listIntegrationHooks } from "../../core/tenant-store.ts";
import { isWebhookUrlAllowed } from "../../core/webhooks.ts";
import type { ConfigEnv } from "./env.ts";

const app = new Hono<ConfigEnv>();

/** 集成端钩子（DESIGN §23）：**用户级**（跨会话，对所有会话生效）；会话级见 /:sid/hooks。 */
app.get("/me/hooks", async (c) => {
  const uid = c.get("userId");
  return c.json({
    hooks: listIntegrationHooks(uid),
    events: HOOK_EVENTS,
    decideEvents: [...DECIDE_EVENT_SET],
    note: "sessionId=null 为用户级（所有会话）；会话级见 /api/sessions/:sid/hooks",
  });
});

app.post("/me/hooks", async (c) => {
  const uid = c.get("userId");
  const body = await c.req.json().catch(() => null as any);
  const event = String(body?.event ?? "");
  if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
    return c.json(
      { error: { code: "BAD_REQUEST", message: `body.event must be one of ${HOOK_EVENTS.join("|")}` } },
      400,
    );
  }
  const url = String(body?.url ?? "");
  if (!/^https?:\/\//.test(url))
    return c.json({ error: { code: "BAD_REQUEST", message: "body.url (http/https) required" } }, 400);
  if (!isWebhookUrlAllowed(url)) {
    return c.json(
      { error: { code: "FORBIDDEN", message: "hook host not in allowlist (GATEWAY_WEBHOOK_HOSTS_ALLOWLIST)" } },
      403,
    );
  }
  const mode = body?.mode === "decide" ? "decide" : "notify";
  if (mode === "decide" && !DECIDE_EVENT_SET.has(event)) {
    return c.json(
      {
        error: {
          code: "BAD_REQUEST",
          message: `event ${event} is notification-only; mode=decide supports ${[...DECIDE_EVENT_SET].join("|")}`,
        },
      },
      400,
    );
  }
  const secret = typeof body?.secret === "string" && body.secret.length >= 8 ? body.secret : generateSecret();
  const id = crypto.randomUUID();
  createIntegrationHook({
    id,
    user_id: uid,
    session_id: null,
    event,
    matcher: body?.matcher,
    url,
    secret,
    mode,
    timeout_ms: Math.min(Math.max(Number(body?.timeoutMs ?? 3000), 100), 60_000),
    on_timeout: body?.onTimeout === "deny" ? "deny" : "allow",
  });
  invalidateHookEngineCache(uid);
  audit("hook.create", "user", uid, uid, { event, mode, url, scope: "user" });
  return c.json({ id, sessionId: null, event, url, mode, secret }, 201);
});

app.delete("/me/hooks/:id", async (c) => {
  const uid = c.get("userId");
  const ok = deleteIntegrationHook(c.req.param("id"), uid);
  if (ok) invalidateHookEngineCache(uid);
  return ok ? c.json({ ok: true }) : c.json({ error: { code: "NOT_FOUND", message: "hook not found" } }, 404);
});

export { app as hooksApp };
