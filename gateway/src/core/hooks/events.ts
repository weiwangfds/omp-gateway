/** 21 个可桥接事件清单（14 decide + 7 notify，对齐 docs/hooks）。 */
export const DECIDE_EVENTS = [
  "resources_discover",
  "input",
  "user_bash",
  "user_python",
  "tool_call",
  "tool_result",
  "context",
  "before_agent_start",
  "session_before_switch",
  "session_before_branch",
  "session_before_compact",
  "session.compacting",
  "session_before_tree",
  "session_stop",
] as const;

export const NOTIFY_EVENTS = [
  "session_start",
  "session_shutdown",
  "turn_end",
  "agent_end",
  "session_compact",
  "tool_approval_requested",
  "tool_approval_resolved",
] as const;

export type HookEventName = (typeof DECIDE_EVENTS)[number] | (typeof NOTIFY_EVENTS)[number];
export const HOOK_EVENTS: readonly HookEventName[] = [...DECIDE_EVENTS, ...NOTIFY_EVENTS];
export const DECIDE_EVENT_SET: ReadonlySet<string> = new Set(DECIDE_EVENTS);
