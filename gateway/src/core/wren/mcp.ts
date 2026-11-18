/**
 * 全局 MCP 注册（DESIGN §39.2 步骤 6 + §40）：只管理 `wren-<name>` 键，其余 server
 * 一律保留；读写经 core/mcp-registry（进程内串行锁，避免与 qmd 注册互相覆盖）。
 */
import { globalMcpPath } from "../paths.ts";
import { removeMcpServers, upsertMcpServers } from "../mcp-registry.ts";
import { truncate } from "../proc.ts";
import { WREN_LOG } from "./env.ts";

/** wren MCP HTTP 端点路径（wren serve mcp --transport http，FastMCP streamable-http，实测 /mcp） */
export const MCP_PATH = "/mcp";

/**
 * 步骤 6：把 `wren-<name>` 注册进 global/mcp.json（幂等合并）。只管理自己的键
 * （wren-<name>），既有 server 一律保留；URL 变了（端口调整）才重写。
 */
export async function registerWrenMcpServers(specs: { name: string; port: number }[]): Promise<void> {
  if (specs.length === 0) return;
  const file = globalMcpPath();
  try {
    const entries: Record<string, unknown> = {};
    for (const spec of specs) {
      entries[`wren-${spec.name}`] = { type: "http", url: `http://127.0.0.1:${spec.port}${MCP_PATH}` };
    }
    const { written } = await upsertMcpServers(entries);
    if (!written) return;
    console.log(`${WREN_LOG} ${specs.map((s) => `wren-${s.name}`).join(",")} registered in ${file}`);
  } catch (err) {
    console.error(
      `${WREN_LOG} registerWrenMcpServers: ${truncate(String(err))}（写 global/mcp.json 失败，不阻塞启动）`,
    );
  }
}

/** 从 global/mcp.json 移除 `wren-<name>`（不存在则 no-op；其余 server 保留）。 */
export async function removeWrenMcpServer(name: string): Promise<void> {
  const { removed } = await removeMcpServers([`wren-${name}`]);
  if (removed.length > 0) console.log(`${WREN_LOG} wren-${name} removed from ${globalMcpPath()}`);
}
