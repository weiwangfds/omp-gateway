/** MCP 用户级开关（docs/mcp）：disabledServers 优先级最高，写入 agent/mcp.json。 */
import type { Hono } from "hono";
import * as fs from "node:fs/promises";
import path from "node:path";
import { userAgentDir } from "../../core/paths.ts";
import { audit } from "../../core/tenant-store.ts";
import type { AgentConfigEnv } from "./env.ts";

/** MCP 用户级开关：disabledServers 优先级最高（即使来自导入配置）。 */
export function mountMcpSettingsRoutes(app: Hono<AgentConfigEnv>): void {
  // ---- MCP 用户级设置（docs/mcp：disabledServers 优先级最高）----

  const userMcpPath = (uid: string) => path.join(userAgentDir(uid), "mcp.json");

  async function readMcpJson(uid: string): Promise<Record<string, any>> {
    const raw = await fs.readFile(userMcpPath(uid), "utf8").catch(() => "");
    if (!raw.trim()) return { mcpServers: {} };
    try {
      return JSON.parse(raw) as Record<string, any>;
    } catch {
      return { mcpServers: {}, __parseError: true };
    }
  }

  app.get("/me/mcp/settings", async (c) => {
    const uid = c.get("userId");
    const cfg = await readMcpJson(uid);
    return c.json({
      disabledServers: Array.isArray(cfg.disabledServers) ? cfg.disabledServers : [],
      enabledServers: Array.isArray(cfg.enabledServers) ? cfg.enabledServers : [],
      serverCount: Object.keys(cfg.mcpServers ?? {}).length,
      note: "disabledServers 优先级最高（即使来自导入配置也会被禁用）；变更对后续会话/MCP reload 生效",
      ...(cfg.__parseError ? { warning: "mcp.json 解析失败（语法错误），请修正后再改设置" } : {}),
    });
  });

  app.put("/me/mcp/settings", async (c) => {
    const uid = c.get("userId");
    const body = await c.req.json().catch(() => null as any);
    if (body?.disabledServers === undefined && body?.enabledServers === undefined) {
      return c.json({ error: { code: "BAD_REQUEST", message: "disabledServers and/or enabledServers required" } }, 400);
    }
    const cfg = await readMcpJson(uid);
    if (cfg.__parseError) {
      return c.json({ error: { code: "INVALID_JSON", message: "mcp.json has a syntax error; fix it first" } }, 400);
    }
    const clean = (v: unknown): string[] | undefined => {
      if (v === undefined) return undefined;
      if (!Array.isArray(v)) throw new Error("must be string[]");
      return v.map(String).filter((s) => s.trim());
    };
    try {
      const d = clean(body?.disabledServers);
      const e = clean(body?.enabledServers);
      if (d !== undefined) cfg.disabledServers = d;
      if (e !== undefined) cfg.enabledServers = e;
    } catch (err) {
      return c.json(
        {
          error: { code: "BAD_REQUEST", message: `disabledServers/enabledServers: ${String((err as Error).message)}` },
        },
        400,
      );
    }
    await fs.mkdir(path.dirname(userMcpPath(uid)), { recursive: true });
    await fs.writeFile(userMcpPath(uid), `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
    const { reloadUserContext } = await import("../../core/user-context.ts");
    await reloadUserContext(uid);
    audit("config.mcp_settings", "user", uid, uid, { disabled: cfg.disabledServers, enabled: cfg.enabledServers });
    return c.json({
      ok: true,
      disabledServers: cfg.disabledServers ?? [],
      enabledServers: cfg.enabledServers ?? [],
      note: "对后续会话/MCP reload 生效",
    });
  });
}
