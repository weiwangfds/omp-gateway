/**
 * KB 会话期合成（DESIGN §38.5，照 agent-compose 范式）：
 *
 * - 对每个 global/skills/kb-<slug>（含 kb.json），在 workspace `.omp/skills/kb-<slug>` 建
 *   junction（Windows 免特权）/ 符号链接（Linux）指向 skill 目录绝对路径——语料与脚本
 *   在工作区文件可达，agent 的 grep/read/bash 直接作用于该路径（不赌沙箱外可读）。
 *   注意：kb skill 本身经 loadSkillsFromDir 从 global/skills 注入 options.skills（omp SDK
 *   显式传 skills 时跳过项目级发现），junction 只为文件可达，不承担 skill 发现。
 * - manifest `.omp/skills/.kb-composed.json` 记账：KB 删除后下次建会话重算清理（stale）。
 * - 自管判定：workspace 里存在网关未管理的 kb-* 条目（非链接、且不含 kb.json）→ 整体跳过
 *   （会话自建/fork 来源混入的目录不碰）；「真目录但含 kb.json」视为网关管理——fork 拷贝
 *   （fs.cp 会把 junction 解引用成真目录）带着 kb.json，保留其快照内容，不强行重建链接。
 * - 语义与全局资源一致：变更对新会话生效，活跃会话保留原状。
 */
import * as fs from "node:fs/promises";
import path from "node:path";
import { globalSkillsDir } from "../paths.ts";

const MANIFEST = ".kb-composed.json";
const PREFIX = "kb-";
/** 网关管理的 kb skill 名规（kb-<slug>，slug 走 skill 名规）——不匹配的条目永不参与合成。 */
const KB_SKILL_NAME_RE = /^kb-[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * 边界守卫的 join：resolve 生成目标后校验必须落在根内
 * （target === root 或 target.startsWith(root + path.sep)）。
 * 条目名来自 readdir 且已过 KB_SKILL_NAME_RE 白名单，这里兜底防越界。
 */
function safeJoin(root: string, ...segments: string[]): string {
  const base = path.resolve(root);
  const target = path.resolve(base, ...segments);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`kb compose: path escapes managed directory: ${target}`);
  }
  return target;
}

/** global/skills/ 下的 KB skill 名清单（kb-<slug> 名规 + 含 kb.json；目录不存在返回空）。 */
async function listGlobalKbSkills(): Promise<string[]> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(globalSkillsDir());
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries.filter((n) => KB_SKILL_NAME_RE.test(n)).sort()) {
    try {
      const st = await fs.stat(safeJoin(globalSkillsDir(), name, "kb.json"));
      if (st.isFile()) out.push(name);
    } catch {}
  }
  return out; // 上游 entries 已 sort，构建顺序即字典序
}

/** workspace `.omp/skills/` 下的 kb-* 条目（目录/链接皆可；不存在返回空）。 */
async function listProjectKbEntries(projectDir: string): Promise<string[]> {
  try {
    return (await fs.readdir(projectDir)).filter((n) => n.startsWith(PREFIX)).sort();
  } catch {
    return [];
  }
}

/**
 * KB junction 合成（会话创建时执行——"对新会话生效"；无变化不落盘，避免触发 SDK 文件 watch）。
 */
export async function composeKbForWorkspace(workspaceDir: string): Promise<void> {
  const projectDir = path.join(workspaceDir, ".omp", "skills");
  const manifestPath = path.join(projectDir, MANIFEST);

  const existing = await listProjectKbEntries(projectDir);

  // 网关管理判定：符号链接，或真目录但含 kb.json（fork 拷贝把 junction 解引用成真目录）
  const isManaged = async (name: string): Promise<boolean> => {
    const st = await fs.lstat(safeJoin(projectDir, name)).catch(() => null);
    if (!st) return false;
    if (st.isSymbolicLink()) return true;
    if (!st.isDirectory()) return false;
    return fs
      .access(safeJoin(projectDir, name, "kb.json"))
      .then(() => true)
      .catch(() => false);
  };

  const managedFlags = await Promise.all(
    existing.map((n) => (KB_SKILL_NAME_RE.test(n) ? isManaged(n) : Promise.resolve(false))),
  );
  // 自管判定：存在网关未管理的 kb-* 条目 → 整体跳过（他人/会话自建的语料目录不碰）
  if (existing.some((_, i) => !managedFlags[i])) return;

  const desired = await listGlobalKbSkills();
  const managed = existing.filter((_, i) => managedFlags[i]);

  // 管理集中曾由网关合成、现已不在 desired 的（KB 被删）→ 清理残留链接/快照目录
  const stale = managed.filter((n) => !desired.includes(n));
  const target = globalSkillsDir();
  const linkType = process.platform === "win32" ? "junction" : "dir";
  let created = 0;

  const keep: string[] = [];
  if (desired.length || stale.length) await fs.mkdir(projectDir, { recursive: true });
  for (const name of stale) {
    await fs.rm(safeJoin(projectDir, name), { force: true, recursive: true });
  }
  for (const name of desired) {
    const dest = safeJoin(projectDir, name);
    const st = await fs.lstat(dest).catch(() => null);
    if (st && !st.isSymbolicLink()) {
      // fork 快照（真目录 + kb.json）：保留自含语料，不重建链接；仍记入 manifest 便于删除期清理
      keep.push(name);
      continue;
    }
    if (st) {
      const cur = await fs.readlink(dest).catch(() => null);
      if (cur && path.resolve(cur) === path.resolve(safeJoin(target, name))) {
        keep.push(name);
        continue;
      }
      await fs.rm(dest, { force: true }); // 链接指向过期（dataRoot 迁移等）→ 重建
    }
    await fs.symlink(safeJoin(target, name), dest, linkType);
    keep.push(name);
    created++;
  }

  if (!desired.length && !stale.length && !existing.length) return;

  if (!keep.length) {
    // 无留存条目 → 收走 manifest，目录留给潜在的自管使用（对齐 agent-compose）
    await fs.rm(manifestPath, { force: true });
    return;
  }
  const next = `${JSON.stringify({ managedBy: "omp-gateway", names: keep.sort() }, null, 2)}\n`;
  const prev = await fs.readFile(manifestPath, "utf8").catch(() => null);
  if (prev !== next) await fs.writeFile(manifestPath, next, "utf8");
  if (created > 0 || stale.length > 0) {
    // 合成动作留痕（不审计——建会话路径，日志即可）
    console.log(`[gateway] kb compose: ${workspaceDir} linked=${created} staleRemoved=${stale.length}`);
  }
}
