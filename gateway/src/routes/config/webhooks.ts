import { Hono } from "hono";
import { generateSecret } from "../../core/signature.ts";
import { audit, createWebhook, deleteWebhook, listWebhooks } from "../../core/tenant-store.ts";
import { invalidateHookCache, isWebhookUrlAllowed } from "../../core/webhooks.ts";
import type { ConfigEnv } from "./env.ts";

const app = new Hono<ConfigEnv>();

/** 回调（DESIGN §22）：用户级 webhook 订阅管理（集成端注册，事件推送 + HMAC 签名）。 */
app.get("/me/webhooks", async (c) => {
  const uid = c.get("userId");
  return c.json({ webhooks: listWebhooks(uid) });
});

app.post("/me/webhooks", async (c) => {
  const uid = c.get("userId");
  const body = await c.req.json().catch(() => null as any);
  const url = String(body?.url ?? "");
  if (!/^https?:\/\//.test(url))
    return c.json({ error: { code: "BAD_REQUEST", message: "body.url (http/https) required" } }, 400);
  if (!isWebhookUrlAllowed(url)) {
    return c.json(
      { error: { code: "FORBIDDEN", message: "webhook host not in allowlist (GATEWAY_WEBHOOK_HOSTS_ALLOWLIST)" } },
      403,
    );
  }
  const events = Array.isArray(body?.events) && body.events.length ? body.events.map(String) : ["*"];
  const secret = typeof body?.secret === "string" && body.secret.length >= 8 ? body.secret : generateSecret();
  const id = crypto.randomUUID();
  createWebhook({ id, user_id: uid, url, secret, events });
  invalidateHookCache(uid);
  audit("webhook.create", "user", uid, uid, { url, events });
  return c.json({ id, url, events, secret }, 201); // secret 仅此一次返回
});

app.delete("/me/webhooks/:id", async (c) => {
  const uid = c.get("userId");
  const ok = deleteWebhook(c.req.param("id"), uid);
  if (ok) invalidateHookCache(uid);
  return ok ? c.json({ ok: true }) : c.json({ error: { code: "NOT_FOUND", message: "webhook not found" } }, 404);
});

export { app as webhooksApp };
