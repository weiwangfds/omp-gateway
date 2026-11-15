import * as fs from "node:fs/promises";
import path from "node:path";

/**
 * skill / plugin（extension）的目录级管理（DESIGN §18）。
 * 全局与用户两级共用：路由层传入各自目录并负责鉴权。
 * skill = <dir>/<name>/SKILL.md（非递归，native 布局）；plugin = <dir>/<name>.ts|.js。
 */

/** 管理操作的业务错误：code 与错误码契约（contracts/error-codes.md）对齐。 */
export class ManagementError extends Error {
  constructor(
    public code: "INVALID_NAME" | "NOT_FOUND" | "ALREADY_EXISTS",
    message: string,
  ) {
    super(message);
  }
}

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// 插件名含扩展名：名字本身就是文件名，限制字符集防穿越
const PLUGIN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(ts|js)$/;

/** skill 目录名校验，不合规则抛 ManagementError。 */
export function assertSkillName(name: string): void {
  if (!SKILL_NAME_RE.test(name))
    throw new ManagementError("INVALID_NAME", `skill name must match ${SKILL_NAME_RE.source}`);
}

/** 插件文件名校验（含 .ts/.js 扩展名），不合规则抛 ManagementError。 */
export function assertPluginName(name: string): void {
  if (!PLUGIN_NAME_RE.test(name))
    throw new ManagementError("INVALID_NAME", `plugin name must match ${PLUGIN_NAME_RE.source}`);
}

export interface ManagedSkill {
  name: string;
  description: string | null;
  updatedAt: string | null;
}

/** 扫描目录下的 skill（<name>/SKILL.md），按名排序；目录不存在返回空。 */
export async function listSkillsIn(dir: string): Promise<ManagedSkill[]> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: ManagedSkill[] = [];
  for (const name of entries) {
    const file = path.join(dir, name, "SKILL.md");
    try {
      const st = await fs.stat(file);
      if (!st.isFile()) continue;
      const raw = await fs.readFile(file, "utf8");
      const m = raw.match(/^description:\s*(.+)$/m);
      // 写入侧用 JSON 双引号标量（合法 YAML）；读取时剥掉引号还原纯文本
      let desc = m?.[1]?.trim() ?? null;
      if (desc && desc.length >= 2 && desc.startsWith('"') && desc.endsWith('"')) {
        try {
          desc = JSON.parse(desc) as string;
        } catch {}
      }
      out.push({ name, description: desc, updatedAt: st.mtime.toISOString() });
    } catch {}
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 写入/覆盖 skill（frontmatter name+description + 正文）。 */
export async function writeSkill(
  dir: string,
  name: string,
  body: { description: string; content?: string },
): Promise<void> {
  assertSkillName(name);
  const skillDir = path.join(dir, name);
  await fs.mkdir(skillDir, { recursive: true });
  const md = `---\nname: ${name}\ndescription: ${JSON.stringify(body.description.replace(/\n/g, " "))}\n---\n\n${body.content ?? ""}\n`;
  await fs.writeFile(path.join(skillDir, "SKILL.md"), md, "utf8");
}

/** 读 SKILL.md 原文；不存在返回 null。 */
export async function readSkill(dir: string, name: string): Promise<string | null> {
  assertSkillName(name);
  try {
    return await fs.readFile(path.join(dir, name, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
}

/** 删除 skill 目录；不存在返回 false。 */
export async function deleteSkill(dir: string, name: string): Promise<boolean> {
  assertSkillName(name);
  try {
    await fs.rm(path.join(dir, name), { recursive: true });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    return false;
  }
}

export interface ManagedPlugin {
  name: string;
  bytes: number;
  updatedAt: string | null;
}

/** 扫描目录下的插件（*.ts/*.js 单文件），按名排序。 */
export async function listPluginsIn(dir: string): Promise<ManagedPlugin[]> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: ManagedPlugin[] = [];
  for (const name of entries) {
    if (!/\.(ts|js)$/.test(name)) continue;
    try {
      const st = await fs.stat(path.join(dir, name));
      out.push({ name, bytes: st.size, updatedAt: st.mtime.toISOString() });
    } catch {}
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 写入/覆盖插件单文件（≤2MB），返回字节数。 */
export async function writePlugin(dir: string, name: string, content: string): Promise<{ bytes: number }> {
  assertPluginName(name);
  const buf = Buffer.from(content, "utf8");
  if (buf.length > 2 * 1024 * 1024) throw new ManagementError("INVALID_NAME", "plugin source exceeds 2MB");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), buf);
  return { bytes: buf.length };
}

/** 删除插件文件；不存在返回 false。 */
export async function deletePlugin(dir: string, name: string): Promise<boolean> {
  assertPluginName(name);
  try {
    await fs.rm(path.join(dir, name));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    return false;
  }
}
