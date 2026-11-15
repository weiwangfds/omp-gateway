import * as fs from "node:fs/promises";
import path from "node:path";

/**
 * workspace 文件服务（DESIGN §17）：VS Code 式文件树/读写/搜索/预览。
 *
 * 安全边界：所有路径入口都经 resolveInside（词法前缀 + realpath 符号链接双重守卫），
 * 大小限制集中在常量（读 2MB / 写 5MB / raw 流 25MB）；错误以 FileGuardError 与
 * 特定 message（FILE_TOO_LARGE 等）抛出，由路由层映射 HTTP 状态。
 */

/** 路径越界（穿越、绝对路径、符号链接逃逸）的统一异常。 */
export class FileGuardError extends Error {
  constructor(public rel: string) {
    super(`path escapes workspace: ${rel}`);
  }
}

/** 把相对路径安全解析进 workspace 内；跨目录符号链接（realpath 逃逸）同样拒绝。 */
export async function resolveInside(workspaceDir: string, rel: string): Promise<string> {
  if (typeof rel !== "string" || rel.length === 0 || rel.includes("\0")) throw new FileGuardError(String(rel));
  const ws = path.resolve(workspaceDir);
  const abs = path.resolve(ws, rel);
  if (abs !== ws && !abs.startsWith(ws + path.sep)) throw new FileGuardError(rel);
  // 符号链接逃逸检查：对已存在的最长祖先取 realpath 校验前缀；
  // workspace 根尚不存在（首写场景）时降级为词法校验
  let probe = abs;
  let rootReal: string;
  try {
    rootReal = await fs.realpath(ws);
  } catch {
    rootReal = ws;
  }
  while (true) {
    try {
      const real = await fs.realpath(probe);
      if (real !== rootReal && !real.startsWith(rootReal + path.sep)) throw new FileGuardError(rel);
      break; // 已存在的最深祖先在界内
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // 整条链到 ws 都不存在：无既有符号链接可查，词法校验已通过
        if (probe === ws) break;
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
        continue;
      }
      if ((err as NodeJS.ErrnoException).code === "EINVAL") break; // Windows 盘符根等边界
      throw err;
    }
  }
  return abs;
}

export const DEFAULT_SKIP = new Set([".git", "node_modules"]);

export interface TreeEntry {
  name: string;
  type: "file" | "dir";
  size?: number;
}

export interface TreeOptions {
  subPath?: string;
  depth?: number; // 默认 3，最大 8
  maxEntries?: number; // 默认 2000
  includeHeavy?: boolean; // 包含 .git/node_modules
}

