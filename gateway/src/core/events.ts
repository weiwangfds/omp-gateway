/**
 * gateway-events v1 规范化层（DESIGN §6）。
 * 把 omp AgentSessionEvent 转成稳定事件；下游（Python/前端）不感知 omp 内部事件名。
 * 字段形状以 pi-agent-core 类型 + 实测流为准（DESIGN §12），未知事件 → omp.raw 透传。
 */
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";

export type GatewayEventPayload =
  | { type: "session.status"; status: "idle" | "streaming" }
  | { type: "session.status_changed"; from: string; to: string; reason?: string }
  | { type: "message.started"; role: string; messageId: string }
  | {
      type: "message.completed";
      messageId: string;
      role: string;
      provider?: string;
      modelId?: string;
      stopReason?: string;
      usage?: unknown;
    }
  | { type: "text.delta"; messageId: string; delta: string }
  | { type: "tool.started"; callId: string; name: string; args?: unknown }
  | { type: "tool.completed"; callId: string; result: unknown }
  | { type: "tool.confirm_required"; approvalId: string; tool: string; args: unknown; timeoutSec: number }
  | { type: "turn.completed"; isTerminal: boolean; usage?: unknown }
  | { type: "model.changed"; provider: string; modelId: string }
  | { type: "thinking.changed"; level: string | null }
  | { type: "agents.changed"; agents: unknown }
  | { type: "notice"; level: string; text: string }
  // ---- v1.2：网页控制台面板（todo/goal/queue/compaction/retry/fallback/rules）----
  | { type: "todo.reminder"; todos: unknown; attempt: number; maxAttempts: number }
  | { type: "todo.cleared" }
  | { type: "goal.updated"; goal: unknown; state?: unknown }
  | { type: "queue.updated"; steering: string[]; followUp: string[]; liveSteered: number }
  | { type: "compaction.started"; manual: boolean; reason?: string; action?: string }
  | {
      type: "compaction.completed";
      manual: boolean;
      aborted: boolean;
      willRetry?: boolean;
      skipped?: boolean;
      error?: string;
    }
  | { type: "retry.started"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "retry.completed"; success: boolean; attempt: number; finalError?: string }
  | { type: "model.fallback"; from: string; to: string; role: string; reason?: string; succeeded?: boolean }
  | { type: "config.warnings" }
  | { type: "rules.triggered"; rules: unknown }
  // ---- v1.3：业务事件（集成端注入 → 关联 turn → 完成回调）----
  | { type: "business.event"; eventId: string; eventType: string; data?: unknown; text: string }
  | { type: "business.completed"; eventId: string; eventType: string; status: "completed"; usage?: unknown }
  // ---- v1.4：TUI 终端桥（DESIGN §41.9）——前端 TUI 打开期间，网关 tail 同一 JSONL，
  // 把 omp TUI 进程写入的新条目镜像给 SSE 订阅者（entry 形状 = omp 会话 JSONL 条目）
  | { type: "tui.entry"; entry: unknown }
  | { type: "omp.raw"; omp: unknown };

/** 业务事件关联标识：挂在事件信封上，集成端据此把 agent 响应归因到自己的业务事件。 */
export interface GatewayCorrelation {
  eventId: string;
  type: string;
}

/** 带上会话级单调序号（SSE `id:`，重连用 Last-Event-ID 回放）与时间戳的完整事件。 */
export type GatewayEvent = GatewayEventPayload & {
  seq: number;
  ts: number;
  /** 当前事件属于某个业务事件的响应链（DESIGN §22.5） */
  correlation?: GatewayCorrelation;
};

/* eslint-disable @typescript-eslint/no-explicit-any */

/** 从 AgentMessage 提取稳定 messageId（实测消息对象无 id 字段，用 responseId/timestamp 兜底）。 */
function messageIdOf(msg: any): string {
  return String(msg?.id ?? msg?.responseId ?? `m${msg?.timestamp ?? Date.now()}`);
}

/**
 * 事件映射表（Strategy Map）：omp 事件名 → 规范化函数。
 * 未命中 → fallback（omp.raw 透传）。新增事件只加一行，不再改长 switch。
 */
type Mapper = (evt: any) => GatewayEventPayload;

