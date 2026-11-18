/**
 * workspace 的 .omp/agents/*.md 合成（对齐 MCP 合成语义，DESIGN §3）：
 * - 目录里有网关未管理的 *.md（会话自己写入/fork 来源混入）→ 视为自管，不碰
 * - 否则把全局 agents 逐名合成进 project 作用域；用户 agentDir/agents 同名者跳过
 *   （SDK 优先级 project > user，跳过即"用户同名覆盖全局"）
 * - 网关管理的文件记入 .gateway-composed.json manifest：fork 拷贝后仍可重算
 *   （全局更新/删除对新 workspace 生效），manifest 是 SDK 发现的惰性 dotfile。
 */
import path from "node:path";
import * as fs from "node:fs/promises";
import { globalAgentsDir, userAgentDir } from "./paths.ts";

const MANIFEST = ".gateway-composed.json";

/** 目录下的 agent 定义文件名（*.md，排除 manifest）；目录不存在返回空。 */
async function listAgentFiles(dir: string): Promise<string[]> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    if ((await fs.stat(path.join(dir, name)).catch(() => null))?.isFile()) out.push(name);
  }
  return out.sort();
}

/**
 * Agent 定义三方合成（对齐 composeMcpForWorkspace）：
 * 只在会话创建时执行——"对新会话生效"；内容无变化不落盘，避免触发 SDK 文件 watch。
 */
export async function composeAgentsForWorkspace(userId: string, workspaceDir: string): Promise<void> {
  const projectDir = path.join(workspaceDir, ".omp", "agents");
  const manifestPath = path.join(projectDir, MANIFEST);

  const existing = await listAgentFiles(projectDir);
  let managed: string[] = [];
  if (existing.length) {
    const manifest = await fs.readFile(manifestPath, "utf8").catch(() => null);
    let listed: unknown = null;
    try {
      listed = manifest ? (JSON.parse(manifest) as { files?: unknown }).files : null;
    } catch {}
    managed = Array.isArray(listed) ? listed.map(String).filter((f) => existing.includes(f)) : [];
    // 自管判定：存在网关未管理的 .md → 不碰（fork 来源的他人定义/会话自写文件）
    if (existing.some((f) => !managed.includes(f))) return;
  }

  const [globalFiles, userFiles] = await Promise.all([
    listAgentFiles(globalAgentsDir()),
    listAgentFiles(path.join(userAgentDir(userId), "agents")),
  ]);
  const userNames = new Set(userFiles.map((f) => f.replace(/\.md$/, "")));
  // 用户同名覆盖全局：跳过合成，SDK 由 user 作用域提供该定义
  const desired = globalFiles.filter((f) => !userNames.has(f.replace(/\.md$/, "")));

  // 管理集之外曾由网关合成、现已不在 desired 的（全局被删/被用户同名覆盖）→ 清理
  const stale = managed.filter((f) => !desired.includes(f));
  if (!desired.length && !stale.length && !existing.length) return;

  await fs.mkdir(projectDir, { recursive: true });
  for (const file of stale) await fs.rm(path.join(projectDir, file), { force: true });
  for (const file of desired) {
    // 内容对齐全局源：缺失或过期（fork 拷贝后全局已更新）都重写；一致时不落盘（避免触发 SDK watch）
    const src = path.join(globalAgentsDir(), file);
    const dest = path.join(projectDir, file);
    const [srcText, destText] = await Promise.all([
      fs.readFile(src, "utf8"),
      fs.readFile(dest, "utf8").catch(() => null),
    ]);
    if (srcText !== destText) await fs.writeFile(dest, srcText, "utf8");
  }
  if (!desired.length) {
    // 全局清空且无残留 → 收走 manifest，目录留给潜在的自管使用
    await fs.rm(manifestPath, { force: true });
    return;
  }
  const next = `${JSON.stringify({ managedBy: "omp-gateway", files: desired }, null, 2)}\n`;
  const prev = await fs.readFile(manifestPath, "utf8").catch(() => null);
  if (prev !== next) await fs.writeFile(manifestPath, next, "utf8");
}
