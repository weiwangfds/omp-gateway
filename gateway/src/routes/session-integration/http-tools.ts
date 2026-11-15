/** 会话级 HTTP 工具（同名覆盖用户级；注册/删除后对本会话热应用）。 */
import type { Hono } from "hono";
import type { IntegrationEnv, IntegrationShared } from "./shared.ts";
import { validateHttpToolName } from "../../core/http-tools.ts";
import { registry } from "../../core/session-registry.ts";
import { generateSecret } from "../../core/signature.ts";
import { audit, deleteHttpTool, findHttpToolScoped, listHttpTools, upsertHttpTool } from "../../core/tenant-store.ts";
import { isWebhookUrlAllowed } from "../../core/webhooks.ts";

/** 会话级 HTTP 工具（同名覆盖用户级；变更热应用）。 */
export function mountSessionHttpToolRoutes(app: Hono<IntegrationEnv>, shared: IntegrationShared): void {
  const { jsonError, ownedSession } = shared;

  // ---- 会话级 HTTP 工具（DESIGN §24）：仅本会话可见，同名覆盖用户级 ----
  app.get("/:sid/tools/http", async (c) => {
    const row = ownedSession(c.req.param("sid"), c.get("userId"));
    if (!row) return jsonError(c, 404, "NOT_FOUND", "session not found");
    return c.json({
      tools: listHttpTools(c.get("userId"), false, { sessionId: row.id }),
      userLevel: listHttpTools(c.get("userId")).filter((t) => t.sessionId === null),
    });
  });

  app.put("/:sid/tools/http/:name", async (c) => {
    const row = ownedSession(c.req.param("sid"), c.get("userId"));
    if (!row) return jsonError(c, 404, "NOT_FOUND", "session not found");
    const uid = c.get("userId");
    const name = c.req.param("name");
    const nameErr = await validateHttpToolName(name);
    if (nameErr) return jsonError(c, 400, "INVALID_NAME", nameErr);
    const body = await c.req.json().catch(() => null as any);
    const description = typeof body?.description === "string" ? body.description.trim() : "";
    if (!description) return jsonError(c, 400, "BAD_REQUEST", "body.description required");
    const url = String(body?.url ?? "");
    if (!/^https?:\/\//.test(url)) return jsonError(c, 400, "BAD_REQUEST", "body.url (http/https) required");
    if (!isWebhookUrlAllowed(url))
      return jsonError(c, 403, "FORBIDDEN", "tool host not in allowlist (GATEWAY_WEBHOOK_HOSTS_ALLOWLIST)");
    const parameters = body?.parameters;
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
      return jsonError(c, 400, "BAD_REQUEST", "body.parameters (JSON Schema object) required");
    }
    if (JSON.stringify(parameters).length > 64 * 1024)
      return jsonError(c, 413, "PAYLOAD_TOO_LARGE", "parameters schema exceeds 64KB");
    const existing = findHttpToolScoped(uid, name, row.id);
    const secret =
      typeof body?.secret === "string" && body.secret.length >= 8
        ? body.secret
        : (existing?.secret ?? generateSecret());
    const id = existing?.id ?? crypto.randomUUID();
    upsertHttpTool({
      id,
      user_id: uid,
      session_id: row.id,
      name,
      label: typeof body?.label === "string" && body.label ? body.label : name,
      description,
      parameters,
      url,
      secret,
      timeout_ms: Math.min(Math.max(Number(body?.timeoutMs ?? 30_000), 1_000), 300_000),
      approval: typeof body?.approval === "string" ? body.approval : null,
    });
    audit("session.http_tool.upsert", "session", row.id, uid, { name, url });
    const ctx = registry.get(row.id);
    if (ctx) {
      const { applyHttpToolsToSession } = await import("../../core/http-tools.ts");
      await applyHttpToolsToSession({
        session: ctx.session,
        mcpManager: ctx.mcpManager,
        userId: uid,
        sid: row.id,
      }).catch(() => {});
    }
    return c.json({ ok: true, name, sessionId: row.id, secret: existing ? undefined : secret }, 201);
  });

  app.delete("/:sid/tools/http/:name", async (c) => {
    const row = ownedSession(c.req.param("sid"), c.get("userId"));
    if (!row) return jsonError(c, 404, "NOT_FOUND", "session not found");
    const uid = c.get("userId");
    const ok = deleteHttpTool(uid, c.req.param("name"), row.id);
    if (ok) {
      audit("session.http_tool.delete", "session", row.id, uid, { name: c.req.param("name") });
      const ctx = registry.get(row.id);
      if (ctx) {
        const { applyHttpToolsToSession } = await import("../../core/http-tools.ts");
        await applyHttpToolsToSession({
          session: ctx.session,
          mcpManager: ctx.mcpManager,
          userId: uid,
          sid: row.id,
        }).catch(() => {});
      }
    }
    return ok ? c.json({ ok: true }) : jsonError(c, 404, "NOT_FOUND", "http tool not found");
  });
}
