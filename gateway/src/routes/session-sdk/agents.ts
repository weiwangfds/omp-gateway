/**
 * SDK 桥·Agent Hub（pi-web subagents 对标）：definitions、名册、transcript（限用户根内）、
 * chat（自动复活）、kill（tombstone）、revive（persisted reviver 重建）。
 */
import type { Hono } from "hono";
import type { SdkEnv, SdkShared } from "./shared.ts";
import type { Context } from "hono";
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent";
import * as fs from "node:fs/promises";
import path from "node:path";
import { userRoot } from "../../core/paths.ts";
import { registry, type SessionCtx } from "../../core/session-registry.ts";
import { audit } from "../../core/tenant-store.ts";

/** Agent Hub：definitions、名册、transcript、chat/kill/revive。 */
export function mountAgentRoutes(app: Hono<SdkEnv>, shared: SdkShared): void {
  const { live, jsonError, ownedSession } = shared;

  // ---- Agent Hub（pi-web subagents 对标；roster/transcript 先行，chat/kill/revive 随 task API）----
  const agentsOf = (ctx: SessionCtx): unknown[] => {
    const reg = ctx.agentRegistry as { list?: () => Array<Record<string, unknown>> } | undefined;
    return reg?.list?.().filter((a) => a.id !== MAIN_AGENT_ID) ?? [];
  };

  // Agent 定义（DESIGN §28，对齐 docs/agents-and-roles）：本会话可见定义 + 生效模型/工具
  app.get("/:sid/agents/definitions", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    const session = r.ctx.session as unknown as {
      getSessionAgents?: () => Array<Record<string, any>>;
      getAdvertisedSessionAgents?: () => Array<Record<string, any>>;
    };
    const safe = (fn: () => unknown) => {
      try {
        return fn() ?? [];
      } catch {
        return [];
      }
    };
    const all = (safe(() => session.getSessionAgents?.()) ?? []) as Array<Record<string, any>>;
    const advertised = new Set(
      ((safe(() => session.getAdvertisedSessionAgents?.()) ?? []) as Array<Record<string, any>>).map((a) =>
        String(a.name ?? ""),
      ),
    );
    return c.json({
      total: all.length,
      definitions: all.map((a) => ({
        name: a.name,
        description: a.description,
        advertised: advertised.has(String(a.name ?? "")), // 是否出现在系统提示/工具描述里
        tools: Array.isArray(a.tools) ? a.tools : null,
        model: a.model ?? null,
        thinkingLevel: a.thinkingLevel ?? null,
        spawns: a.spawns ?? null,
        blocking: a.blocking ?? null,
        prewalk: a.prewalk ?? null,
        advisor: a.advisor ?? null,
        hasOutputSchema: a.output !== undefined,
        instructionsChars: typeof a.systemPrompt === "string" ? a.systemPrompt.length : null,
        source: a.source ?? null,
      })),
    });
  });

  app.get("/:sid/agents", (c) => {
    const row = ownedSession(c.req.param("sid"), c.get("userId"));
    if (!row) return jsonError(c, 404, "NOT_FOUND", "session not found");
    const ctx = registry.get(row.id);
    return c.json({ agents: ctx ? agentsOf(ctx) : [], live: Boolean(ctx) });
  });

  app.get("/:sid/agents/:aid", (c) => {
    const row = ownedSession(c.req.param("sid"), c.get("userId"));
    if (!row) return jsonError(c, 404, "NOT_FOUND", "session not found");
    const ctx = registry.get(row.id);
    const reg = ctx?.agentRegistry as { get?: (id: string) => unknown } | undefined;
    const ref = reg?.get?.(c.req.param("aid"));
    return ref ? c.json(ref) : jsonError(c, 404, "NOT_FOUND", "agent not found");
  });

  // 子代理 transcript：AgentRef.sessionFile 指向其持久化 JSONL（限用户根内，≤4MB）
  app.get("/:sid/agents/:aid/transcript", async (c) => {
    const row = ownedSession(c.req.param("sid"), c.get("userId"));
    if (!row) return jsonError(c, 404, "NOT_FOUND", "session not found");
    const ctx = registry.get(row.id);
    const reg = ctx?.agentRegistry as { get?: (id: string) => { sessionFile?: string | null } | undefined } | undefined;
    const ref = reg?.get?.(c.req.param("aid"));
    const file = (ref as { sessionFile?: string | null } | undefined)?.sessionFile;
    if (!file) return jsonError(c, 404, "NOT_FOUND", "agent has no persisted transcript");
    const real = await fs.realpath(file).catch(() => null);
    const userRootReal = await fs.realpath(userRoot(c.get("userId"))).catch(() => null);
    if (!real || !userRootReal || !(real === userRootReal || real.startsWith(userRootReal + path.sep))) {
      return jsonError(c, 404, "NOT_FOUND", "transcript not accessible");
    }
    const buf = await fs.readFile(real).catch(() => null);
    if (!buf) return jsonError(c, 404, "NOT_FOUND", "transcript not found");
    return c.body(buf.subarray(0, 4 * 1024 * 1024).toString("utf8"), 200, {
      "content-type": "text/plain; charset=utf-8",
    });
  });

  // chat：AgentSessionHandle.prompt（流式中自动转 steer）；parked/killed 先经 revive 通道复活（M8）
  app.post("/:sid/agents/:aid/chat", async (c) => {
    const row = ownedSession(c.req.param("sid"), c.get("userId"));
    if (!row) return jsonError(c, 404, "NOT_FOUND", "session not found");
    const body = await c.req.json().catch(() => null as any);
    if (typeof body?.text !== "string" || !body.text) return jsonError(c, 400, "BAD_REQUEST", "body.text required");
    const ctx = registry.get(row.id);
    const reg = ctx?.agentRegistry as { get?: (id: string) => any } | undefined;
    let ref = reg?.get?.(c.req.param("aid"));
    if (!ref) return jsonError(c, 404, "NOT_FOUND", "agent not found");
    if (!ref.session) {
      const err = await reviveAgentRef(c, ctx, String(c.req.param("aid")));
      if (err) return err;
      ref = reg!.get!(c.req.param("aid"));
      if (!ref?.session) return jsonError(c, 409, "AGENT_NOT_LIVE", "agent could not be revived");
    }
    try {
      await ref.session.prompt(String(body.text));
      audit("agent.chat", "agent", c.req.param("aid"), c.get("userId"), { sessionId: row.id });
      return c.json({ ok: true }, 202);
    } catch (err) {
      return jsonError(c, 409, "AGENT_CHAT_FAILED", err instanceof Error ? err.message : String(err));
    }
  });

  // kill：中止在跑的 turn + 解绑 session + 名册标记 aborted（tombstone；transcript 留盘可复活）
  app.post("/:sid/agents/:aid/kill", async (c) => {
    const row = ownedSession(c.req.param("sid"), c.get("userId"));
    if (!row) return jsonError(c, 404, "NOT_FOUND", "session not found");
    const ctx = registry.get(row.id);
    const reg = ctx?.agentRegistry as
      | {
          get?: (id: string) => any;
          setStatus?: (id: string, s: string, expected?: unknown) => boolean;
          detachSession?: (id: string, expected?: unknown) => boolean;
        }
      | undefined;
    const ref = reg?.get?.(c.req.param("aid"));
    if (!ref) return jsonError(c, 404, "NOT_FOUND", "agent not found");
    try {
      await ref.session?.abort?.();
    } catch {}
    const detached = reg?.detachSession?.(c.req.param("aid"), ref) ?? false;
    const ok = reg?.setStatus?.(c.req.param("aid"), "aborted", ref) ?? false;
    audit("agent.kill", "agent", c.req.param("aid"), c.get("userId"), { sessionId: row.id, detached });
    return c.json({ ok: true, statusMarked: ok, detached });
  });

  // revive：持久化子代理复活（M8）——ref（含 sessionFile）经 persisted reviver factory 从
  // session_init 忠实重建（tools/system prompt/depth 门控与 executor 一致），绑回私有名册。
  app.post("/:sid/agents/:aid/revive", async (c) => {
    const row = ownedSession(c.req.param("sid"), c.get("userId"));
    if (!row) return jsonError(c, 404, "NOT_FOUND", "session not found");
    const ctx = registry.get(row.id);
    const ref = (ctx?.agentRegistry as { get?: (id: string) => unknown } | undefined)?.get?.(c.req.param("aid"));
    if (!ref) return jsonError(c, 404, "NOT_FOUND", "agent not found");
    if ((ref as { session?: unknown }).session) return jsonError(c, 409, "AGENT_ALREADY_LIVE", "agent is already live");
    const err = await reviveAgentRef(c, ctx, c.req.param("aid"));
    if (err) return err;
    const updated = (ctx!.agentRegistry as { get?: (id: string) => unknown }).get!(c.req.param("aid"));
    return c.json(updated);
  });

  /** revive 共享路径：经 persistedReviverFactory 重建并绑回名册；成功返回 null，失败返回 jsonError。 */
  async function reviveAgentRef(c: Context, ctx: SessionCtx | undefined, aid: string): Promise<Response | null> {
    if (!ctx) return jsonError(c, 404, "NOT_FOUND", "session not live");
    const factory = ctx.persistedReviverFactory;
    if (!factory) return jsonError(c, 409, "NOT_REVIVABLE", "reviver unavailable (session disposed or init failed)");
    const reg = ctx.agentRegistry as { get?: (id: string) => any } | undefined;
    const ref = reg?.get?.(aid);
    if (!ref) return jsonError(c, 404, "NOT_FOUND", "agent not found");
    if (!ref.sessionFile) return jsonError(c, 409, "NOT_REVIVABLE", "agent has no persisted transcript");
    try {
      const reviver = await factory(ref);
      if (!reviver) {
        return jsonError(
          c,
          409,
          "NOT_REVIVABLE",
          "ref cannot be faithfully rebuilt (no persisted session contract or workspace gone)",
        );
      }
      await reviver(ref); // 重建会话并同步注册表状态（registry status sync）
      return null;
    } catch (err) {
      return jsonError(c, 409, "REVIVE_FAILED", err instanceof Error ? err.message : String(err));
    }
  }
}
