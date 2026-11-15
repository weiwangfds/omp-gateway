import type { Hono } from "hono";
import type { IntegrationEnv, IntegrationShared } from "./shared.ts";
import { audit } from "../../core/tenant-store.ts";

/** 业务事件注入：登记 → 广播 → 可选注入上下文并触发 turn → correlation 关联。 */
export function mountBusinessEventRoutes(app: Hono<IntegrationEnv>, shared: IntegrationShared): void {
  const { live, s, jsonError, withTurnSlot, enforceTurnPolicy } = shared;

  // ---- 业务事件注入（DESIGN §22.5）：集成端推一个业务事件，agent 响应后回调带关联标识）----
  // 流程：POST → business.event 广播（SSE/webhook）→ 可选注入上下文并触发 turn
  // → 该 turn 内所有事件带 correlation{eventId,type} → turn 终态发 business.completed
  app.post("/:sid/business-events", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    const body = await c.req.json().catch(() => null as any);
    const eventType = typeof body?.type === "string" ? body.type.trim() : "";
    if (!eventType || eventType.length > 128) {
      return jsonError(c, 400, "BAD_REQUEST", "body.type (business event type, ≤128 chars) required");
    }
    const data = body?.data;
    const text =
      typeof body?.text === "string" && body.text ? body.text : data !== undefined ? JSON.stringify(data) : "";
    if (!text) return jsonError(c, 400, "BAD_REQUEST", "body.text or body.data required");
    const inject = body?.inject !== false;
    const triggerTurn = body?.triggerTurn === true;
    const deliverAs = body?.deliverAs;
    if (deliverAs !== undefined && !["steer", "followUp", "nextTurn", "aside"].includes(deliverAs)) {
      return jsonError(c, 400, "BAD_REQUEST", "deliverAs must be steer|followUp|nextTurn|aside");
    }
    if (inject && triggerTurn) {
      const policy = enforceTurnPolicy(c.get("userId"));
      if (policy) {
        if (policy.retryAfter) c.header("Retry-After", String(policy.retryAfter));
        return c.json(policy.body, policy.status);
      }
    }

    // 1) 登记 + 广播 business.event（事件本身也进 webhook/SSE，前端可渲染业务事件卡）
    const { eventId } = r.ctx.recordBusinessEvent({ type: eventType, data, text });

    // 2) 注入上下文（可选）：customType=business.event 让模型能识别这是外部事件
    let injected = false;
    let triggeredTurn = false;
    if (inject) {
      const session = s(r.ctx);
      const content = `[business event: ${eventType}]\n${text}`;
      const doInject = () =>
        session.sendCustomMessage(
          {
            customType: "business.event",
            content,
            details: { eventId, eventType, ...(data !== undefined ? { data } : {}) },
          },
          {
            ...(triggerTurn ? { triggerTurn: true } : {}),
            ...(deliverAs ? { deliverAs } : {}),
          },
        ) as Promise<boolean>;
      try {
        triggeredTurn = triggerTurn
          ? Boolean(await withTurnSlot(r.ctx, c.get("userId"), doInject))
          : Boolean(await doInject());
        injected = true;
      } catch (err) {
        // 注入失败不回滚事件登记（事件已广播）；明确告知集成端
        return jsonError(
          c,
          409,
          "BUSINESS_EVENT_INJECT_FAILED",
          `event ${eventId} was recorded but context injection failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 3) 可选同步等待（triggerTurn 时）
    let waited = false;
    let timedOut: boolean | null = null;
    if (body?.wait === true && triggeredTurn) {
      const waitTimeoutMs = Math.min(Math.max(Number(body?.waitTimeoutMs ?? 120_000), 1_000), 600_000);
      waited = true;
      await r.ctx.waitStreamingStart(2_000); // admission → agent_start 窗口
      timedOut = !(await r.ctx.waitTerminal(waitTimeoutMs));
    }
    audit("session.business_event", "session", r.row.id, c.get("userId"), {
      eventId,
      type: eventType,
      injected,
      triggeredTurn,
    });
    return c.json(
      {
        ok: true,
        eventId,
        eventType,
        injected,
        triggeredTurn,
        ...(waited ? { waited, timedOut } : {}),
        streaming: r.ctx.streaming,
        latestSeq: r.ctx.replayAfter(0).at(-1)?.seq ?? 0,
        callbackHint:
          "subscribe POST /api/sessions/:sid/webhooks with events [turn.completed, business.completed, tool.confirm_required]; correlating events carry correlation{eventId,type}",
      },
      202,
    );
  });
}
