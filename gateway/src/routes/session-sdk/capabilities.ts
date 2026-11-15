/** SDK 桥·能力发现：tools info、skills（区分全部加载与系统提示列出）、MCP 明细/重连/资源、LSP。 */
import type { Hono } from "hono";
import type { SdkEnv, SdkShared } from "./shared.ts";
import { registry } from "../../core/session-registry.ts";
import { audit } from "../../core/tenant-store.ts";

/** 能力发现：tools info、skills、MCP（/servers/reload/resources）、LSP。 */
export function mountCapabilityRoutes(app: Hono<SdkEnv>, shared: SdkShared): void {
  const { live, jsonError, ownedSession } = shared;

  // 工具能力发现（DESIGN §25，对齐 docs/tools）：描述 + 参数名 + 来源（内置/MCP/自定义）
  app.get("/:sid/tools/info", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    const session = r.ctx.session as unknown as {
      getAllToolInfos?: () => Array<Record<string, any>>;
      getActiveToolNames?: () => string[];
      getAllToolNames?: () => string[];
    };
    const infos = (() => {
      try {
        return session.getAllToolInfos?.() ?? [];
      } catch {
        return [];
      }
    })();
    const active = new Set(session.getActiveToolNames?.() ?? []);
    return c.json({
      active: [...active],
      all: session.getAllToolNames?.() ?? [],
      tools: infos.map((t) => ({
        name: t.name,
        description: t.description,
        active: active.has(t.name),
        parameterNames: (() => {
          const props = (t.parameters as { properties?: Record<string, unknown> } | undefined)?.properties;
          return props ? Object.keys(props) : [];
        })(),
        requiredParameters: (() => {
          const req = (t.parameters as { required?: unknown } | undefined)?.required;
          return Array.isArray(req) ? req.map(String) : [];
        })(),
        source: (t.sourceInfo as any)?.kind ?? (t.sourceInfo as any)?.type ?? (t.mcpServerName ? "mcp" : "builtin"),
        ...(t.mcpServerName ? { mcpServerName: t.mcpServerName } : {}),
        ...(t.mcpToolName ? { mcpToolName: t.mcpToolName } : {}),
      })),
    });
  });

  // ---- 发现项列表（该会话可见的能力）----
  app.get("/:sid/skills", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    // 权威来源=会话已加载的 skills（discoverSkills 的 _agentDir 参数被 SDK 忽略，多租户下不可用）
    const session = r.ctx.session as unknown as {
      skills?: Array<Record<string, unknown>>;
      promptSkills?: Array<Record<string, unknown>>;
      skillWarnings?: unknown[];
      skillsSettings?: unknown;
    };
    const skills = session.skills ?? [];
    return c.json({
      skills,
      total: skills.length,
      // 网页需要区分：全部加载 vs 系统提示里列出的（manualSkills/hide 会让两者不同）
      promptSkills: (session.promptSkills ?? []).map((x) => String(x.name)),
      warnings: session.skillWarnings ?? [],
      settings: session.skillsSettings ?? null,
    });
  });

  app.get("/:sid/mcp", (c) => {
    const row = ownedSession(c.req.param("sid"), c.get("userId"));
    if (!row) return jsonError(c, 404, "NOT_FOUND", "session not found");
    const ctx = registry.get(row.id);
    const mgr = ctx?.mcpManager as
      | { getConnectedServers?: () => string[]; getTools?: () => Array<{ name?: string }> }
      | undefined;
    const tools = (() => {
      try {
        return (
          mgr
            ?.getTools?.()
            .map((t) => t.name)
            .filter(Boolean) ?? []
        );
      } catch {
        return [];
      }
    })();
    return c.json({
      connectedServers: mgr?.getConnectedServers?.() ?? [],
      tools,
      live: Boolean(ctx),
    });
  });

  // MCP 服务器明细（DESIGN §28，对齐 /mcp list + /mcp test）：逐服务器状态/传输/工具/资源
  app.get("/:sid/mcp/servers", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    const mgr = r.ctx.mcpManager as
      | {
          getAllServerNames?: () => string[];
          getConnectedServers?: () => string[];
          getConnectionStatus?: (n: string) => string;
          getServerConfig?: (n: string) => Record<string, any> | undefined;
          getSource?: (n: string) => unknown;
          getTools?: () => Array<{ name?: string; mcpServerName?: string; mcpToolName?: string }>;
          getServerResources?: (n: string) => unknown;
          getServerInstructions?: () => Map<string, string>;
        }
      | undefined;
    if (!mgr) return jsonError(c, 409, "MCP_DISABLED", "session has no MCP manager");
    const names = mgr.getAllServerNames?.() ?? mgr.getConnectedServers?.() ?? [];
    const tools = (() => {
      try {
        return mgr.getTools?.() ?? [];
      } catch {
        return [];
      }
    })();
    const instructions = (() => {
      try {
        return mgr.getServerInstructions?.() ?? new Map();
      } catch {
        return new Map();
      }
    })();
    return c.json({
      servers: names.map((name) => {
        const cfg = mgr.getServerConfig?.(name) ?? {};
        const serverTools = tools.filter((t) => t.mcpServerName === name);
        return {
          name,
          status: mgr.getConnectionStatus?.(name) ?? "unknown",
          transport: (cfg.type ?? cfg.url) ? (cfg.url ? (cfg.type ?? "http") : "stdio") : "stdio",
          command: cfg.command ?? null,
          url: cfg.url ?? null,
          enabled: cfg.enabled !== false,
          timeoutMs: cfg.timeout ?? null,
          source: mgr.getSource?.(name) ?? null,
          toolCount: serverTools.length,
          tools: serverTools.slice(0, 10).map((t) => t.mcpToolName ?? t.name),
          hasInstructions: instructions.has(name),
        };
      }),
      connected: mgr.getConnectedServers?.() ?? [],
    });
  });

  // 单服务器重连（/mcp reconnect <name>）
  app.post("/:sid/mcp/servers/:name/reconnect", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    const mgr = r.ctx.mcpManager as { reconnectServer?: (n: string, o?: unknown) => Promise<void> } | undefined;
    if (!mgr?.reconnectServer) return jsonError(c, 409, "MCP_DISABLED", "session has no MCP manager");
    const name = c.req.param("name");
    try {
      await mgr.reconnectServer(name);
      const session = r.ctx.session as unknown as { refreshMCPTools?: (t: unknown[]) => Promise<void> };
      const m2 = mgr as unknown as { getTools?: () => unknown[] };
      const { buildHttpCustomTools } = await import("../../core/http-tools.ts");
      await session.refreshMCPTools?.([...(m2.getTools?.() ?? []), ...buildHttpCustomTools(r.row.user_id, r.row.id)]);
      audit("session.mcp.reconnect", "session", r.row.id, c.get("userId"), { server: name });
      return c.json({ ok: true, server: name });
    } catch (err) {
      return jsonError(c, 409, "MCP_RECONNECT_FAILED", err instanceof Error ? err.message : String(err));
    }
  });

  // 单服务器资源（/mcp resources）
  app.get("/:sid/mcp/servers/:name/resources", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    const mgr = r.ctx.mcpManager as
      | {
          getServerResources?: (n: string) => unknown;
          refreshServerResources?: (n: string) => Promise<void>;
        }
      | undefined;
    if (!mgr?.getServerResources) return jsonError(c, 409, "MCP_DISABLED", "session has no MCP manager");
    const name = c.req.param("name");
    if (c.req.query("refresh") === "1" && mgr.refreshServerResources)
      await mgr.refreshServerResources(name).catch(() => {});
    return c.json({ server: name, resources: mgr.getServerResources(name) ?? [] });
  });

  // MCP reload（M8）：重新 reconcile 项目级 .omp/mcp.json + 刷新全部工具并同步到会话
  app.post("/:sid/mcp/reload", async (c) => {
    const row = ownedSession(c.req.param("sid"), c.get("userId"));
    if (!row) return jsonError(c, 404, "NOT_FOUND", "session not found");
    const ctx = registry.get(row.id);
    if (!ctx) return jsonError(c, 404, "NOT_FOUND", "session not live");
    const mgr = ctx.mcpManager as
      | {
          reconcileProjectConfig?: (enabled: boolean) => Promise<void>;
          refreshAllTools?: () => Promise<void>;
          getConnectedServers?: () => string[];
          getTools?: () => Array<{ name?: string }>;
        }
      | undefined;
    if (!mgr?.refreshAllTools) return jsonError(c, 409, "MCP_DISABLED", "session has no MCP manager");
    try {
      await mgr.reconcileProjectConfig?.(true); // 项目级 .omp/mcp.json 重新对账（用户级新会话生效，契约不变）
      await mgr.refreshAllTools();
      const session = ctx.session as unknown as { refreshMCPTools?: (tools: unknown[]) => Promise<void> };
      // 重放集成端 HTTP 工具（DESIGN §24）：refreshMCPTools 会替换 manager-owned 集合
      const { buildHttpCustomTools } = await import("../../core/http-tools.ts");
      const httpTools = buildHttpCustomTools(row.user_id, row.id);
      await session.refreshMCPTools?.([...(mgr.getTools?.() ?? []), ...httpTools]);
      audit("session.mcp.reload", "session", row.id, c.get("userId"));
      return c.json({
        ok: true,
        connectedServers: mgr.getConnectedServers?.() ?? [],
        tools: (mgr.getTools?.() ?? []).map((t) => t.name).filter(Boolean),
      });
    } catch (err) {
      return jsonError(c, 409, "MCP_RELOAD_FAILED", err instanceof Error ? err.message : String(err));
    }
  });

  app.get("/:sid/lsp", (c) => {
    const row = ownedSession(c.req.param("sid"), c.get("userId"));
    if (!row) return jsonError(c, 404, "NOT_FOUND", "session not found");
    const ctx = registry.get(row.id);
    return c.json({ servers: ctx?.lspServers ?? [], live: Boolean(ctx) });
  });
}
