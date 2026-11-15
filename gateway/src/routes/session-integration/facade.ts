import type { Hono } from "hono";
import type { IntegrationEnv, IntegrationShared } from "./shared.ts";
import type { GatewayEvent } from "../../core/events.ts";
import { hookSessionOf } from "../../core/hook-engine.ts";
import { audit } from "../../core/tenant-store.ts";

/** 集成门面：inject/bootstrap/status/events/replay/integration 自描述（DESIGN §22）。 */
export function mountFacadeRoutes(app: Hono<IntegrationEnv>, shared: IntegrationShared): void {
  const { live, s, safe, allowType, jsonError, withTurnSlot, enforceTurnPolicy } = shared;

  // ---- 提示词注入（DESIGN §22）：上下文注入（运行期）/ 系统提示词（仅创建期）----
  app.post("/:sid/inject", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    const body = await c.req.json().catch(() => null as any);
    const text = typeof body?.text === "string" ? body.text : "";
    if (!text) return jsonError(c, 400, "BAD_REQUEST", "body.text is required");
    // system 模式：SDK 无运行时 system prompt setter（只有创建期 appendSystemPrompt）——
    // 明确失败而非静默忽略；集成端改用 context 注入或创建新会话。
    if (body?.mode === "system") {
      return jsonError(
        c,
        409,
        "NOT_SUPPORTED",
        "system prompt is fixed for a live session; pass appendSystemPrompt/contextFiles at POST /api/sessions, or use mode=context for runtime injection",
      );
    }
    const mode = body?.mode === "user" ? "user" : "context";
    const deliverAs = body?.deliverAs;
    if (deliverAs !== undefined && !["steer", "followUp", "nextTurn", "aside"].includes(deliverAs)) {
      return jsonError(c, 400, "BAD_REQUEST", "deliverAs must be steer|followUp|nextTurn|aside");
    }
    // 租户策略：只有会开新 turn 的注入才计入 RPM/预算（纯上下文追加不耗模型）
    const willTriggerTurn = mode === "user" || body?.triggerTurn === true;
    const policy = willTriggerTurn ? enforceTurnPolicy(c.get("userId")) : null;
    if (policy) {
      if (policy.retryAfter) c.header("Retry-After", String(policy.retryAfter));
      return c.json(policy.body, policy.status);
    }

    const session = s(r.ctx);
    let triggeredTurn = false;
    let admitted = true;
    try {
      if (mode === "user") {
        admitted = (await withTurnSlot(r.ctx, c.get("userId"), () =>
          session.prompt(text, {
            ...(deliverAs === "followUp" ? { streamingBehavior: "followUp" as const } : {}),
            ...(deliverAs === "steer" ? { streamingBehavior: "steer" as const } : {}),
          }),
        )) as unknown as boolean;
        triggeredTurn = true;
      } else {
        const wantTurn = body?.triggerTurn === true;
        const doInject = () =>
          session.sendCustomMessage(
            { customType: typeof body?.customType === "string" ? body.customType : "gateway.inject", content: text },
            {
              ...(wantTurn ? { triggerTurn: true } : {}),
              ...(deliverAs ? { deliverAs } : {}),
            },
          ) as Promise<boolean>;
        triggeredTurn = wantTurn
          ? Boolean(await withTurnSlot(r.ctx, c.get("userId"), doInject))
          : Boolean(await doInject());
      }
    } catch (err) {
      if ((err as any)?.code === "SESSION_NOT_LIVE")
        return jsonError(c, 409, "SESSION_NOT_LIVE", (err as Error).message);
      return jsonError(c, 409, "INJECT_FAILED", err instanceof Error ? err.message : String(err));
    }

    // 同步等待模式：注入触发了 turn 时最多等 waitTimeoutMs 到终态
    let waited = false;
    let timedOut: boolean | null = null;
    if (body?.wait === true && triggeredTurn) {
      const waitTimeoutMs = Math.min(Math.max(Number(body?.waitTimeoutMs ?? 120_000), 1_000), 600_000);
      waited = true;
      await r.ctx.waitStreamingStart(2_000); // admission → agent_start 窗口
      timedOut = !(await r.ctx.waitTerminal(waitTimeoutMs));
    }
    audit("session.inject", "session", r.row.id, c.get("userId"), { mode, triggeredTurn, waited });

    const model = session.model as { provider?: string; id?: string } | undefined;
    return c.json(
      {
        ok: true,
        mode,
        admitted,
        triggeredTurn,
        ...(waited ? { waited, timedOut } : {}),
        streaming: r.ctx.streaming,
        model: model?.provider && model?.id ? { provider: model.provider, modelId: model.id } : null,
        latestSeq: r.ctx.replayAfter(0).at(-1)?.seq ?? 0,
      },
      202,
    );
  });

  // ---- 状态聚合（DESIGN §22）：集成端初始化一次拿全 ----
  app.get("/:sid/bootstrap", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    const session = s(r.ctx);
    const model = session.model as { provider?: string; id?: string } | undefined;
    return c.json({
      session: {
        id: r.row.id,
        title: r.row.title ?? null,
        status: r.row.status,
        parentId: (r.row as unknown as { parent_id?: string | null }).parent_id ?? null,
        createdAt: (r.row as unknown as { created_at?: string }).created_at ?? null,
        updatedAt: (r.row as unknown as { updated_at?: string }).updated_at ?? null,
      },
      state: {
        streaming: r.ctx.streaming,
        model: model?.provider && model?.id ? { provider: model.provider, modelId: model.id } : null,
        thinkingLevel: session.thinkingLevel ?? null,
        thinkingLevels: safe(() => session.getAvailableThinkingLevels?.()) ?? [],
        queue: safe(() => session.getQueuedMessages?.()) ?? { steering: [], followUp: [], liveSteered: 0 },
        tools: {
          active: safe(() => session.getActiveToolNames?.()) ?? [],
          all: safe(() => session.getAllToolNames?.()) ?? [],
        },
        contextUsage: safe(() => session.getContextUsage?.()),
      },
      modes: {
        plan: safe(() => session.getPlanModeState?.()),
        goal: safe(() => session.getGoalModeState?.()),
        autoCompaction: safe(() => session.autoCompactionEnabled),
        autoRetry: safe(() => session.autoRetryEnabled),
        isCompacting: safe(() => session.isCompacting ?? false),
        isRetrying: safe(() => session.isRetrying ?? false),
        isBashRunning: safe(() => session.isBashRunning ?? false),
        isEvalRunning: safe(() => session.isEvalRunning ?? false),
      },
      approvals: r.ctx.pendingApprovalList(),
      commands: {
        slashCommands: (session.slashCommands ?? []).map((x: any) => ({
          name: x.name,
          description: x.description ?? "",
        })),
        customCommands: (session.customCommands ?? []).map((x: any) => ({
          name: x?.command?.name ?? "",
          description: x?.command?.description ?? "",
        })),
        mcpPrompts: (session.mcpPromptCommands ?? []).map((x: any) => ({
          name: x?.command?.name ?? "",
          description: x?.command?.description ?? "",
        })),
        templates: (session.promptTemplates ?? []).map((x: any) => ({
          name: x.name,
          description: x.description ?? "",
        })),
      },
      events: {
        latestSeq: r.ctx.replayAfter(0).at(-1)?.seq ?? 0,
        sse: `/api/sessions/${r.row.id}/events`,
        replay: `/api/sessions/${r.row.id}/events/replay`,
      },
    });
  });

  // ---- 轻量状态（轮询友好）----
  app.get("/:sid/status", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    const session = s(r.ctx);
    const model = session.model as { provider?: string; id?: string } | undefined;
    const q = safe(() => session.getQueuedMessages?.()) as { steering?: string[]; followUp?: string[] } | null;
    return c.json({
      sessionId: r.row.id,
      status: r.ctx.streaming ? "streaming" : "idle",
      model: model?.provider && model?.id ? { provider: model.provider, modelId: model.id } : null,
      thinkingLevel: session.thinkingLevel ?? null,
      pendingApprovals: r.ctx.pendingApprovalList().length,
      queueCount: (q?.steering?.length ?? 0) + (q?.followUp?.length ?? 0),
      latestSeq: r.ctx.replayAfter(0).at(-1)?.seq ?? 0,
    });
  });

  // ---- 事件 JSON 回放（DESIGN §22）：非 SSE 一次性拉取，配合 SSE 断线补齐/轮询 ----
  app.get("/:sid/events/replay", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    const since = Math.max(Number(c.req.query("since") ?? 0) || 0, 0);
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 200), 1), 500);
    const filter = (c.req.query("types") ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const allow = allowType(filter);
    const all = r.ctx.replayAfter(since).filter((ev: GatewayEvent) => allow(ev.type));
    const events = all.slice(0, limit);
    return c.json({
      events,
      count: events.length,
      nextSince: events.at(-1)?.seq ?? since,
      latestSeq: r.ctx.replayAfter(0).at(-1)?.seq ?? 0,
      truncated: all.length > events.length,
      bufferLimit: 500,
      note: "ring buffer keeps the last 500 events; older history via /messages or /entries",
    });
  });

  // ---- 热点：本会话事件端点清单（集成端自描述）----
  app.get("/:sid/integration", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    const base = `/api/sessions/${r.row.id}`;
    return c.json({
      sessionId: r.row.id,
      endpoints: {
        bootstrap: `${base}/bootstrap`,
        status: `${base}/status`,
        prompt: `${base}/prompt`,
        inject: `${base}/inject`,
        eventsSse: `${base}/events`,
        eventsReplay: `${base}/events/replay`,
        approvals: `${base}/approvals`,
        webhooks: `${base}/webhooks`,
        state: `${base}/state`,
        messages: `${base}/messages`,
      },
      docs: {
        integrationGuide: "contracts/integration-guide.md",
        eventsSchema: "contracts/gateway-events.v1.schema.json",
        errorCodes: "contracts/error-codes.md",
        openapi: "/openapi.json",
      },
      // 钩子桥自检（DESIGN §23）：扩展按 omp session id 反查网关身份
      hooksBridge: {
        ompSessionId: r.ctx.ompSessionId ?? null,
        mapped: Boolean(r.ctx.ompSessionId && hookSessionOf(r.ctx.ompSessionId)),
      },
    });
  });
}
