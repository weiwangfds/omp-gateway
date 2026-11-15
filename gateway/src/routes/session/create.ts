/**
 * 建会话（DESIGN §7）：租户状态/配额前置检查 → 创建选项校验（系统提示词、contextFiles、
 * additionalDirectories 等越界即拒）→ 幂等包装。模型不可用映射 404 MODEL_NOT_FOUND。
 */
import type { Hono } from "hono";
import path from "node:path";
import { toStorePath, userRoot } from "../../core/paths.ts";
import { ModelNotFoundError, createGatewaySession, modelInfo } from "../../core/session-factory.ts";
import { registry } from "../../core/session-registry.ts";
import { activeSessionCount, audit, getOrCreateTenant, insertSession, tenantLimits } from "../../core/tenant-store.ts";
import { draining } from "../../middleware/auth.ts";
import { jsonError, withIdempotency, type SessionEnv } from "./shared.ts";

/** 建会话：配额检查 + 幂等包装 + 创建选项校验（DESIGN §7）。 */
export function mountSessionCreateRoutes(app: Hono<SessionEnv>): void {
  /** 建会话（DESIGN §7）。幂等：Idempotency-Key 24h 窗口内重放同响应。 */
  app.post("/", async (c) => {
    if (draining.value) return jsonError(c, 503, "DRAINING", "gateway is draining, new sessions rejected");
    const userId = c.get("userId");
    const tenant = getOrCreateTenant(userId);
    if (tenant.status !== "active") return jsonError(c, 403, "TENANT_DISABLED", `tenant status: ${tenant.status}`);

    const limits = tenantLimits(tenant);
    if (activeSessionCount(userId) >= limits.maxSessions) {
      return jsonError(c, 409, "SESSION_LIMIT", `maxSessions=${limits.maxSessions} reached`);
    }

    return withIdempotency(c, userId, "session.create", async () => {
      const body = await c.req.json().catch(() => ({}) as any);
      const model = body?.model
        ? { provider: String(body.model.provider), modelId: String(body.model.modelId) }
        : undefined;
      if (model && limits.allowedProviders && !limits.allowedProviders.includes(model.provider)) {
        return {
          status: 403 as const,
          body: { error: { code: "PROVIDER_NOT_ALLOWED", message: `provider ${model.provider} not in allowlist` } },
        };
      }
      // 创建选项（SDK 面暴露，DESIGN §16）
      const restrictTools = Array.isArray(body?.tools) ? body.tools.map(String) : undefined;
      const thinkingLevel = typeof body?.thinkingLevel === "string" ? body.thinkingLevel : undefined;
      const appendSystemPrompt = typeof body?.appendSystemPrompt === "string" ? body.appendSystemPrompt : undefined;
      // 系统提示词完整替换（DESIGN §26）：危险，限 256KB；与 appendSystemPrompt 互斥（append 优先）
      const sysPromptRaw = typeof body?.systemPrompt === "string" ? body.systemPrompt : undefined;
      if (sysPromptRaw && sysPromptRaw.length > 256 * 1024) {
        return {
          status: 413 as const,
          body: { error: { code: "PAYLOAD_TOO_LARGE", message: "systemPrompt exceeds 256KB" } },
        };
      }
      const systemPrompt = sysPromptRaw && !appendSystemPrompt ? sysPromptRaw : undefined;
      const enableMcp = body?.enableMcp === false ? false : undefined;
      const enableLsp = body?.enableLsp === false ? false : undefined;
      // additionalDirectories：仅允许用户数据根内的路径（DESIGN §10）
      const userRootResolved = userRoot(userId);
      let additionalDirectories: string[] | undefined;
      if (Array.isArray(body?.additionalDirectories)) {
        additionalDirectories = [];
        for (const d of body.additionalDirectories) {
          const resolved = path.resolve(userRootResolved, String(d));
          if (!resolved.startsWith(userRootResolved + path.sep)) {
            return {
              status: 400 as const,
              body: { error: { code: "PATH_FORBIDDEN", message: `additionalDirectories escape user root: ${d}` } },
            };
          }
          additionalDirectories.push(resolved);
        }
      }
      // 上下文文件注入（DESIGN §22）：集成端用来注入"项目说明/业务规则"到系统提示词。
      // 内容只进提示词不落盘；限单文件 256KB、合计 1MB，最多 20 个。
      let contextFiles: Array<{ path: string; content: string }> | undefined;
      if (body?.contextFiles !== undefined) {
        if (!Array.isArray(body.contextFiles)) {
          return {
            status: 400 as const,
            body: { error: { code: "BAD_REQUEST", message: "contextFiles must be an array of {path, content}" } },
          };
        }
        if (body.contextFiles.length > 20) {
          return {
            status: 400 as const,
            body: { error: { code: "BAD_REQUEST", message: "contextFiles: max 20 entries" } },
          };
        }
        contextFiles = [];
        let total = 0;
        for (const f of body.contextFiles) {
          const p = typeof f?.path === "string" ? f.path.slice(0, 512) : "";
          const content = typeof f?.content === "string" ? f.content : "";
          if (!p || !content) {
            return {
              status: 400 as const,
              body: { error: { code: "BAD_REQUEST", message: "contextFiles entries need path and content strings" } },
            };
          }
          if (content.length > 256 * 1024) {
            return {
              status: 413 as const,
              body: { error: { code: "PAYLOAD_TOO_LARGE", message: `contextFiles entry exceeds 256KB: ${p}` } },
            };
          }
          total += content.length;
          contextFiles.push({ path: p, content });
        }
        if (total > 1024 * 1024) {
          return {
            status: 413 as const,
            body: { error: { code: "PAYLOAD_TOO_LARGE", message: "contextFiles total exceeds 1MB" } },
          };
        }
      }
      const noContextFiles = body?.noContextFiles === true ? true : undefined;

      const sid = crypto.randomUUID();

      let created: Awaited<ReturnType<typeof createGatewaySession>>;
      try {
        created = await createGatewaySession({
          userId,
          sid,
          model,
          ...(restrictTools ? { restrictTools } : {}),
          ...(thinkingLevel ? { thinkingLevel } : {}),
          ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
          ...(systemPrompt ? { systemPrompt } : {}),
          ...(enableMcp !== undefined ? { enableMcp } : {}),
          ...(enableLsp !== undefined ? { enableLsp } : {}),
          ...(additionalDirectories ? { additionalDirectories } : {}),
          ...(contextFiles ? { contextFiles } : {}),
          ...(noContextFiles ? { noContextFiles } : {}),
        });
      } catch (err) {
        if (err instanceof ModelNotFoundError)
          return { status: 404 as const, body: { error: { code: "MODEL_NOT_FOUND", message: err.message } } };
        throw err;
      }

      const { ctx, session, modelFallbackMessage } = created;
      registry.register(ctx);

      const mi = modelInfo((session as unknown as { model?: unknown }).model) ?? model ?? null;
      insertSession({
        id: sid,
        user_id: userId,
        workspace_id: sid, // 会话:workspace = 1:1（DESIGN §3）
        title: body?.title ? String(body.title) : "",
        session_file: session.sessionFile ? toStorePath(session.sessionFile) : null,
        model_provider: mi?.provider ?? null,
        model_id: mi?.modelId ?? null,
      });
      audit("session.create", "session", sid, userId);

      return {
        status: 201 as const,
        body: {
          id: sid,
          workspaceId: sid,
          status: "active",
          model: mi,
          warnings: modelFallbackMessage ? [modelFallbackMessage] : [],
        },
      };
    });
  });
}
