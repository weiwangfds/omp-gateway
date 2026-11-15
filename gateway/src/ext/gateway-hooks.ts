/**
 * 网关内置扩展：把 omp 的 hooks 生命周期点桥接为集成端 HTTP 回调（DESIGN §23）。
 *
 * 官方 omp 只有 TS 回调（pi.on），无 HTTP 钩子；本扩展是网关补的那层桥。
 * 由 session-factory 经 `additionalExtensionPaths` 注入每个会话。
 * 事件面与合并语义见 core/hook-engine.ts（首/末获胜、累积、链式均对齐官方）。
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { dispatchViaBridge, HOOK_EVENTS, type HookEventName, type HookOutcome } from "../core/hook-engine.ts";

const sessionIdOf = (ctx: { sessionManager?: { getSessionId?: () => string } }): string | undefined => {
  try {
    return ctx.sessionManager?.getSessionId?.();
  } catch {
    return undefined;
  }
};

/** 把合并后的钩子结果映射为各事件要求的 SDK 返回值。 */
function toSdkResult(event: HookEventName, o: HookOutcome): Record<string, unknown> | undefined {
  switch (event) {
    case "resources_discover": {
      const r: Record<string, unknown> = {};
      if (o.skillPaths?.length) r.skillPaths = o.skillPaths;
      if (o.promptPaths?.length) r.promptPaths = o.promptPaths;
      if (o.themePaths?.length) r.themePaths = o.themePaths;
      return Object.keys(r).length ? r : undefined;
    }
    case "input": {
      if (o.handled) return { handled: true };
      return typeof o.text === "string" ? { text: o.text } : undefined;
    }
    case "user_bash":
    case "user_python":
      return o.result !== undefined ? { result: o.result } : undefined;
    case "tool_call": {
      if (o.block) return { block: true, reason: o.reason ?? "blocked by integration hook" };
      const r: Record<string, unknown> = {};
      if (o.input) r.input = o.input;
      if (o.additionalContext) r.additionalContext = o.additionalContext;
      return Object.keys(r).length ? r : undefined;
    }
    case "tool_result": {
      const r: Record<string, unknown> = {};
      if (o.content !== undefined) r.content = o.content;
      if (typeof o.isError === "boolean") r.isError = o.isError;
      if (o.additionalContext) r.additionalContext = o.additionalContext;
      return Object.keys(r).length ? r : undefined;
    }
    case "context":
      return Array.isArray(o.messages) ? { messages: o.messages } : undefined;
    case "before_agent_start": {
      const r: Record<string, unknown> = {};
      if (typeof o.systemPrompt === "string") r.systemPrompt = o.systemPrompt;
      if (o.messages?.length) r.message = o.messages[0];
      return Object.keys(r).length ? r : undefined;
    }
    case "session_before_switch":
      return o.cancel ? { cancel: true } : undefined;
    case "session_before_branch": {
      const r: Record<string, unknown> = {};
      if (o.cancel) return { cancel: true };
      if (typeof o.skipConversationRestore === "boolean") r.skipConversationRestore = o.skipConversationRestore;
      return Object.keys(r).length ? r : undefined;
    }
    case "session_before_compact": {
      if (o.cancel) return { cancel: true };
      return o.compaction !== undefined ? { compaction: o.compaction } : undefined;
    }
    case "session.compacting": {
      const r: Record<string, unknown> = {};
      if (o.context) r.context = o.context;
      if (o.prompt) r.prompt = o.prompt;
      if (o.preserveData) r.preserveData = o.preserveData;
      return Object.keys(r).length ? r : undefined;
    }
    case "session_before_tree": {
      if (o.cancel) return { cancel: true };
      return o.summary ? { summary: o.summary } : undefined;
    }
    case "session_stop": {
      if (!o.continue) return undefined;
      return o.additionalContext
        ? { continue: true, additionalContext: o.additionalContext }
        : { continue: true, additionalContext: "continue (integration hook)" };
    }
    default:
      return undefined;
  }
}

export default function gatewayIntegrationHooks(pi: ExtensionAPI) {
  for (const event of HOOK_EVENTS) {
    // 表驱动注册：事件面与合并语义由 hook-engine 统一管理
    (pi.on as unknown as (evt: string, handler: (e: any, ctx: any) => Promise<unknown>) => void)(
      event,
      async (evt: Record<string, unknown>, ctx: unknown) => {
        const ompId = sessionIdOf(ctx as never);
        if (process.env.GATEWAY_HOOKS_DEBUG === "1") {
          console.error(`[gw-hooks] ${event} ompId=${ompId ?? "(none)"}`);
        }
        if (!ompId) return;
        // 跨模块实例：走 globalThis 桥到网关主实例的分发实现（单例不共享，实测）
        const outcome = await dispatchViaBridge(ompId, event, evt);
        if (process.env.GATEWAY_HOOKS_DEBUG === "1") {
          console.error(`[gw-hooks] ${event} outcome=${outcome ? JSON.stringify(outcome).slice(0, 200) : "null"}`);
        }
        if (!outcome) return;
        return toSdkResult(event, outcome);
      },
    );
  }
}
