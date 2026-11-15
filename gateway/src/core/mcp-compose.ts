/**
 * workspace 的 .omp/mcp.json 合成（DESIGN §3，v3.1 修订）：
 * 项目已有自管配置（无网关标记）→ 不碰；否则写入 user > global 逐名去重的合成结果
 * （带网关标记）。内容无变化时不落盘，避免触发 SDK 的文件 watch。
 */
import path from "node:path";
import * as fs from "node:fs/promises";
import { globalMcpPath, userAgentDir } from "./paths.ts";

const GATEWAY_MARKER = "_managedBy";
const GATEWAY_NAME = "omp-gateway";

type McpConfig = { mcpServers?: Record<string, unknown>; [k: string]: unknown };

async function readJson(file: string): Promise<McpConfig | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as McpConfig;
  } catch {
    return null;
  }
}

/**
 * MCP 三方合成（DESIGN §3，v3.1 修订）：
 * - 项目已有自管 .omp/mcp.json（无网关标记）→ 不覆盖（M5 起改为 watch+refreshMCPTools）
 * - 否则写入 user > global 逐名去重后的合成文件（带网关标记）
 */
export async function composeMcpForWorkspace(userId: string, workspaceDir: string): Promise<void> {
  const projectPath = path.join(workspaceDir, ".omp", "mcp.json");

  const project = await readJson(projectPath);
  if (project && project[GATEWAY_MARKER] !== GATEWAY_NAME) {
    return; // 项目自管，网关不碰
  }

  const [globalCfg, userCfg] = await Promise.all([
    readJson(globalMcpPath()),
    readJson(path.join(userAgentDir(userId), "mcp.json")),
  ]);

  const merged: Record<string, unknown> = {
    ...(globalCfg?.mcpServers ?? {}),
    ...(userCfg?.mcpServers ?? {}), // 用户同名覆盖全局
  };

  const next: McpConfig = { [GATEWAY_MARKER]: GATEWAY_NAME, mcpServers: merged };
  const prev = project ? JSON.stringify(project) : null;
  if (prev === JSON.stringify(next)) return;

  await fs.mkdir(path.dirname(projectPath), { recursive: true });
  await fs.writeFile(projectPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}
