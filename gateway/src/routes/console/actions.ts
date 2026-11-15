import type { Hono } from "hono";
import { audit } from "../../core/tenant-store.ts";
import type { ConsoleEnv, ConsoleShared } from "./shared.ts";

/** 控制台写操作：细粒度中断、队列清空、自动标题。 */
export function mountConsoleActionRoutes(app: Hono<ConsoleEnv>, shared: ConsoleShared): void {
  const { live, s, jsonError } = shared;

  // ---- 细粒度中断（网页"停止"按钮组；对应 TUI 的各 Esc/abort 通道）----
  const INTERRUPT_TARGETS = ["retry", "compaction", "handoff", "branch-summary", "bash", "eval", "all"] as const;
  app.post("/:sid/interrupt", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    const body = await c.req.json().catch(() => null as any);
    const target = String(body?.target ?? "");
    if (!(INTERRUPT_TARGETS as readonly string[]).includes(target)) {
      return jsonError(c, 400, "BAD_REQUEST", `body.target must be one of ${INTERRUPT_TARGETS.join("|")}`);
    }
    const session = s(r.ctx);
    const calls: Array<[string, () => void]> = [
      ["retry", () => session.abortRetry?.()],
      ["compaction", () => session.abortCompaction?.()],
      ["handoff", () => session.abortHandoff?.()],
      ["branch-summary", () => session.abortBranchSummary?.()],
      ["bash", () => session.abortBash?.()],
      ["eval", () => session.abortEval?.()],
    ];
    const done: string[] = [];
    for (const [name, fn] of calls) {
      if (target !== "all" && target !== name) continue;
      try {
        fn();
        done.push(name);
      } catch {}
    }
    audit("session.interrupt", "session", r.row.id, c.get("userId"), { target, done });
    return c.json({ ok: true, target, interrupted: done });
  });

  // ---- 队列管理（整清；单条删除见 POST /:sid/queue/remove）----
  app.delete("/:sid/queue", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    const session = s(r.ctx);
    let dropped: unknown = null;
    try {
      dropped = typeof session.dropQueuedMessages === "function" ? session.dropQueuedMessages() : null;
      session.clearQueue?.();
    } catch (err) {
      return jsonError(c, 409, "QUEUE_CLEAR_FAILED", err instanceof Error ? err.message : String(err));
    }
    audit("session.queue.clear", "session", r.row.id, c.get("userId"));
    return c.json({
      ok: true,
      dropped,
      queue: session.getQueuedMessages?.() ?? { steering: [], followUp: [], liveSteered: 0 },
    });
  });

  // ---- 标题生成（新建会话后网页自动命名；不传 firstMessage 则用首条用户消息）----
  app.post("/:sid/title/generate", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    const body = await c.req.json().catch(() => null as any);
    const session = s(r.ctx);
    let first = typeof body?.firstMessage === "string" ? body.firstMessage : "";
    if (!first) {
      const msgs = (session.messages ?? []) as Array<{
        role?: string;
        content?: Array<{ type?: string; text?: string }>;
      }>;
      const userMsg = msgs.find((m) => m.role === "user");
      first = userMsg?.content?.find((b) => b.type === "text")?.text ?? "";
    }
    if (!first) return jsonError(c, 409, "NO_MESSAGES", "session has no user message to title from");
    try {
      const title = await session.generateTitle?.(
        first,
        typeof body?.customSystemPrompt === "string" ? body.customSystemPrompt : undefined,
      );
      if (title) {
        const { touchSession } = await import("../../core/tenant-store.ts");
        touchSession(r.row.id, { title });
        audit("session.title.generate", "session", r.row.id, c.get("userId"), { title });
      }
      return c.json({ ok: title != null, title: title ?? null });
    } catch (err) {
      return jsonError(c, 409, "TITLE_FAILED", err instanceof Error ? err.message : String(err));
    }
  });
}
