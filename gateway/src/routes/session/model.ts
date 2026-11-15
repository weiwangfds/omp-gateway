/**
 * 模型面：会话内切模型（仅 idle；per-tenant allowlist；切前自动快照）与
 * 模型选择器数据面（目录 + 当前模型 + 思考档位）。
 */
import type { Hono } from "hono";
import { registry } from "../../core/session-registry.ts";
import { createSnapshot } from "../../core/snapshot-service.ts";
import { audit, getOrCreateTenant, tenantLimits, touchSession } from "../../core/tenant-store.ts";
import { getUserContext } from "../../core/user-context.ts";
import { jsonError, ownedSession, requireLive, type SessionEnv } from "./shared.ts";

/** 模型面：会话内切模型（idle 限定 + allowlist）与模型选择器数据面。 */
export function mountModelRoutes(app: Hono<SessionEnv>): void {
  /** 会话内切换模型（DESIGN §3：仅 idle；收 Model 对象，先经用户 registry 解析）。 */
  app.post("/:sid/model", async (c) => {
    const r = await requireLive(c);
    if ("error" in r) return r.error;
    if (r.ctx.streaming) return jsonError(c, 409, "SESSION_STREAMING", "model switch allowed only when idle");

    const userId = c.get("userId");
    const limits = tenantLimits(getOrCreateTenant(userId));
    const body = await c.req.json().catch(() => ({}) as any);
    const provider = String(body?.provider ?? "");
    const modelId = String(body?.modelId ?? "");
    if (limits.allowedProviders && !limits.allowedProviders.includes(provider)) {
      return jsonError(c, 403, "PROVIDER_NOT_ALLOWED", `provider ${provider} not in allowlist`);
    }

    const uctx = await getUserContext(userId);
    const model = uctx.resolveModel(provider, modelId);
    if (!model) return jsonError(c, 404, "MODEL_NOT_FOUND", `Model not found: ${provider}/${modelId}`);

    // 切模型前自动快照（M4 pre_model_switch；失败不阻断切换）
    try {
      await createSnapshot(userId, r.row.id, { kind: "auto", trigger: "pre_model_switch", turn: null });
    } catch {}

    // role 可选（SDK setModel(model, role)）：角色回退链随之切换
    const role = typeof body?.role === "string" ? body.role : undefined;
    r.ctx.session.setModel(model, role);
    touchSession(r.row.id, { model_provider: provider, model_id: modelId });
    audit("session.set_model", "session", r.row.id, userId, { provider, modelId });
    return c.json({ model: { provider, modelId } });
  });

  /** 模型选择器数据面（DESIGN §21）：用户可见模型目录 + 会话当前模型 + 思考档位。 */
  app.get("/:sid/models", async (c) => {
    const row = ownedSession(c.req.param("sid"), c.get("userId"));
    if (!row) return jsonError(c, 404, "NOT_FOUND", "session not found");
    const uctx = await getUserContext(c.get("userId"));
    const models = uctx.modelRegistry
      .getAvailable()
      .map((m) => {
        const mm = m as unknown as Record<string, any>;
        return {
          provider: mm.provider ?? "",
          modelId: m.id,
          name: mm.name ?? m.id,
          contextWindow: mm.contextWindow ?? null,
          maxTokens: mm.maxTokens ?? null,
          cost: mm.cost ?? null,
          supportsTools: mm.supportsTools ?? null,
          supportsVision: mm.supportsVision ?? null,
          supportsReasoning: mm.supportsReasoning ?? null,
        };
      })
      .filter((m) => m.provider);
    // live 会话附加当前模型与思考档位（网页下拉框直接可用；非 live 返回 null）
    const ctx = registry.get(row.id);
    if (!ctx) {
      return c.json({
        models,
        current: row.model_provider && row.model_id ? { provider: row.model_provider, modelId: row.model_id } : null,
        thinkingLevels: [],
        effortSelectors: [],
        live: false,
      });
    }
    const session = ctx.session as unknown as Record<string, any>;
    const m = session.model as { provider?: string; id?: string } | undefined;
    return c.json({
      models,
      current: m?.provider && m?.id ? { provider: m.provider, modelId: m.id } : null,
      thinkingLevels: session.getAvailableThinkingLevels?.() ?? [],
      effortSelectors: session.getAvailableEffortSelectors?.() ?? [],
      thinkingLevel: session.thinkingLevel ?? null,
      live: true,
    });
  });
}
