/** 钩子回答/合并结果形状（扩展据此映射回 SDK 返回值）。 */
/** 集成端响应（所有事件字段的并集；按事件取用）。 */
export interface HookAnswer {
  /** "block" 仅 session_stop（官方 Claude/Codex 兼容写法） */
  decision?: "allow" | "deny" | "block";
  block?: boolean;
  reason?: string;
  handled?: boolean;
  text?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  details?: unknown;
  isError?: boolean;
  messages?: unknown[];
  systemPrompt?: string;
  message?: { customType?: string; content: string; display?: boolean; attribution?: "user" | "agent" | "system" };
  skillPaths?: string[];
  promptPaths?: string[];
  themePaths?: string[];
  cancel?: boolean;
  skipConversationRestore?: boolean;
  compaction?: unknown;
  context?: string[];
  prompt?: string;
  preserveData?: Record<string, unknown>;
  summary?: { summary: string; details?: unknown };
  continue?: boolean;
  additionalContext?: string;
  result?: unknown;
}

/** 合并后的结果（扩展据此返回 SDK 值）。 */
export interface HookOutcome extends HookAnswer {}
