/**
 * 对话通道：prompt（202 准许即返回，input 钩子在准入前分发）、steer、abort。
 * 错误映射：排队超时 429 / 无模型 409 MODEL_UNAVAILABLE。
 */
import type { Hono } from "hono";
import { parseImages } from "../../core/images.ts";
import { StreamQueueTimeout, streamingGate } from "../../core/streaming-gate.ts";
import { audit } from "../../core/tenant-store.ts";
import { enforceTurnPolicy, jsonError, requireLive, withTurnSlot, type SessionEnv } from "./shared.ts";
import { isTuiActive } from "../../core/tui-registry.ts";

/** 对话通道：prompt（202 准许语义）、steer、abort。 */
export function mountConversationRoutes(app: Hono<SessionEnv>): void {
  app.post("/:sid/prompt", async (c) => {
    const r = await requireLive(c);
    if ("error" in r) return r.error;
    // TUI 终端占用期写互斥（DESIGN §41.9）：必须在模型预检**之前**——否则无凭据部署
    // 会先报 MODEL_UNAVAILABLE 而非 TUI_ACTIVE，语义误导（实测踩到）
    if (isTuiActive(r.row.id)) {
      return jsonError(c, 409, "TUI_ACTIVE", "TUI terminal is attached; writes are exclusive to the terminal");
    }
    const body = await c.req.json().catch(() => ({}) as any);
    let text = typeof body?.text === "string" ? body.text : "";
    if (!text) return jsonError(c, 400, "BAD_REQUEST", "body.text is required");
    const images = parseImages(body?.images);
    if (typeof images === "string") return jsonError(c, 400, "BAD_REQUEST", images);
    // 租户策略（与集成门面同语义，DESIGN §8/§22）：开新 turn 前过预算 402 + RPM 429。
    // 此前主对话通道漏接——/prompt 可绕过计量（enforceTurnPolicy 在 SDK 桥声明却从未被调用）。
    const policy = enforceTurnPolicy(c.get("userId"));
    if (policy) {
      if (policy.retryAfter) c.header("Retry-After", String(policy.retryAfter));
      return c.json(policy.body, policy.status);
    }
    // 集成端 input 钩子（DESIGN §23）：SDK 的 input 事件只在交互式输入路径触发，
    // SDK 嵌入场景由网关在准入前分发——业务可审查/改写/拦截用户输入。
    try {
      const { dispatchIntegrationHooks } = await import("../../core/hook-engine.ts");
      const d = await dispatchIntegrationHooks(r.ctx.ompSessionId ?? "", "input", { text, source: "gateway" });
      if (d?.handled) return c.json({ admitted: false, handled: true, hooked: true }, 202);
      if (typeof d?.text === "string" && d.text !== text) {
        text = d.text;
        audit("session.inject.input_hook", "session", r.row.id, c.get("userId"), { rewritten: true });
      }
      if (d?.block) return jsonError(c, 403, "INPUT_BLOCKED", d.reason ?? "blocked by integration hook");
    } catch {}
    try {
      const sb = body?.streamingBehavior;
      // 准许前同步预检：无模型的失败必须保持快速 409（不订阅 SSE 的调用方也能拿到确定性错误）。
      // admission ≠ 模型可用——onPromptAdmitted 在模型解析前就会触发（PromptOptions 契约）。
      const hasModel = Boolean((r.ctx.session as unknown as { model?: unknown }).model);
      if (!hasModel)
        return jsonError(
          c,
          409,
          "MODEL_UNAVAILABLE",
          "session has no model configured; set one via POST /:sid/model or at creation",
        );
      // 202 在**准许即返回**：session.prompt() 的 Promise 在整个 turn 结束才 settle，
      // 若等它则审批开启时客户端拿不到响应、永远来不及决策 confirm_required（M6 实测教训）。
      // turn 结果经 SSE（turn.completed/message.completed）与 usage 落库观察；
      // admission 前的失败（未配模型 409 等）仍走 catch 映射。
      let markAdmitted: () => void = () => {};
      const admittedSignal = new Promise<void>((res) => {
        markAdmitted = res;
      });
      const turn = withTurnSlot(r.ctx, c.get("userId"), () =>
        r.ctx.session.prompt(text, {
          ...(sb === "steer" || sb === "followUp" ? { streamingBehavior: sb } : {}),
          ...(images.length ? { images } : {}),
          onPromptAdmitted: () => markAdmitted(),
        } as never),
      );
      const settled = await Promise.race([
        admittedSignal.then(() => ({ kind: "admitted" as const })),
        turn.then(
          (v) => ({ kind: "turn" as const, v }),
          (e) => ({ kind: "turn" as const, e }),
        ),
      ]);
      if (settled.kind === "turn") {
        if ("e" in settled) throw settled.e;
        return c.json({ admitted: settled.v !== false }, 202); // admission 前就结束（被丢弃等）
      }
      turn.catch((err) => console.error(`[gateway] turn error after admission (${r.ctx.sid}):`, err)); // 后台失败走 SSE，防 unhandledRejection
      // 同步等待模式（DESIGN §22）：wait=true 时持有 HTTP 到 turn 终态（集成端无 SSE 能力时用）。
      // 语义：admission 已成功 → 202；timedOut=true 表示等待超时但 turn 仍在跑（事件继续经 SSE/回放可得）。
      if (body?.wait === true) {
        const waitTimeoutMs = Math.min(Math.max(Number(body?.waitTimeoutMs ?? 120_000), 1_000), 600_000);
        await r.ctx.waitStreamingStart(2_000); // admission → agent_start 窗口，避免提前判 idle
        const timedOut = !(await r.ctx.waitTerminal(waitTimeoutMs));
        return c.json(
          {
            admitted: true,
            waited: true,
            timedOut,
            streaming: r.ctx.streaming,
            latestSeq: r.ctx.replayAfter(0).at(-1)?.seq ?? 0,
          },
          202,
        );
      }
      return c.json({ admitted: true }, 202);
    } catch (err) {
      if (err instanceof StreamQueueTimeout) {
        c.header("Retry-After", "5");
        return c.json(
          { error: { code: "STREAM_QUEUE_TIMEOUT", message: err.message, details: streamingGate.stats() } },
          429,
        );
      }
      if ((err as any)?.code === "SESSION_NOT_LIVE")
        return jsonError(c, 409, "SESSION_NOT_LIVE", (err as Error).message);
      // 典型：未配置模型/凭据（"Then use /model to select a model."）
      return jsonError(c, 409, "MODEL_UNAVAILABLE", err instanceof Error ? err.message : String(err));
    }
  });

  app.post("/:sid/steer", async (c) => {
    const r = await requireLive(c);
    if ("error" in r) return r.error;
    const body = await c.req.json().catch(() => ({}) as any);
    const images = parseImages(body?.images);
    if (typeof images === "string") return jsonError(c, 400, "BAD_REQUEST", images);
    try {
      await withTurnSlot(r.ctx, c.get("userId"), () =>
        r.ctx.session.steer(String(body?.text ?? ""), images.length ? (images as never) : undefined),
      );
      return c.json({ ok: true }, 202);
    } catch (err) {
      if (err instanceof StreamQueueTimeout) {
        c.header("Retry-After", "5");
        return c.json(
          { error: { code: "STREAM_QUEUE_TIMEOUT", message: err.message, details: streamingGate.stats() } },
          429,
        );
      }
      if ((err as any)?.code === "SESSION_NOT_LIVE")
        return jsonError(c, 409, "SESSION_NOT_LIVE", (err as Error).message);
      return jsonError(c, 409, "MODEL_UNAVAILABLE", err instanceof Error ? err.message : String(err));
    }
  });

  app.post("/:sid/abort", async (c) => {
    const r = await requireLive(c);
    if ("error" in r) return r.error;
    r.ctx.session.abort();
    return c.json({ ok: true }, 202);
  });
}
