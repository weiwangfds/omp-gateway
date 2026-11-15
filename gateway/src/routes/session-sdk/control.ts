/**
 * SDK 桥·会话控制：compact / follow-up / custom message / restore-interrupted /
 * reset / handoff / cycle / queue / name。改状态的端点都过流式闸门（withTurnSlot）。
 */
import type { Hono } from "hono";
import type { SdkEnv, SdkShared } from "./shared.ts";
import { audit } from "../../core/tenant-store.ts";

/** 会话控制：compact / follow-up / custom message / reset / handoff / cycle / queue / name。 */
export function mountControlRoutes(app: Hono<SdkEnv>, shared: SdkShared): void {
  const { live, jsonError, withTurnSlot, parseImages, modelOf } = shared;

  // ---- 手动压缩 ----
  app.post("/:sid/compact", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    if (r.ctx.streaming) return jsonError(c, 409, "SESSION_STREAMING", "compact requires idle session");
    const body = await c.req.json().catch(() => ({}) as any);
    try {
      const result = await withTurnSlot(r.ctx, c.get("userId"), () =>
        (r.ctx.session as unknown as { compact: (i?: string) => Promise<unknown> }).compact(
          typeof body?.instructions === "string" ? body.instructions : undefined,
        ),
      );
      audit("session.compact", "session", r.row.id, c.get("userId"));
      return c.json({ result });
    } catch (err) {
      if (
        err instanceof Error &&
        /no model|model/i.test(err.message) === false &&
        (err as any).code === "SESSION_NOT_LIVE"
      ) {
        return jsonError(c, 409, "SESSION_NOT_LIVE", err.message);
      }
      return jsonError(c, 409, "COMPACT_FAILED", err instanceof Error ? err.message : String(err));
    }
  });

  // ---- 显式 followUp（排队，不打断当前流；支持图片）----
  app.post("/:sid/follow-up", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    const body = await c.req.json().catch(() => null as any);
    if (typeof body?.text !== "string" || !body.text) return jsonError(c, 400, "BAD_REQUEST", "body.text required");
    const images = parseImages(body?.images);
    if (typeof images === "string") return jsonError(c, 400, "BAD_REQUEST", images);
    try {
      await withTurnSlot(r.ctx, c.get("userId"), () =>
        (r.ctx.session as unknown as { followUp: (t: string, imgs?: unknown) => Promise<void> }).followUp(
          body.text,
          images.length ? images : undefined,
        ),
      );
      return c.json({ ok: true, queued: true }, 202);
    } catch (err) {
      if ((err as any)?.code === "SESSION_NOT_LIVE")
        return jsonError(c, 409, "SESSION_NOT_LIVE", (err as Error).message);
      return jsonError(c, 409, "FOLLOW_UP_FAILED", err instanceof Error ? err.message : String(err));
    }
  });

  // ---- 自定义消息（扩展协议通道）----
  app.post("/:sid/messages/custom", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    const body = await c.req.json().catch(() => null as any);
    const payload = typeof body?.payload === "string" ? body.payload : (body?.payload ?? null);
    if (!payload) return jsonError(c, 400, "BAD_REQUEST", "body.payload required ({customType,content,...} or string)");
    const deliverAs = body?.deliverAs;
    if (deliverAs && !["steer", "followUp", "aside"].includes(deliverAs)) {
      return jsonError(c, 400, "BAD_REQUEST", "deliverAs must be steer|followUp|aside");
    }
    const s = r.ctx.session as unknown as {
      sendCustomMessage: (m: unknown, o?: { deliverAs?: string; triggerTurn?: boolean }) => Promise<unknown>;
    };
    try {
      await withTurnSlot(r.ctx, c.get("userId"), () =>
        s.sendCustomMessage(payload, {
          ...(deliverAs ? { deliverAs } : {}),
          ...(body?.triggerTurn != null ? { triggerTurn: Boolean(body.triggerTurn) } : {}),
        }),
      );
      return c.json({ ok: true }, 202);
    } catch (err) {
      if ((err as any)?.code === "SESSION_NOT_LIVE")
        return jsonError(c, 409, "SESSION_NOT_LIVE", (err as Error).message);
      return jsonError(c, 409, "CUSTOM_MESSAGE_FAILED", err instanceof Error ? err.message : String(err));
    }
  });

  // ---- 孤儿 turn 恢复（网关/进程崩溃后 JSONL 里未闭合的 turn，SDK 原生补齐）----
  app.post("/:sid/restore-interrupted", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    if (r.ctx.streaming) return jsonError(c, 409, "SESSION_STREAMING", "restore requires idle session");
    const restored = await (
      r.ctx.session as unknown as { restoreInterruptedTurn: () => Promise<boolean> }
    ).restoreInterruptedTurn();
    audit("session.restore_interrupted", "session", r.row.id, c.get("userId"), { restored });
    return c.json({ restored });
  });

  // ---- 会话重置（/new 语义：清空上下文，文件保留）----
  app.post("/:sid/reset", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    if (r.ctx.streaming) return jsonError(c, 409, "SESSION_STREAMING", "reset requires idle session");
    try {
      const result = await withTurnSlot(r.ctx, c.get("userId"), () =>
        (r.ctx.session as unknown as { resetSessionContext: () => Promise<unknown> }).resetSessionContext(),
      );
      audit("session.reset", "session", r.row.id, c.get("userId"));
      return c.json({ ok: true, result: result ?? null });
    } catch (err) {
      if ((err as any)?.code === "SESSION_NOT_LIVE")
        return jsonError(c, 409, "SESSION_NOT_LIVE", (err as Error).message);
      return jsonError(c, 409, "RESET_FAILED", err instanceof Error ? err.message : String(err));
    }
  });

  // ---- handoff：总结当前会话并移交新上下文（SDK handoff）----
  app.post("/:sid/handoff", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    if (r.ctx.streaming) return jsonError(c, 409, "SESSION_STREAMING", "handoff requires idle session");
    const body = await c.req.json().catch(() => ({}) as any);
    try {
      const result = await withTurnSlot(r.ctx, c.get("userId"), () =>
        (r.ctx.session as unknown as { handoff: (i?: string) => Promise<unknown> }).handoff(
          typeof body?.instructions === "string" ? body.instructions : undefined,
        ),
      );
      audit("session.handoff", "session", r.row.id, c.get("userId"));
      return c.json({ result: result ?? null });
    } catch (err) {
      if ((err as any)?.code === "SESSION_NOT_LIVE")
        return jsonError(c, 409, "SESSION_NOT_LIVE", (err as Error).message);
      return jsonError(c, 409, "HANDOFF_FAILED", err instanceof Error ? err.message : String(err));
    }
  });

  // ---- 循环切换（Ctrl+P / thinking cycle 的 HTTP 形态）----
  app.post("/:sid/cycle-model", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    const body = await c.req.json().catch(() => ({}) as any);
    const direction = body?.direction === "backward" ? "backward" : "forward";
    if (r.ctx.streaming) return jsonError(c, 409, "SESSION_STREAMING", "model switch allowed only when idle");
    const result = await (r.ctx.session as unknown as { cycleModel: (d?: string) => Promise<unknown> }).cycleModel(
      direction,
    );
    return c.json({ switched: result ?? null, model: modelOf(r.ctx.session) });
  });

  app.post("/:sid/cycle-thinking", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    const s = r.ctx.session as unknown as { cycleThinkingLevel: () => string | undefined; thinkingLevel?: string };
    const level = s.cycleThinkingLevel();
    return c.json({ current: level ?? s.thinkingLevel ?? null });
  });

  // ---- 队列管理（移除排队中的消息）----
  app.post("/:sid/queue/remove", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    const body = await c.req.json().catch(() => null as any);
    if (typeof body?.text !== "string" || !["steering", "followUp"].includes(body?.queue)) {
      return jsonError(c, 400, "BAD_REQUEST", 'body.text and body.queue ("steering"|"followUp") required');
    }
    const removed = (
      r.ctx.session as unknown as { removeQueuedMessage: (t: string, q: string) => boolean }
    ).removeQueuedMessage(body.text, body.queue);
    return c.json({ removed });
  });

  // ---- 会话名（SDK 层命名，独立于网关 title）----
  app.post("/:sid/name", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    const body = await c.req.json().catch(() => null as any);
    if (typeof body?.name !== "string" || !body.name.trim())
      return jsonError(c, 400, "BAD_REQUEST", "body.name required");
    const ok = await (
      r.ctx.session as unknown as { setSessionName: (n: string, src?: string) => Promise<boolean> }
    ).setSessionName(body.name.trim(), "user");
    return c.json({ ok });
  });
}
