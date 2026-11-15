import { describe, expect, test } from "bun:test";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { SessionCtx, SessionRegistry } from "../../src/core/session-registry.ts";
import type { GatewayEvent } from "../../src/core/events.ts";

/** 最小 AgentSession 桩：只需要 model getter（model_changed 补齐用）。 */
function fakeSession(model?: { provider: string; id: string }): AgentSession {
  return { model } as unknown as AgentSession;
}

function collector() {
  const events: GatewayEvent[] = [];
  return {
    events,
    sub: {
      send(ev: GatewayEvent) {
        events.push(ev);
        return true;
      },
    },
  };
}

describe("SessionCtx", () => {
  test("streaming 状态随 agent_start/agent_end 迁移（isTerminal:false 不结束）", () => {
    const ctx = new SessionCtx("s1", "u1", "/ws", fakeSession());
    expect(ctx.streaming).toBe(false);
    ctx.dispatchOmp({ type: "agent_start" } as any);
    expect(ctx.streaming).toBe(true);
    ctx.dispatchOmp({ type: "agent_end", messages: [], isTerminal: false } as any);
    expect(ctx.streaming).toBe(true); // 非终态，仍在流式
    ctx.dispatchOmp({ type: "agent_end", messages: [], isTerminal: true } as any);
    expect(ctx.streaming).toBe(false);
  });

  test("turn_end 的 usage 充盈 agent_end 的 turn.completed", () => {
    const ctx = new SessionCtx("s1", "u1", "/ws", fakeSession());
    const { events, sub } = collector();
    ctx.subscribers.add(sub);
    ctx.dispatchOmp({ type: "turn_end", message: { usage: { input: 5, output: 1 } }, toolResults: [] } as any);
    ctx.dispatchOmp({ type: "agent_end", messages: [], isTerminal: true } as any);
    const turn = events.find((e) => e.type === "turn.completed") as Extract<GatewayEvent, { type: "turn.completed" }>;
    expect(turn.usage).toEqual({ input: 5, output: 1 });
    // 用量只挂一次：下一个 agent_end 不再带
    ctx.dispatchOmp({ type: "agent_end", messages: [], isTerminal: true } as any);
    const turns = events.filter((e) => e.type === "turn.completed");
    expect((turns[1] as any).usage).toBeUndefined();
  });

  test("model_changed 从 session.model 补齐负载", () => {
    const ctx = new SessionCtx("s1", "u1", "/ws", fakeSession({ provider: "minimax", id: "MiniMax-M3" }));
    const { events, sub } = collector();
    ctx.subscribers.add(sub);
    ctx.dispatchOmp({ type: "model_changed" } as any);
    expect(events[0]).toMatchObject({ type: "model.changed", provider: "minimax", modelId: "MiniMax-M3" });
  });

  test("publish 广播 + 序号单调 + 失败订阅者被移除", async () => {
    const ctx = new SessionCtx("s1", "u1", "/ws", fakeSession());
    const a = collector();
    const dead: GatewayEvent[] = [];
    ctx.subscribers.add(a.sub);
    ctx.subscribers.add({ send: () => false }); // 同步失败
    ctx.subscribers.add({
      send: () => Promise.reject(new Error("gone")), // 异步失败
    });
    ctx.publish({ type: "session.status", status: "idle" });
    ctx.publish({ type: "notice", level: "info", text: "x" });
    await new Promise((r) => setTimeout(r, 10));
    expect(a.events.length).toBe(2);
    expect(a.events[0].seq).toBe(1);
    expect(a.events[1].seq).toBe(2);
    expect(ctx.subscribers.size).toBe(1);
    expect(dead.length).toBe(0);
  });

  test("环形缓冲 500 上限 + replayAfter 游标过滤", () => {
    const ctx = new SessionCtx("s1", "u1", "/ws", fakeSession());
    for (let i = 0; i < 600; i++) ctx.publish({ type: "notice", level: "info", text: String(i) });
    const all = ctx.replayAfter(0);
    expect(all.length).toBe(500);
    expect(all[0].seq).toBe(101); // 最早的 100 条被挤出
    expect(all.at(-1)!.seq).toBe(600);
    expect(ctx.replayAfter(598).length).toBe(2);
  });

  test("dispatchOmp 更新 lastLiveAt", () => {
    const ctx = new SessionCtx("s1", "u1", "/ws", fakeSession());
    const before = ctx.lastLiveAt;
    ctx.lastLiveAt = before - 999_999;
    ctx.dispatchOmp({ type: "agent_start" } as any);
    expect(ctx.lastLiveAt).toBeGreaterThan(before - 999_999);
  });

  test("onTerminal：终态 agent_end 触发、非终态不触发、一次性", () => {
    const ctx = new SessionCtx("s1", "u1", "/ws", fakeSession());
    let fired = 0;
    ctx.onTerminal(() => fired++);
    ctx.dispatchOmp({ type: "agent_end", messages: [], isTerminal: false } as any);
    expect(fired).toBe(0);
    ctx.dispatchOmp({ type: "agent_end", messages: [], isTerminal: true } as any);
    expect(fired).toBe(1);
    ctx.dispatchOmp({ type: "agent_end", messages: [], isTerminal: true } as any);
    expect(fired).toBe(1); // 一次性
  });

  test("onTerminal 退订后不触发；markDisposed 立即触发且此后新注册即时触发", async () => {
    const ctx = new SessionCtx("s1", "u1", "/ws", fakeSession());
    let a = 0;
    let b = 0;
    const offA = ctx.onTerminal(() => a++);
    offA();
    ctx.markDisposed();
    await new Promise((r) => setTimeout(r, 5));
    expect(a).toBe(0);
    expect(b).toBe(0);
    ctx.onTerminal(() => b++); // 已 dispose：微任务立即触发
    await new Promise((r) => setTimeout(r, 5));
    expect(b).toBe(1);
  });
});

describe("SessionRegistry", () => {
  test("register/get/unregister/countForUser/streamingCount", () => {
    const reg = new SessionRegistry();
    const a = new SessionCtx("a", "u1", "/wsa", fakeSession());
    const b = new SessionCtx("b", "u2", "/wsb", fakeSession());
    reg.register(a);
    reg.register(b);
    expect(reg.get("a")?.userId).toBe("u1");
    expect(reg.countForUser("u1")).toBe(1);
    a.dispatchOmp({ type: "agent_start" } as any);
    expect(reg.streamingCount()).toBe(1);
    reg.unregister("a");
    expect(reg.get("a")).toBeUndefined();
    expect(reg.streamingCount()).toBe(0);
  });
});