const EVENT_MAPPERS: Record<string, Mapper> = {
  agent_start: () => ({ type: "session.status", status: "streaming" }),
  // usage 由 SessionCtx 从 turn_end 备忘后充盈（agent_end 本体无 usage）
  agent_end: (evt) => ({ type: "turn.completed", isTerminal: evt.isTerminal !== false }),

  message_start: (evt) => {
    const msg = evt.message;
    return { type: "message.started", role: String(msg?.role ?? "unknown"), messageId: messageIdOf(msg) };
  },
  message_end: (evt) => {
    const msg = evt.message;
    return {
      type: "message.completed",
      role: String(msg?.role ?? "unknown"),
      messageId: messageIdOf(msg),
      ...(msg?.provider ? { provider: String(msg.provider) } : {}),
      ...(msg?.model ? { modelId: String(msg.model) } : {}),
      ...(msg?.stopReason ? { stopReason: String(msg.stopReason) } : {}),
      ...(msg?.usage ? { usage: msg.usage } : {}),
    };
  },
  message_update: (evt) => {
    const inner = evt.assistantMessageEvent;
    if (inner?.type === "text_delta") {
      // 真实形状：{ contentIndex, delta, partial: AssistantMessage }
      return { type: "text.delta", messageId: messageIdOf(inner.partial), delta: String(inner.delta ?? "") };
    }
    return { type: "omp.raw", omp: inner ?? evt };
  },

  // M9：args 增补（additive）——a2ui/前端工具卡片需要工具输入渲染（diff/命令等）
  tool_execution_start: (evt) => ({
    type: "tool.started",
    callId: String(evt.toolCallId),
    name: String(evt.toolName),
    args: evt.args ?? null,
  }),
  tool_execution_end: (evt) => ({ type: "tool.completed", callId: String(evt.toolCallId), result: evt.result ?? null }),

  // 事件不带负载；由 SessionCtx.dispatchOmp 从 session.model 补齐
  model_changed: () => ({ type: "model.changed", provider: "", modelId: "" }),
  thinking_level_changed: (evt) => ({ type: "thinking.changed", level: (evt.thinkingLevel ?? null) as string | null }),
  notice: (evt) => ({ type: "notice", level: evt.level, text: String(evt.message ?? "") }),

  // ---- v1.2：控制台面板事件（网页实时刷新 todo/goal/队列/压缩/重试）----
  todo_reminder: (evt) => ({
    type: "todo.reminder",
    todos: evt.todos ?? [],
    attempt: Number(evt.attempt ?? 0),
    maxAttempts: Number(evt.maxAttempts ?? 0),
  }),
  todo_auto_clear: () => ({ type: "todo.cleared" }),
  goal_updated: (evt) => ({ type: "goal.updated", goal: evt.goal ?? null, state: evt.state }),
  queue_update: (evt) => ({
    type: "queue.updated",
    steering: [...(evt.steering ?? [])].map(String),
    followUp: [...(evt.followUp ?? [])].map(String),
    liveSteered: Number(evt.liveSteered ?? 0),
  }),
  auto_compaction_start: (evt) => ({
    type: "compaction.started",
    manual: false,
    reason: evt.reason,
    action: evt.action,
  }),
  auto_compaction_end: (evt) => ({
    type: "compaction.completed",
    manual: false,
    aborted: Boolean(evt.aborted),
    willRetry: evt.willRetry,
    skipped: evt.skipped,
    error: evt.errorMessage,
  }),
  manual_compaction_start: (evt) => ({ type: "compaction.started", manual: true, action: evt.mode }),
  manual_compaction_end: (evt) => ({
    type: "compaction.completed",
    manual: true,
    aborted: Boolean(evt.aborted),
    skipped: evt.skipped,
    error: evt.errorMessage,
  }),
  auto_retry_start: (evt) => ({
    type: "retry.started",
    attempt: Number(evt.attempt ?? 0),
    maxAttempts: Number(evt.maxAttempts ?? 0),
    delayMs: Number(evt.delayMs ?? 0),
    errorMessage: String(evt.errorMessage ?? ""),
  }),
  auto_retry_end: (evt) => ({
    type: "retry.completed",
    success: Boolean(evt.success),
    attempt: Number(evt.attempt ?? 0),
    finalError: evt.finalError,
  }),
  retry_fallback_applied: (evt) => ({
    type: "model.fallback",
    from: String(evt.from ?? ""),
    to: String(evt.to ?? ""),
    role: String(evt.role ?? ""),
    reason: evt.reason,
    succeeded: false,
  }),
  retry_fallback_succeeded: (evt) => ({
    type: "model.fallback",
    from: "",
    to: String(evt.model ?? ""),
    role: String(evt.role ?? ""),
    succeeded: true,
  }),
  config_warnings_changed: () => ({ type: "config.warnings" }),
  ttsr_triggered: (evt) => ({ type: "rules.triggered", rules: evt.rules ?? [] }),
};

/** omp 事件 → 规范化事件；查 EVENT_MAPPERS，未登记的事件原样透传为 omp.raw（前向兼容）。 */
export function normalizeOmpEvent(evt: AgentSessionEvent): GatewayEventPayload {
  const mapper = EVENT_MAPPERS[(evt as { type: string }).type];
  return mapper ? mapper(evt as any) : { type: "omp.raw", omp: evt };
}

/** turn_end 备忘的用量与模型信息（充盈 turn.completed / 用量落库）。 */
export interface TurnMeta {
  usage: Record<string, unknown>;
  provider?: string;
  modelId?: string;
  durationMs?: number;
  ttftMs?: number;
}

/**
 * 从 turn_end 提取用量/模型/耗时备忘。
 * agent_end 发 turn.completed 时不带 usage，SessionCtx 用这里的结果充盈（M9 实测结论）。
 */
export function metaOfTurnEnd(evt: AgentSessionEvent): TurnMeta | undefined {
  if (evt.type !== "turn_end") return undefined;
  const msg = (evt as any).message;
  if (!msg?.usage) return undefined;
  const meta: TurnMeta = { usage: { ...msg.usage } };
  if (msg.provider) meta.provider = String(msg.provider);
  if (msg.model) meta.modelId = String(msg.model);
  if (typeof msg.duration === "number") meta.durationMs = Math.round(msg.duration);
  if (typeof msg.ttft === "number") meta.ttftMs = Math.round(msg.ttft);
  return meta;
}