/** 目录树（BFS，dirs-first 排序；条目数/深度双上限，防止大仓库拖垮网关）。 */
export async function listTree(
  workspaceDir: string,
  opts: TreeOptions = {},
): Promise<{ path: string; entries: TreeEntry[]; truncated: boolean }> {
  const depth = Math.min(Math.max(opts.depth ?? 3, 1), 8);
  const maxEntries = Math.min(opts.maxEntries ?? 2000, 10000);
  const skip = opts.includeHeavy ? new Set<string>() : DEFAULT_SKIP;
  const startAbs = await resolveInside(workspaceDir, opts.subPath ?? ".");
  const baseRel = path.relative(workspaceDir, startAbs).replace(/\\/g, "/");

  const out: TreeEntry[] = [];
  let truncated = false;
  let queue: Array<{ abs: string; rel: string; d: number }> = [
    { abs: startAbs, rel: baseRel === "" ? "" : baseRel, d: 0 },
  ];
  while (queue.length) {
    const { abs, rel, d } = queue.shift()!;
    let dirents: Array<import("node:fs").Dirent>;
    try {
      dirents = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    const sorted = dirents.sort((a, b) =>
      a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1,
    );
    for (const de of sorted) {
      if (out.length >= maxEntries) {
        truncated = true;
        queue = [];
        break;
      }
      if (de.isDirectory()) {
        if (skip.has(de.name)) continue;
        out.push({ name: de.name, type: "dir" });
        if (d + 1 < depth)
          queue.push({ abs: path.join(abs, de.name), rel: rel ? `${rel}/${de.name}` : de.name, d: d + 1 });
      } else if (de.isFile()) {
        let size: number | undefined;
        try {
          size = (await fs.stat(path.join(abs, de.name))).size;
        } catch {}
        out.push({ name: de.name, type: "file", size });
      }
    }
  }
  return { path: baseRel, entries: out, truncated };
}

export const MAX_READ_BYTES = 2 * 1024 * 1024; // 2MB
export const MAX_WRITE_BYTES = 5 * 1024 * 1024; // 5MB

export interface FileContent {
  encoding: "utf8" | "base64";
  content: string;
  size: number;
}

function isBinary(buf: Buffer): boolean {
  const probe = buf.subarray(0, 8192);
  return probe.includes(0);
}

/** 读文本文件（≤2MB），返回内容与字节数。 */
export async function readFileContent(workspaceDir: string, rel: string): Promise<FileContent> {
  const abs = await resolveInside(workspaceDir, rel);
  const st = await fs.stat(abs);
  if (st.isDirectory()) throw new Error("IS_DIRECTORY");
  if (st.size > MAX_READ_BYTES) throw new Error("FILE_TOO_LARGE");
  const buf = await fs.readFile(abs);
  if (isBinary(buf)) return { encoding: "base64", content: buf.toString("base64"), size: st.size };
  return { encoding: "utf8", content: buf.toString("utf8"), size: st.size };
}

/** 写文本文件（utf8/base64，≤5MB），写前 resolveInside 守卫。 */
export async function writeFileContent(
  workspaceDir: string,
  rel: string,
  content: string,
  encoding: "utf8" | "base64" = "utf8",
): Promise<{ size: number }> {
  if (encoding === "base64" ? content.length * 0.75 > MAX_WRITE_BYTES : Buffer.byteLength(content) > MAX_WRITE_BYTES) {
    throw new Error("FILE_TOO_LARGE");
  }
  const abs = await resolveInside(workspaceDir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const buf = encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
  await fs.writeFile(abs, buf);
  return { size: buf.length };
}

/** 建目录（递归）。 */
export async function makeDir(workspaceDir: string, rel: string): Promise<void> {
  const abs = await resolveInside(workspaceDir, rel);
  await fs.mkdir(abs, { recursive: true });
}

/** 重命名/移动（源与目标都过守卫）。 */
export async function renamePath(workspaceDir: string, from: string, to: string): Promise<void> {
  const absFrom = await resolveInside(workspaceDir, from);
  const absTo = await resolveInside(workspaceDir, to);
  await fs.mkdir(path.dirname(absTo), { recursive: true });
  await fs.rename(absFrom, absTo);
}

/** 删除文件或目录（递归）。 */
export async function removePath(workspaceDir: string, rel: string): Promise<void> {
  const abs = await resolveInside(workspaceDir, rel);
  // workspace 根本身不可删
  if (path.resolve(abs) === path.resolve(workspaceDir)) throw new FileGuardError(rel);
  await fs.rm(abs, { recursive: true, force: true });
}

/** 写二进制（上传用，≤5MB），返回字节数。 */
export async function writeFileBuffer(workspaceDir: string, rel: string, buf: Buffer): Promise<{ size: number }> {
  if (buf.length > MAX_WRITE_BYTES) throw new Error("FILE_TOO_LARGE");
  const abs = await resolveInside(workspaceDir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, buf);
  return { size: buf.length };
}

// ---- 文件扁平索引（pi-web file-index 对标：Ctrl+P 式模糊查找）----

interface IndexEntry {
  paths: string[];
  builtAt: number;
}
const INDEX_TTL_MS = 30_000;
const indexCache = new Map<string, IndexEntry>();
const INDEX_SKIP = new Set([...DEFAULT_SKIP, "dist", "build", "coverage", ".next", ".cache", "exports"]);
const INDEX_MAX = 20_000;

/** 文件变更后丢弃索引缓存（下次查询重建）。 */
export function invalidateFileIndex(workspaceDir: string): void {
  indexCache.delete(path.resolve(workspaceDir));
}

async function walkIndex(absDir: string, relBase: string, out: string[], budget: { left: number }): Promise<void> {
  if (budget.left <= 0) return;
  let dirents: Array<import("node:fs").Dirent>;
  try {
    dirents = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const de of dirents) {
    if (budget.left <= 0) return;
    if (de.isDirectory()) {
      if (INDEX_SKIP.has(de.name)) continue;
      await walkIndex(path.join(absDir, de.name), relBase ? `${relBase}/${de.name}` : de.name, out, budget);
    } else if (de.isFile()) {
      out.push(relBase ? `${relBase}/${de.name}` : de.name);
      budget.left--;
    }
  }
}

/** 构建/复用文件索引（带条目预算，防大仓库长扫描）。 */
export async function buildFileIndex(workspaceDir: string, opts: { force?: boolean } = {}): Promise<IndexEntry> {
  const key = path.resolve(workspaceDir);
  const cached = indexCache.get(key);
  if (!opts.force && cached && Date.now() - cached.builtAt < INDEX_TTL_MS) return cached;
  const paths: string[] = [];
  await walkIndex(key, "", paths, { left: INDEX_MAX });
  const entry = { paths, builtAt: Date.now() };
  indexCache.set(key, entry);
  return entry;
}

/** 简单打分：前缀 > 子串 > 子序列；全部大小写不敏感。 */
function scoreMatch(p: string, q: string): number {
  const lp = p.toLowerCase();
  if (lp.startsWith(q)) return 0;
  const idx = lp.indexOf(q);
  if (idx >= 0) return 1 + Math.min(idx / 100, 0.9);
  // 子序列
  let i = 0;
  for (const ch of lp) if (ch === q[i]) i++;
  return i === q.length ? 2 : -1;
}

/** 按名模糊查询索引（限流在调用方）。 */
export async function queryFileIndex(
  workspaceDir: string,
  q: string | undefined,
  opts: { limit?: number; force?: boolean } = {},
): Promise<{ total: number; paths: string[]; truncated: boolean; cachedAt: number }> {
  const { paths, builtAt } = await buildFileIndex(workspaceDir, opts);
  const limit = Math.min(opts.limit ?? 200, 1000);
  if (!q) {
    return { total: paths.length, paths: paths.slice(0, limit), truncated: paths.length > limit, cachedAt: builtAt };
  }
  const lq = q.toLowerCase();
  const scored: Array<{ p: string; s: number }> = [];
  for (const p of paths) {
    const s = scoreMatch(p, lq);
    if (s >= 0) scored.push({ p, s });
  }
  scored.sort((a, b) => a.s - b.s || a.p.localeCompare(b.p));
  return {
    total: scored.length,
    paths: scored.slice(0, limit).map((x) => x.p),
    truncated: scored.length > limit,
    cachedAt: builtAt,
  };
}

// ---- raw 字节读取（预览流：content-type + Range）----

export const MAX_RAW_BYTES = 25 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json",
  ".yml": "text/yaml",
  ".yaml": "text/yaml",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
};

/** 按扩展名给出预览用 Content-Type；未知类型 octet-stream。 */
export function contentTypeFor(rel: string): string {
  return CONTENT_TYPES[path.extname(rel).toLowerCase()] ?? "application/octet-stream";
}

export interface RawReadResult {
  buf: Buffer;
  contentType: string;
  range: { start: number; end: number; total: number } | null;
}

/** 原始字节读取（≤25MB）；range 形如 "bytes=0-1023"。 */
export async function readFileRaw(
  workspaceDir: string,
  rel: string,
  rangeHeader?: string | null,
): Promise<RawReadResult> {
  const abs = await resolveInside(workspaceDir, rel);
  const st = await fs.stat(abs);
  if (st.isDirectory()) throw new Error("IS_DIRECTORY");
  if (st.size > MAX_RAW_BYTES) throw new Error("FILE_TOO_LARGE");
  const buf = await fs.readFile(abs);
  const contentType = contentTypeFor(rel);
  const m = rangeHeader?.match(/^bytes=(\d*)-(\d*)$/);
  if (m && (m[1] || m[2])) {
    const start = m[1] ? parseInt(m[1], 10) : 0;
    const end = m[2] ? Math.min(parseInt(m[2], 10), st.size - 1) : st.size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= st.size) {
      throw new Error("INVALID_RANGE");
    }
    return { buf: buf.subarray(start, end + 1), contentType, range: { start, end, total: st.size } };
  }
  return { buf, contentType, range: null };
}
