/**
 * KB 元数据 store（DESIGN §38.3）：每个知识库一个 sqlite（<dataRoot>/global/kb/<slug>.db）。
 *
 * - 只有 groups + docs 两张表：检索语料就是 markdown 本体，旧 store.py 的
 *   blocks/sections/refs/terms/vectors 全部不建（随服务端检索一起退役）。
 * - groups 用物化路径 'A/B/C'（UNIQUE），ensureGroup 逐级建、返回最深组 id。
 * - docs 主键 = 文档名（zip 词干清洗结果）；md_sha256 做变更检测。
 * - 连接按 slug 缓存复用；删除 KB 时先 close 再删文件（含 -wal/-shm）。
 * - 语句一律走 .run()（建表/PRAGMA 均无结果集，语义等价且类型收敛）。
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { globalKbDir } from "../paths.ts";
import { assertSlug } from "./names.ts";

export interface KbGroupRow {
  id: number;
  parentId: number | null;
  name: string;
  path: string;
}

export interface KbDocRow {
  name: string;
  groupId: number | null;
  mdSha256: string;
  pages: number;
  images: number;
  hasPdf: number;
  createdAt: string;
  updatedAt: string;
}

/** 树节点：分组嵌套；docs 挂在各层，未分组文档挂根部（buildTree 返回值的 docs）。 */
export interface KbTreeDocNode {
  name: string;
  groupPath: string | null;
  pages: number;
  images: number;
  hasPdf: boolean;
  mdSha256: string;
  updatedAt: string;
}

export interface KbTreeNode {
  name: string;
  path: string;
  children: KbTreeNode[];
  docs: KbTreeDocNode[];
}

export interface KbTree {
  groups: KbTreeNode[];
  docs: KbTreeDocNode[];
}

/** slug → 连接缓存（管理面请求间复用；单进程内同步语句天然串行）。 */
const connections = new Map<string, Database>();

function initSchema(d: Database): void {
  d.run("PRAGMA journal_mode = WAL");
  d.run("PRAGMA busy_timeout = 5000");
  d.run(
    "CREATE TABLE IF NOT EXISTS groups (id INTEGER PRIMARY KEY, parent_id INTEGER NULL, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE)",
  );
  d.run(
    "CREATE TABLE IF NOT EXISTS docs (name TEXT PRIMARY KEY, group_id INTEGER NULL REFERENCES groups(id), md_sha256 TEXT NOT NULL, pages INTEGER NOT NULL DEFAULT 0, images INTEGER NOT NULL DEFAULT 0, has_pdf INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))",
  );
}

/** 打开（或复用）某 KB 的元数据库；slug 先过命名校验再拼路径。 */
export function openKbDb(slug: string): Database {
  assertSlug(slug);
  const existing = connections.get(slug);
  if (existing) return existing;
  mkdirSync(globalKbDir(), { recursive: true });
  const d = new Database(path.join(globalKbDir(), `${slug}.db`), { create: true });
  initSchema(d);
  connections.set(slug, d);
  return d;
}

/** 关闭并移除缓存连接（幂等；未打开返回 false）。 */
export function closeKbDb(slug: string): boolean {
  const d = connections.get(slug);
  if (!d) return false;
  connections.delete(slug);
  try {
    d.close();
  } catch {}
  return true;
}

/** 关闭连接并删除库文件（含 -wal/-shm；KB 删除用）。 */
export async function removeKbDbFile(slug: string): Promise<void> {
  assertSlug(slug);
  closeKbDb(slug);
  const base = path.join(globalKbDir(), `${slug}.db`);
  await Promise.all(
    [base, `${base}-wal`, `${base}-shm`].map((f) => fs.rm(f, { force: true, recursive: true }).catch(() => {})),
  );
}

/**
 * 物化路径逐级建组：'A/B/C' → 缺哪级建哪级，返回最深组 id；空/null → null（归根）。
 * 每级 name = 路径末段，path = 全路径（UNIQUE 保证并发下重复建组收敛为查到同一行）。
 */
export function ensureGroup(d: Database, groupPath: string | null): number | null {
  if (!groupPath) return null;
  const segs = groupPath.split("/").filter(Boolean);
  let parentId: number | null = null;
  let id: number | null = null;
  for (let i = 0; i < segs.length; i++) {
    const p = segs.slice(0, i + 1).join("/");
    const hit = d.query("SELECT id FROM groups WHERE path = ?").get(p) as { id: number } | null;
    if (hit) {
      id = hit.id;
    } else {
      d.run("INSERT INTO groups (parent_id, name, path) VALUES (?,?,?)", [parentId, segs[i], p]);
      const row = d.query("SELECT last_insert_rowid() AS id").get() as { id: number } | null;
      id = row ? Number(row.id) || null : null;
    }
    parentId = id;
  }
  return id;
}

