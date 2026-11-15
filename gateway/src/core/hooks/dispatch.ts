/**
 * 集成端钩子分发（DESIGN §23）：并行 POST → 官方合并语义（首/末获胜、累积、链式）。
 */
import { signPayload } from "../signature.ts";
import type { IntegrationHookRow } from "../tenant-store.ts";
import { hookSessionCount, hookSessionOf, installBridgeDispatch } from "./bridge.ts";
import { hooksFor, matches, payloadFor } from "./cache.ts";
import type { HookEventName } from "./events.ts";
import { postHook, uniq } from "./transport.ts";
import type { HookAnswer, HookOutcome } from "./types.ts";

/**
 * 分发钩子并按官方合并语义归约。
 * notify → fire-and-forget；decide → 串行等待，链式载荷，按事件规则合并。
 * 决策钩子不可达/超时：onTimeout=deny 视为该钩子的否定决策（tool_call → block）。
 */
export async function dispatchIntegrationHooks(
  ompSessionId: string,
  event: HookEventName,
  raw: Record<string, any>,
): Promise<HookOutcome | null> {
  const identity = hookSessionOf(ompSessionId);
  if (!identity) {
    if (process.env.GATEWAY_HOOKS_DEBUG === "1") {
      console.error(`[hook-engine] ${event} identity MISSING for ${ompSessionId} (mapSize=${hookSessionCount()})`);
    }
    return null;
  }
  const rows = hooksFor(identity.userId, identity.sid, event);
  if (process.env.GATEWAY_HOOKS_DEBUG === "1") {
    console.error(`[hook-engine] ${event} sid=${identity.sid} user=${identity.userId} rows=${rows.length}`);
  }
  if (rows.length === 0) return null;

  const chain: Record<string, unknown> = {};
  const out: HookOutcome = {};
  let touched = false;

  const sendNotify = (row: IntegrationHookRow, body: string, sig: string) => {
    void (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await postHook(row, body, sig, Math.max(row.timeout_ms, 1_000));
        if (res.ok) return;
        if (attempt === 0) await new Promise((r) => setTimeout(r, 2_000));
      }
    })();
  };

  for (const row of rows) {
    const payload = payloadFor(event, identity.sid, raw, chain);
    if (!matches(row, payload)) continue;
    const body = JSON.stringify(payload);
    const sig = signPayload(row.secret, body);
    if (row.mode === "notify") {
      sendNotify(row, body, sig);
      continue;
    }
    const res = await postHook(row, body, sig, Math.max(row.timeout_ms, 100));
    if (!res.ok) {
      if (row.on_timeout === "deny") {
        touched = true;
        if (event.startsWith("session_before_")) {
          out.cancel = true;
          return out; // 首个 cancel 终止
        }
        out.block = true;
        out.reason = `hook ${row.id} ${res.status ? `status ${res.status}` : "unreachable"} (onTimeout=deny)`;
        return out; // 首个 block 终止（tool_call/input 等）
      }
      continue;
    }
    const a = (res.json ?? {}) as HookAnswer;
    touched = true;

    switch (event) {
      case "resources_discover": {
        if (Array.isArray(a.skillPaths))
          out.skillPaths = uniq([...(out.skillPaths ?? []), ...a.skillPaths.map(String)]);
        if (Array.isArray(a.promptPaths))
          out.promptPaths = uniq([...(out.promptPaths ?? []), ...a.promptPaths.map(String)]);
        if (Array.isArray(a.themePaths))
          out.themePaths = uniq([...(out.themePaths ?? []), ...a.themePaths.map(String)]);
        break;
      }
      case "input": {
        if (a.handled === true) {
          out.handled = true;
          return out; // handled 停止后续处理
        }
        if (a.block === true || a.decision === "deny") {
          out.block = true;
          out.reason = a.reason ?? `denied by hook ${row.id}`;
          return out;
        }
        if (typeof a.text === "string") {
          out.text = a.text;
          chain.text = a.text; // 链式
        }
        break;
      }
      case "user_bash":
      case "user_python": {
        if (a.result !== undefined) {
          out.result = a.result;
          return out; // first wins
        }
        break;
      }
      case "tool_call": {
        const blocked = a.block === true || a.decision === "deny";
        if (blocked) {
          out.block = true;
          out.reason = a.reason ?? `denied by hook ${row.id}`;
          return out; // 首个 block 终止
        }
        if (a.input && typeof a.input === "object") {
          out.input = a.input;
          chain.input = a.input; // last wins + 链式
        }
        if (a.additionalContext)
          out.additionalContext = appendCtx(out.additionalContext, a.additionalContext, event, row.id);
        break;
      }
      case "tool_result": {
        if (a.content !== undefined) {
          out.content = a.content;
          chain.content = a.content; // 链式
        }
        if (typeof a.isError === "boolean") {
          out.isError = a.isError;
          chain.isError = a.isError;
        }
        if (a.additionalContext)
          out.additionalContext = appendCtx(out.additionalContext, a.additionalContext, event, row.id);
        break;
      }
      case "context": {
        if (Array.isArray(a.messages)) {
          out.messages = a.messages;
          chain.messages = a.messages;
        }
        break;
      }
      case "before_agent_start": {
        if (typeof a.systemPrompt === "string") {
          out.systemPrompt = a.systemPrompt;
          chain.systemPrompt = a.systemPrompt; // 链式
        }
        if (a.message && typeof a.message.content === "string") {
          if (!out.messages) out.messages = [];
          out.messages.push({
            customType: a.message.customType ?? "integration.hook",
            content: a.message.content,
            display: a.message.display === true,
            ...(a.message.attribution ? { attribution: a.message.attribution } : {}),
          }); // 累积
        }
        break;
      }
      case "session_before_switch": {
        if (a.cancel === true) {
          out.cancel = true;
          return out; // 首个 cancel 终止
        }
        break;
      }
      case "session_before_branch": {
        if (a.cancel === true) {
          out.cancel = true;
          return out;
        }
        if (typeof a.skipConversationRestore === "boolean") out.skipConversationRestore = a.skipConversationRestore; // last wins
        break;
      }
      case "session_before_compact": {
        if (a.cancel === true) {
          out.cancel = true;
          return out;
        }
        if (a.compaction !== undefined) out.compaction = a.compaction; // last wins
        break;
      }
      case "session.compacting": {
        if (Array.isArray(a.context)) out.context = a.context.map(String);
        if (typeof a.prompt === "string") out.prompt = a.prompt;
        if (a.preserveData && typeof a.preserveData === "object") out.preserveData = a.preserveData;
        break;
      }
      case "session_before_tree": {
        if (a.cancel === true) {
          out.cancel = true;
          return out;
        }
        if (a.summary && typeof a.summary.summary === "string") out.summary = a.summary; // last wins
        break;
      }
      case "session_stop": {
        const isBlock = a.block === true || a.decision === "block";
        const ctx = a.additionalContext ?? a.reason;
        if ((a.continue === true || isBlock) && typeof ctx === "string" && ctx.trim()) {
          out.continue = true;
          out.additionalContext = ctx;
          return out; // 首个 non-empty actionable continuation 获胜
        }
        if (a.continue === true || isBlock) out.continue = true;
        break;
      }
      default:
        break;
    }
  }
  return touched ? out : null;
}

function appendCtx(prev: string | undefined, next: string, event: string, hookId: string): string {
  const tag = `[${event} ${hookId}]`;
  return prev ? `${prev}\n${tag} ${next}` : `${tag} ${next}`;
}

/** 网关侧通知快捷入口（审批请求/决策）。 */
export function notifyIntegrationHooks(
  ompSessionId: string | undefined,
  event: HookEventName,
  raw: Record<string, unknown>,
): void {
  if (!ompSessionId) return;
  void dispatchIntegrationHooks(ompSessionId, event, raw).catch(() => {});
}

// 安装桥实现（网关主体先于扩展加载；扩展实例复用本实现，不重复建 DB/缓存）
installBridgeDispatch(dispatchIntegrationHooks);
