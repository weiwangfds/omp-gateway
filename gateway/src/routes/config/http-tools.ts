/**
 * 集成端 HTTP 工具（用户级）：注册后对该用户所有 live 会话热应用（refreshMCPTools），
 * 新会话创建时自动注入。
 */
import { Hono } from "hono";
import { validateHttpToolName } from "../../core/http-tools.ts";
import { registry } from "../../core/session-registry.ts";
import { generateSecret } from "../../core/signature.ts";
import { audit, deleteHttpTool, findHttpToolScoped, listHttpTools, upsertHttpTool } from "../../core/tenant-store.ts";
import { isWebhookUrlAllowed } from "../../core/webhooks.ts";
import type { ConfigEnv } from "./env.ts";

const app = new Hono<ConfigEnv>();

/** 集成端 HTTP 工具（DESIGN §24）：业务系统把自己的函数暴露给 agent（SDK customTools 的 HTTP 形态）。 */
app.get("/me/tools/http", async (c) => {
  const uid = c.get("userId");
  return c.json({
    tools: listHttpTools(uid),
    note: "sessionId=null 为用户级（所有会话）；非空为会话级（同名覆盖用户级）。变更对 live 会话热生效，新会话自动注入",
  });
});

app.put("/me/tools/http/:name", async (c) => {
  const uid = c.get("userId");
  const name = c.req.param("name");
  const nameErr = await validateHttpToolName(name);
  if (nameErr) return c.json({ error: { code: "INVALID_NAME", message: nameErr } }, 400);
  const body = await c.req.json().catch(() => null as any);
  const description = typeof body?.description === "string" ? body.description.trim() : "";
  if (!description) return c.json({ error: { code: "BAD_REQUEST", message: "body.description required" } }, 400);
  const url = String(body?.url ?? "");
  if (!/^https?:\/\//.test(url))
    return c.json({ error: { code: "BAD_REQUEST", message: "body.url (http/https) required" } }, 400);
  if (!isWebhookUrlAllowed(url)) {
    return c.json(
      { error: { code: "FORBIDDEN", message: "tool host not in allowlist (GATEWAY_WEBHOOK_HOSTS_ALLOWLIST)" } },
      403,
    );
  }
  const parameters = body?.parameters;
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    return c.json({ error: { code: "BAD_REQUEST", message: "body.parameters (JSON Schema object) required" } }, 400);
  }
  if (JSON.stringify(parameters).length > 64 * 1024) {
    return c.json({ error: { code: "PAYLOAD_TOO_LARGE", message: "parameters schema exceeds 64KB" } }, 413);
  }
  const existing = findHttpToolScoped(uid, name, null);
  const secret =
    typeof body?.secret === "string" && body.secret.length >= 8 ? body.secret : (existing?.secret ?? generateSecret());
  const id = existing?.id ?? crypto.randomUUID();
  upsertHttpTool({
    id,
    user_id: uid,
    session_id: null,
    name,
    label: typeof body?.label === "string" && body.label ? body.label : name,
    description,
    parameters,
    url,
    secret,
    timeout_ms: Math.min(Math.max(Number(body?.timeoutMs ?? 30_000), 1_000), 300_000),
    approval: typeof body?.approval === "string" ? body.approval : null,
  });
  audit("me.http_tool.upsert", "tool", name, uid, { url });
  // 热应用到该用户所有 live 会话（新会话在创建时自动注入）
  const applied: string[] = [];
  const { applyHttpToolsToSession } = await import("../../core/http-tools.ts");
  for (const ctx of registry.values()) {
    if (ctx.userId !== uid) continue;
    try {
      await applyHttpToolsToSession({ session: ctx.session, mcpManager: ctx.mcpManager, userId: uid, sid: ctx.sid });
      applied.push(ctx.sid);
    } catch {}
  }
  return c.json({ ok: true, name, appliedTo: applied, secret: existing ? undefined : secret }, 201);
});

app.delete("/me/tools/http/:name", async (c) => {
  const uid = c.get("userId");
  const name = c.req.param("name");
  const ok = deleteHttpTool(uid, name, null);
  if (ok) {
    audit("me.http_tool.delete", "tool", name, uid);
    const { applyHttpToolsToSession } = await import("../../core/http-tools.ts");
    for (const ctx of registry.values()) {
      if (ctx.userId !== uid) continue;
      try {
        await applyHttpToolsToSession({ session: ctx.session, mcpManager: ctx.mcpManager, userId: uid, sid: ctx.sid });
      } catch {}
    }
  }
  return ok ? c.json({ ok: true }) : c.json({ error: { code: "NOT_FOUND", message: "http tool not found" } }, 404);
});

export { app as httpToolsApp };
