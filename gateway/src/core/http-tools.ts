import type { CustomTool } from "@oh-my-pi/pi-coding-agent";
import { httpToolRowsForSession, type HttpToolRow } from "./tenant-store.ts";
import { hookSessionOf } from "./hook-engine.ts";
import { SIGNATURE_HEADER, signPayload } from "./signature.ts";

/**
 * 集成端 HTTP 工具（DESIGN §24）——SDK `customTools` 的 HTTP 形态：
 * 业务系统声明 {name, description, parameters(JSON Schema), url}，网关注册为 agent 工具；
 * 模型调用时网关 POST 到业务端点（HMAC 签名），把响应转成工具结果。
 *
 * 注入路径：
 * - 会话创建：`createAgentSession({ customTools })`（extension-owned，不被 MCP refresh 清掉）
 * - 运行期新增：`session.refreshMCPTools([...mcpTools, ...httpTools])`（manager-owned，需在 MCP reload 后重放）
 */

/** 内置工具名（禁止集成端覆盖）。 */
let builtinNames: Set<string> | null = null;
async function getBuiltinNames(): Promise<Set<string>> {
  if (builtinNames) return builtinNames;
  try {
    const mod = (await import("@oh-my-pi/pi-coding-agent")) as unknown as {
      BUILTIN_TOOLS?: Array<{ name?: string }> | Record<string, { name?: string }>;
    };
    const raw = mod.BUILTIN_TOOLS ?? [];
    const list = Array.isArray(raw) ? raw : Object.values(raw);
    builtinNames = new Set(list.map((t) => String(t?.name ?? "")).filter(Boolean));
  } catch {
    builtinNames = new Set();
  }
  return builtinNames;
}

export const HTTP_TOOL_NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;

/** 校验工具名（格式 + 不撞内置）。 */
export async function validateHttpToolName(name: string): Promise<string | null> {
  if (!HTTP_TOOL_NAME_RE.test(name)) return `name must match ${HTTP_TOOL_NAME_RE.source}`;
  const builtins = await getBuiltinNames();
  if (builtins.has(name)) return `name "${name}" collides with a builtin tool`;
  return null;
}

/** 工具结果响应归一化：支持 {content:[{type:"text",text}]} 或 {text}。 */
function toResult(
  json: unknown,
  ok: boolean,
  status: number,
): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  const j = (json ?? {}) as {
    content?: Array<{ type?: string; text?: string }>;
    text?: string;
    isError?: boolean;
    error?: unknown;
  };
  if (!ok) {
    const detail = typeof j.text === "string" ? j.text : JSON.stringify(j.error ?? j).slice(0, 2_000);
    return { content: [{ type: "text", text: `tool endpoint ${status}: ${detail}` }], isError: true };
  }
  if (Array.isArray(j.content)) {
    const content = j.content.map((b) => ({ type: "text" as const, text: String(b?.text ?? "") }));
    return {
      content: content.length ? content : [{ type: "text", text: "" }],
      ...(j.isError ? { isError: true } : {}),
    };
  }
  if (typeof j.text === "string") {
    return { content: [{ type: "text", text: j.text }], ...(j.isError ? { isError: true } : {}) };
  }
  return { content: [{ type: "text", text: JSON.stringify(json).slice(0, 8 * 1024) }] };
}

/** 把一行注册记录构造为 SDK CustomTool。 */
function toCustomTool(row: HttpToolRow, userId: string): CustomTool {
  const parameters = JSON.parse(row.parameters_json) as Record<string, unknown>;
  return {
    name: row.name,
    label: row.label,
    description: row.description,
    parameters,
    ...(row.approval ? { approval: row.approval as never } : {}),
    execute: async (toolCallId, params, _onUpdate, ctx) => {
      const ompId = (() => {
        try {
          return (ctx?.sessionManager as unknown as { getSessionId?: () => string } | undefined)?.getSessionId?.();
        } catch {
          return undefined;
        }
      })();
      const sid = ompId ? (hookSessionOf(ompId)?.sid ?? null) : null;
      const body = JSON.stringify({ toolCallId, name: row.name, args: params, sessionId: sid, userId });
      const sig = signPayload(row.secret, body);
      try {
        const res = await fetch(row.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [SIGNATURE_HEADER]: sig,
            "x-omp-tool": row.name,
            "x-omp-tool-call-id": toolCallId,
            ...(sid ? { "x-omp-session": sid } : {}),
          },
          body,
          signal: AbortSignal.timeout(Math.max(row.timeout_ms, 1_000)),
        });
        const json = await res.json().catch(() => null);
        return toResult(json, res.ok, res.status) as never;
      } catch (err) {
        return {
          content: [
            { type: "text", text: `tool endpoint unreachable: ${err instanceof Error ? err.message : String(err)}` },
          ],
          isError: true,
        } as never;
      }
    },
  };
}

/** 该用户在该会话可用的 HTTP 工具（用户级 + 会话级，同名会话级优先）。 */
export function buildHttpCustomTools(userId: string, sessionId?: string | null): CustomTool[] {
  try {
    return httpToolRowsForSession(userId, sessionId).map((row) => toCustomTool(row, userId));
  } catch {
    return [];
  }
}

/**
 * 热应用（运行期）：刷新会话的 manager-owned 工具集合 = 现有 MCP 工具 + HTTP 工具。
 * 注：MCP reload 后需重放（路由里已接）。
 */
export async function applyHttpToolsToSession(ctx: {
  session: unknown;
  mcpManager?: unknown;
  userId: string;
  sid?: string;
}): Promise<number> {
  const session = ctx.session as {
    refreshMCPTools?: (tools: CustomTool[]) => Promise<void>;
  };
  if (typeof session.refreshMCPTools !== "function") return 0;
  const mgr = ctx.mcpManager as { getTools?: () => CustomTool[] } | undefined;
  const mcpTools = (() => {
    try {
      return mgr?.getTools?.() ?? [];
    } catch {
      return [];
    }
  })();
  const httpTools = buildHttpCustomTools(ctx.userId, ctx.sid ?? null);
  await session.refreshMCPTools([...mcpTools, ...httpTools]);
  return httpTools.length;
}