export function listGroups(d: Database): KbGroupRow[] {
  const rows = d.query("SELECT id, parent_id, name, path FROM groups ORDER BY path").all() as Array<{
    id: number;
    parent_id: number | null;
    name: string;
    path: string;
  }>;
  return rows.map((r) => ({ id: r.id, parentId: r.parent_id, name: r.name, path: r.path }));
}

export interface UpsertDoc {
  name: string;
  groupId: number | null;
  mdSha256: string;
  pages: number;
  images: number;
}

/** 登记/更新文档（同名覆盖更新：内容字段全量刷，created_at 保留）。 */
export function upsertDoc(d: Database, doc: UpsertDoc): void {
  d.run(
    `INSERT INTO docs (name, group_id, md_sha256, pages, images) VALUES (?,?,?,?,?)
     ON CONFLICT(name) DO UPDATE SET
       group_id = excluded.group_id,
       md_sha256 = excluded.md_sha256,
       pages = excluded.pages,
       images = excluded.images,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    [doc.name, doc.groupId, doc.mdSha256, doc.pages, doc.images],
  );
}

const toDocRow = (r: Record<string, unknown>): KbDocRow => ({
  name: String(r.name),
  groupId: (r.group_id as number | null) ?? null,
  mdSha256: String(r.md_sha256),
  pages: Number(r.pages),
  images: Number(r.images),
  hasPdf: Number(r.has_pdf),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});

export function getDoc(d: Database, name: string): KbDocRow | null {
  const r = d.query("SELECT * FROM docs WHERE name = ?").get(name) as Record<string, unknown> | null;
  return r ? toDocRow(r) : null;
}

export function listDocs(d: Database): KbDocRow[] {
  const rows = d.query("SELECT * FROM docs ORDER BY name").all() as Array<Record<string, unknown>>;
  return rows.map(toDocRow);
}

export function countDocs(d: Database): number {
  return Number((d.query("SELECT COUNT(*) AS n FROM docs").get() as { n: number }).n);
}

export function deleteDocRow(d: Database, name: string): boolean {
  const r = d.run("DELETE FROM docs WHERE name = ?", [name]);
  return r.changes > 0;
}

export function setDocHasPdf(d: Database, name: string, hasPdf: 0 | 1): void {
  d.run("UPDATE docs SET has_pdf = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE name = ?", [
    hasPdf,
    name,
  ]);
}

/** 分组嵌套树 + 文档卡片；未分组文档挂根部 docs。 */
export function buildTree(d: Database): KbTree {
  const groups = listGroups(d);
  const docs = listDocs(d);
  const byPath = new Map<string, KbTreeNode>();
  for (const g of groups) byPath.set(g.path, { name: g.name, path: g.path, children: [], docs: [] });
  const roots: KbTreeNode[] = [];
  for (const g of groups) {
    const node = byPath.get(g.path)!;
    const parent = g.parentId != null ? groups.find((x) => x.id === g.parentId) : null;
    if (parent && byPath.has(parent.path)) byPath.get(parent.path)!.children.push(node);
    else roots.push(node);
  }
  const rootDocs: KbTreeDocNode[] = [];
  for (const doc of docs) {
    const card: KbTreeDocNode = {
      name: doc.name,
      groupPath: doc.groupId != null ? (groups.find((g) => g.id === doc.groupId)?.path ?? null) : null,
      pages: doc.pages,
      images: doc.images,
      hasPdf: doc.hasPdf === 1,
      mdSha256: doc.mdSha256,
      updatedAt: doc.updatedAt,
    };
    const gp = card.groupPath;
    if (gp && byPath.has(gp)) byPath.get(gp)!.docs.push(card);
    else rootDocs.push(card);
  }
  const sortNodes = (nodes: KbTreeNode[]) => {
    nodes.sort((a, b) => a.path.localeCompare(b.path));
    for (const n of nodes) {
      n.children.sort((a, b) => a.path.localeCompare(b.path));
      n.docs.sort((a, b) => a.name.localeCompare(b.name));
      sortNodes(n.children);
    }
  };
  sortNodes(roots);
  rootDocs.sort((a, b) => a.name.localeCompare(b.name));
  return { groups: roots, docs: rootDocs };
}
