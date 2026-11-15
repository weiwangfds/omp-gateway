/** SSE 事件流（DESIGN §6）：replay.state 状态帧 → 游标回放（仅消息/工具类）→ 实时订阅。 */
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { GatewayEvent } from "../../core/events.ts";
import { getOrRevive, ownedSession, type SessionEnv } from "./shared.ts";

/** SSE 事件流：replay.state 首帧 → 游标回放 → 实时订阅 + 心跳（DESIGN §6）。 */
export function mountSessionEventsRoutes(app: Hono<SessionEnv>): void {
  /**
   * SSE 事件流（gateway-events v1，DESIGN §6）：
   * 重连协议 = replay.state 状态快照帧 → 游标回放（仅消息/工具类）→ 实时流。
   * 先订阅后 prompt 的时序由上游保证（契约）。
   */
  app.get("/:sid/events", (c) => {
    const sid = c.req.param("sid");
    return streamSSE(c, async (stream) => {
      const row = ownedSession(sid, c.get("userId"));
      if (!row) {
        await stream.writeSSE({ event: "error", data: JSON.stringify({ code: "NOT_FOUND" }) });
        return;
      }
      const ctx = await getOrRevive(row, c.get("userId"));
      if (!ctx) {
        await stream.writeSSE({ event: "error", data: JSON.stringify({ code: "SESSION_NOT_LIVE" }) });
        return;
      }

      const lastEventId = Number(c.req.header("last-event-id") ?? 0) || 0;
      const currentSeq = ctx.replayAfter(0).at(-1)?.seq ?? 0;
      // 事件过滤（DESIGN §21）：?types=text.delta,tool.*,turn.completed —— 通配后缀匹配。
      // 空/缺省=全量；replay.state 与 error 永远放行（协议帧）。
      const typeFilter = (c.req.query("types") ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const allow = (type: string): boolean => {
        if (typeFilter.length === 0) return true;
        if (type === "replay.state") return true;
        return typeFilter.some((f) => (f.endsWith("*") ? type.startsWith(f.slice(0, -1)) : type === f));
      };

      // 1) 状态快照帧（ops 类事件不回放，以本帧现值为准）
      await stream.writeSSE({
        id: String(currentSeq),
        event: "replay.state",
        data: JSON.stringify({
          sessionId: sid,
          status: ctx.streaming ? "streaming" : "idle",
          subscribers: ctx.subscribers.size + 1,
          lastEventId: currentSeq,
        }),
      });

      // 2) 游标回放（仅消息/工具类；ops 类已由 replay.state 覆盖）
      const REPLAYABLE = new Set([
        "message.started",
        "text.delta",
        "message.completed",
        "tool.started",
        "tool.args.delta",
        "tool.completed",
        "turn.completed",
        "turn.aborted",
      ]);
      for (const ev of ctx.replayAfter(lastEventId)) {
        if (!REPLAYABLE.has(ev.type) || !allow(ev.type)) continue;
        await stream.writeSSE({ id: String(ev.seq), event: ev.type, data: JSON.stringify(stripPrivate(ev)) });
      }

      // 3) 实时订阅
      const sub = {
        send: async (ev: GatewayEvent) => {
          if (!allow(ev.type)) return true; // 被过滤不算写失败（保住订阅）
          try {
            await stream.writeSSE({ id: String(ev.seq), event: ev.type, data: JSON.stringify(stripPrivate(ev)) });
            return true;
          } catch {
            return false;
          }
        },
      };
      ctx.subscribers.add(sub);

      // 保活注释行，防中间层空闲断连
      let closed = false;
      stream.onAbort(() => {
        closed = true;
        ctx.subscribers.delete(sub); // 断开=仅解绑订阅；不打断 agent（DESIGN §6）
      });
      while (!closed) {
        await stream.write(": keep-alive\n\n").catch(() => {});
        await new Promise((r) => setTimeout(r, 10_000)); // < Bun idleTimeout，保活防掐断
      }
    });
  });

  function stripPrivate(ev: GatewayEvent) {
    const { seq, ts, ...rest } = ev;
    return { ...rest, seq, ts };
  }
}
