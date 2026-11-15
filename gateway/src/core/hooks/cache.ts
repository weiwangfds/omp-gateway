/** 钩子订阅缓存 + 匹配 + 事件载荷提取（DESIGN §23）。 */
import { listIntegrationHooksForDispatch, type IntegrationHookRow } from "../tenant-store.ts";
import type { HookEventName } from "./events.ts";

const hookCache = new Map<string, { rows: IntegrationHookRow[]; at: number }>();
const HOOK_TTL_MS = 10_000;

/** 取该用户+会话+事件的启用订阅（10s TTL 缓存，路由注册后无需重启）。 */
export function hooksFor(userId: string, sessionId: string, event: string): IntegrationHookRow[] {
  const key = `${userId}\0${sessionId}\0${event}`;
  const cached = hookCache.get(key);
  if (cached && Date.now() - cached.at < HOOK_TTL_MS) return cached.rows;
  const rows = listIntegrationHooksForDispatch(userId, sessionId, event);
  hookCache.set(key, { rows, at: Date.now() });
  return rows;
}

/** 注册/注销钩子后失效缓存（下次分发重新查库）。 */
export function invalidateHookEngineCache(userId: string): void {
  for (const key of hookCache.keys()) if (key.startsWith(`${userId}\0`)) hookCache.delete(key);
}

/** matcher_json 匹配：无 matcher 全命中；对象键做深度包含比较。 */
export function matches(row: IntegrationHookRow, payload: Record<string, unknown>): boolean {
  if (!row.matcher_json) return true;
  let matcher: { tool?: string | string[] };
  try {
    matcher = JSON.parse(row.matcher_json);
  } catch {
    return true;
  }
  const tool = typeof payload.toolName === "string" ? payload.toolName : undefined;
  if (!matcher.tool || !tool) return true;
  const list = Array.isArray(matcher.tool) ? matcher.tool : matcher.tool.split("|").map((s) => s.trim());
  return list.includes(tool);
}

const textOf = (content: unknown): string =>
  (Array.isArray(content) ? content : [])
    .map((b) =>
      b && typeof b === "object" && (b as { type?: string }).type === "text"
        ? String((b as { text?: string }).text ?? "")
        : "",
    )
    .join("\n");

/** 回调载荷提取（chain 覆盖 = 链式语义：后续钩子看到前面的改动）。 */
/** 构造回调载荷：base 事件字段 + chain（链式语义：后续钩子看到前面钩子的改动）。 */
export function payloadFor(
  event: HookEventName,
  sid: string,
  raw: Record<string, any>,
  chain: Record<string, unknown>,
): Record<string, unknown> {
  const base: Record<string, unknown> = { event, sessionId: sid, ts: Date.now() };
  switch (event) {
    case "resources_discover":
      return { ...base, cwd: raw.cwd, reason: raw.reason };
    case "input":
      return {
        ...base,
        text: typeof chain.text === "string" ? chain.text : String(raw.text ?? ""),
        source: raw.source,
        imageCount: Array.isArray(raw.images) ? raw.images.length : 0,
      };
    case "user_bash":
      return { ...base, command: raw.command, cwd: raw.cwd, excludeFromContext: raw.excludeFromContext };
    case "user_python":
      return { ...base, code: raw.code, cwd: raw.cwd, excludeFromContext: raw.excludeFromContext };
    case "tool_call":
      return {
        ...base,
        toolName: raw.toolName,
        toolCallId: raw.toolCallId,
        input: chain.input ?? raw.input,
      };
    case "tool_result": {
      const content = chain.content ?? raw.content;
      return {
        ...base,
        toolName: raw.toolName,
        toolCallId: raw.toolCallId,
        input: raw.input,
        text: textOf(content).slice(0, 8 * 1024),
        isError: typeof chain.isError === "boolean" ? chain.isError : raw.isError === true,
        contentTypes: (Array.isArray(content) ? content : []).map((b) =>
          b && typeof b === "object" ? ((b as { type?: string }).type ?? "unknown") : "unknown",
        ),
      };
    }
    case "context":
      return {
        ...base,
        messageCount: Array.isArray(chain.messages ?? raw.messages) ? (chain.messages ?? raw.messages).length : 0,
        messages: chain.messages ?? raw.messages,
      };
    case "before_agent_start":
      return {
        ...base,
        prompt: raw.prompt,
        systemPrompt: chain.systemPrompt ?? raw.systemPrompt,
        imageCount: Array.isArray(raw.images) ? raw.images.length : 0,
      };
    case "session_before_switch":
      return { ...base, reason: raw.reason, targetSessionFile: raw.targetSessionFile };
    case "session_before_branch":
      return { ...base, entryId: raw.entryId, reason: raw.reason };
    case "session_before_compact":
      return { ...base, customInstructions: raw.customInstructions };
    case "session.compacting":
      return { ...base, sessionId: raw.sessionId, messageCount: Array.isArray(raw.messages) ? raw.messages.length : 0 };
    case "session_before_tree": {
      const prep = raw.preparation as { targetId?: string; userWantsSummary?: boolean } | undefined;
      return { ...base, targetId: prep?.targetId, userWantsSummary: prep?.userWantsSummary === true };
    }
    case "session_stop": {
      const last = raw.last_assistant_message as { content?: Array<{ type?: string; text?: string }> } | undefined;
      return {
        ...base,
        turnId: raw.turn_id,
        stopHookActive: raw.stop_hook_active === true,
        lastText: textOf(last?.content).slice(0, 4 * 1024),
      };
    }
    case "turn_end": {
      const msg = raw.message as { role?: string; usage?: unknown; stopReason?: string } | undefined;
      return { ...base, turnIndex: raw.turnIndex, role: msg?.role, stopReason: msg?.stopReason, usage: msg?.usage };
    }
    case "agent_end":
      return { ...base, willContinue: raw.willContinue === true };
    case "tool_approval_requested":
      return { ...base, approvalId: raw.approvalId, tool: raw.tool, args: raw.args, timeoutSec: raw.timeoutSec };
    case "tool_approval_resolved":
      return { ...base, approvalId: raw.approvalId, approved: raw.approved === true, reason: raw.reason };
    default:
      return base;
  }
}
