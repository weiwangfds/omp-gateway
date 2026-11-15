import { describe, expect, test } from "bun:test";
import { normalizeOmpEvent, metaOfTurnEnd } from "../../src/core/events.ts";

/** 按 pi-agent-core 类型 + 实测流构造的 omp 事件样本。 */
const msg = (extra: Record<string, unknown> = {}) => ({
  role: "assistant",
  content: [{ type: "text", text: "hi" }],
  timestamp: 1794730765511,
  ...extra,
});

describe("normalizeOmpEvent", () => {
  test("agent_start → session.status streaming", () => {
    expect(normalizeOmpEvent({ type: "agent_start" } as any)).toEqual({ type: "session.status", status: "streaming" });
  });

  test("agent_end → turn.completed，isTerminal 缺省视为 true", () => {
    expect(normalizeOmpEvent({ type: "agent_end", messages: [] } as any)).toEqual({
      type: "turn.completed",
      isTerminal: true,
    });
    expect(normalizeOmpEvent({ type: "agent_end", messages: [], isTerminal: false } as any)).toEqual({
      type: "turn.completed",
      isTerminal: false,
    });
  });

  test("message_start → message.started，messageId 用 responseId 兜底", () => {
    const out = normalizeOmpEvent({ type: "message_start", message: msg({ role: "user" }) } as any);
    expect(out).toEqual({ type: "message.started", role: "user", messageId: "m1794730765511" });
  });

  test("message_end → message.completed 带 provider/model/usage/stopReason", () => {
    const out = normalizeOmpEvent({
      type: "message_end",
      message: msg({
        provider: "minimax",
        model: "MiniMax-M3.1-Flash",
        stopReason: "stop",
        usage: { input: 10, output: 2 },
      }),
    } as any);
    expect(out).toEqual({
      type: "message.completed",
      role: "assistant",
      messageId: "m1794730765511",
      provider: "minimax",
      modelId: "MiniMax-M3.1-Flash",
      stopReason: "stop",
      usage: { input: 10, output: 2 },
    });
  });

  test("message_update.text_delta → text.delta（载荷在 partial）", () => {
    const out = normalizeOmpEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "OK", partial: msg() },
    } as any);
    expect(out).toEqual({ type: "text.delta", messageId: "m1794730765511", delta: "OK" });
  });

  test("message_update 未知内事件 → omp.raw", () => {
    const out = normalizeOmpEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta" } } as any);
    expect(out.type).toBe("omp.raw");
  });

  test("tool_execution_start/end 用 toolCallId/toolName（M9：started 增补 args）", () => {
    expect(
      normalizeOmpEvent({ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: {} } as any),
    ).toEqual({
      type: "tool.started",
      callId: "c1",
      name: "read",
      args: {},
    });
    expect(normalizeOmpEvent({ type: "tool_execution_end", toolCallId: "c1", result: { ok: true } } as any)).toEqual({
      type: "tool.completed",
      callId: "c1",
      result: { ok: true },
    });
  });

  test("model_changed 事件无负载 → 空负载由 SessionCtx 补齐", () => {
    expect(normalizeOmpEvent({ type: "model_changed" } as any)).toEqual({
      type: "model.changed",
      provider: "",
      modelId: "",
    });
  });

  test("notice 字段是 message", () => {
    expect(normalizeOmpEvent({ type: "notice", level: "warning", message: "careful" } as any)).toEqual({
      type: "notice",
      level: "warning",
      text: "careful",
    });
  });

  test("未知顶层事件 → omp.raw 透传", () => {
    const out = normalizeOmpEvent({ type: "totally_new_event", x: 1 } as any);
    expect(out).toEqual({ type: "omp.raw", omp: { type: "totally_new_event", x: 1 } });
  });
});

describe("metaOfTurnEnd", () => {
  test("从 turn_end.message 提取 usage/provider/model/duration/ttft", () => {
    const usage = { input: 6802, output: 9, totalTokens: 6939, cost: { total: 0.001 } };
    expect(
      metaOfTurnEnd({
        type: "turn_end",
        message: msg({ usage, provider: "minimax", model: "MiniMax-M3.1-Flash", duration: 1053.96, ttft: 853.49 }),
        toolResults: [],
      } as any),
    ).toEqual({
      usage,
      provider: "minimax",
      modelId: "MiniMax-M3.1-Flash",
      durationMs: 1054,
      ttftMs: 853,
    });
  });
  test("非 turn_end / 无 usage → undefined", () => {
    expect(metaOfTurnEnd({ type: "agent_start" } as any)).toBeUndefined();
    expect(metaOfTurnEnd({ type: "turn_end", message: msg(), toolResults: [] } as any)).toBeUndefined();
  });
});
