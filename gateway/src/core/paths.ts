/**
 * 数据目录布局与路径编解码（DESIGN §2 / §32）。
 *
 * 目录约定：`<dataRoot>/global/`（全局 skills/extensions/mcp）与 `<dataRoot>/users/<uid>/`
 * （agent/ 会话目录、sessions/、snapshots/、workspaces/、trash/）。
 * 会话与 workspace 一一对应（workspace id = 会话 id）。
 *
 * 路径编解码（INV-1）：DB 记录指向文件时存相对 dataRoot 的 POSIX 路径，
 * 读取时经 fromStorePath 解析——dataRoot 整体迁移后记录无需改写。
 */
import * as fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.ts";

export const globalDir = () => path.join(config.dataRoot, "global");
export const globalMcpPath = () => path.join(globalDir(), "mcp.json");
export const globalSkillsDir = () => path.join(globalDir(), "skills");
export const globalExtensionsDir = () => path.join(globalDir(), "extensions");
export const globalAgentsDir = () => path.join(globalDir(), "agents");
/** KB 元数据库目录（DESIGN §38.2）：每个知识库一个 <slug>.db。 */
export const globalKbDir = () => path.join(globalDir(), "kb");

/** 用户数据根：`<dataRoot>/users/<uid>`（agentDir、会话、workspace 均在其下）。 */
export const userRoot = (uid: string) => path.join(config.dataRoot, "users", uid);
export const userAgentDir = (uid: string) => path.join(userRoot(uid), "agent");
export const userSessionsDir = (uid: string) => path.join(userRoot(uid), "sessions");
export const userSnapshotsDir = (uid: string) => path.join(userRoot(uid), "snapshots");
export const userWorkspacesDir = (uid: string) => path.join(userRoot(uid), "workspaces");
export const userTrashDir = (uid: string) => path.join(userRoot(uid), "trash");

/** 会话的 workspace 目录（1:1：wsid 即会话 id）。 */
export const userWorkspace = (uid: string, wsid: string) => path.join(userWorkspacesDir(uid), wsid);

/** 用户私有扩展目录（agent/extensions，DESIGN §3 用户级插件）。 */
export const userExtensionsDir = (uid: string) => path.join(userAgentDir(uid), "extensions");

/** 绝对路径 → DB 存储的相对路径。越出 dataRoot 视为程序错误（路径全部由网关自己生成）。 */
export function toStorePath(absPath: string): string {
  const rel = path.relative(config.dataRoot, absPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes data root: ${absPath}`);
  }
  return rel.split(path.sep).join("/");
}

/**
 * DB 存储路径 → 当前绝对路径。
 * 绝对输入原样返回：schema v1 之前的旧库未迁移时仍可读。
 */
export function fromStorePath(stored: string): string {
  if (path.isAbsolute(stored)) return stored;
  return path.join(config.dataRoot, ...stored.split("/"));
}

/** 全局共享目录骨架（首次启动；mcp.json 缺省为空配置）。 */
export async function ensureGlobalScaffold(): Promise<void> {
  await Promise.all([
    fs.mkdir(globalSkillsDir(), { recursive: true }),
    fs.mkdir(globalExtensionsDir(), { recursive: true }),
    fs.mkdir(globalAgentsDir(), { recursive: true }),
    fs.mkdir(globalKbDir(), { recursive: true }),
  ]);
  if (!(await fs.exists(globalMcpPath()))) {
    await Bun.write(globalMcpPath(), `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
  }
}

/** 用户目录骨架（懒 provision，幂等；POST /internal/users/:uid/provision 与首个请求都会触发）。 */
export async function ensureUserScaffold(uid: string): Promise<void> {
  const dirs = [
    userAgentDir(uid),
    path.join(userAgentDir(uid), "skills"),
    path.join(userAgentDir(uid), "extensions"),
    userSessionsDir(uid),
    userSnapshotsDir(uid),
    userWorkspacesDir(uid),
    userTrashDir(uid),
  ];
  await Promise.all(dirs.map((d) => fs.mkdir(d, { recursive: true })));
}
