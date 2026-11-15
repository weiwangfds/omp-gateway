/**
 * SDK 桥·状态面：/state 一次拿全、/messages 直读、工具集读写、思考档位、stats、dump。
 * 数据全部实时取自 live 会话（未命中按 sessionFile 复活）。
 */
import type { Hono } from "hono";
import type { SdkEnv, SdkShared } from "./shared.ts";
import { audit } from "../../core/tenant-store.ts";

/** 状态面：/state 快照、/messages、工具集、思考档位、stats、dump。 */
export function mountStateRoutes(app: Hono<SdkEnv>, shared: SdkShared): void {
  const { live, jsonError, modelOf } = shared;

  // ---- 状态快照（一次拿全，Python 轮询/初始化用）----
  app.get("/:sid/state", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    const s = r.ctx.session as unknown as {
      thinkingLevel?: string | undefined;
      getAvailableThinkingLevels?: () => ReadonlyArray<string>;
      getAvailableEffortSelectors?: () => string[];
      getQueuedMessages?: () => { steering: readonly string[]; followUp: readonly string[]; liveSteered: number };
      queuedMessageCount?: number;
      getAllToolNames?: () => string[];
      getActiveToolNames?: () => string[];
      getContextUsage?: (o?: unknown) => unknown;
      messages?: unknown[];
    };
    let contextUsage: unknown = null;
    try {
      contextUsage = s.getContextUsage?.() ?? null;
    } catch {}
    return c.json({
      sessionId: r.row.id,
      title: r.row.title,
      status: r.ctx.streaming ? "streaming" : "idle",
      model: modelOf(r.ctx.session),
      thinkingLevel: s.thinkingLevel ?? null,
      availableThinkingLevels: s.getAvailableThinkingLevels?.() ?? [],
      effortSelectors: s.getAvailableEffortSelectors?.() ?? [],
      queue: s.getQueuedMessages
        ? { ...s.getQueuedMessages(), count: s.queuedMessageCount ?? 0 }
        : { steering: [], followUp: [], liveSteered: 0, count: 0 },
      tools: { active: s.getActiveToolNames?.() ?? [], all: s.getAllToolNames?.() ?? [] },
      contextUsage,
      messageCount: s.messages?.length ?? 0,
      sessionFile: r.row.session_file,
      workspaceId: r.row.workspace_id,
    });
  });

  // ---- 历史消息（SDK messages 直读；M1.2 版本返回原始 AgentMessage 结构）----
  app.get("/:sid/messages", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    const messages = (r.ctx.session as unknown as { messages: unknown[] }).messages ?? [];
    const since = Number(c.req.query("since") ?? 0);
    return c.json({
      total: messages.length,
      messages: since > 0 ? messages.slice(since) : messages,
    });
  });

  // ---- 运行时工具集 ----
  app.get("/:sid/tools", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    const s = r.ctx.session as unknown as { getActiveToolNames: () => string[]; getAllToolNames: () => string[] };
    return c.json({ active: s.getActiveToolNames(), all: s.getAllToolNames() });
  });

  app.put("/:sid/tools", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    const body = await c.req.json().catch(() => null as any);
    if (!Array.isArray(body?.active)) return jsonError(c, 400, "BAD_REQUEST", "body.active (string[]) required");
    const s = r.ctx.session as unknown as {
      setActiveToolsByName: (n: string[]) => Promise<void>;
      getActiveToolNames: () => string[];
    };
    await s.setActiveToolsByName(body.active.map(String));
    audit("session.set_tools", "session", r.row.id, c.get("userId"), { count: body.active.length });
    return c.json({ active: s.getActiveToolNames() });
  });

  // ---- 思考等级 ----
  app.get("/:sid/thinking", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    const s = r.ctx.session as unknown as {
      thinkingLevel?: string;
      getAvailableThinkingLevels: () => ReadonlyArray<string>;
      getAvailableEffortSelectors: () => string[];
    };
    return c.json({
      current: s.thinkingLevel ?? null,
      available: s.getAvailableThinkingLevels(),
      selectors: s.getAvailableEffortSelectors(),
    });
  });

  app.put("/:sid/thinking", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    const body = await c.req.json().catch(() => null as any);
    if (body?.level != null && typeof body.level !== "string") {
      return jsonError(c, 400, "BAD_REQUEST", "body.level must be a string or null");
    }
    const s = r.ctx.session as unknown as {
      setThinkingLevel: (l: string | undefined, persist?: boolean) => void;
      thinkingLevel?: string;
    };
    s.setThinkingLevel(body?.level ?? undefined, body?.persist === true);
    audit("session.set_thinking", "session", r.row.id, c.get("userId"), { level: body?.level ?? null });
    return c.json({ current: s.thinkingLevel ?? null });
  });

  // ---- 会话统计（SDK SessionStats 直出）----
  app.get("/:sid/stats", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    const stats = (r.ctx.session as unknown as { getSessionStats: () => unknown }).getSessionStats();
    return c.json(stats);
  });

  app.get("/:sid/dump", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    const text = (r.ctx.session as unknown as { formatSessionAsText: () => string }).formatSessionAsText();
    return c.json({ empty: text.length === 0, text });
  });
}
