/**
 * global/mcp.json 的 wren/qmd 注册读写点（Repository + 进程内串行锁，DESIGN §40，M33）。
 * 注意：/admin/global/mcp 的 GET/PUT（routes/admin.ts）做整文件直读直写，不经本模块——
 * 本锁只串行化 wren/qmd 的 upsert/remove；admin 全量覆写与之并发时可能丢对方刚写入的键。
 *
 * 背景：拆分前 wren.ts 的两处与 qmd.ts 的一处各自做「读-改-写」，并发时后写者
 * 覆盖前者的条目（真竞态）。这里把所有读-改-写放进同一条模块级 promise 链：
 * 先到者完成落盘后下一个才开始读，因此并发 upsert 不同键不会互相丢失。
 *
 * 幂等：upsert 仅当给定键内容变化（深比较）才落盘；只增/改给定键，其余条目与
 * mcp.json 顶层其他字段原样保留。remove 只删点名键，文件缺失/坏 JSON 视作空表。
 */
import * as fs from "node:fs/promises";
import path from "node:path";
import { globalMcpPath } from "./paths.ts";

interface McpFile {
  mcpServers?: Record<string, unknown>;
  [k: string]: unknown;
}

/** 模块级串行锁：所有读-改-写走同一队列（rejection 不阻塞后续操作）。 */
let opChain: Promise<unknown> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = opChain.then(fn, fn);
  opChain = next.catch(() => {});
  return next;
}

/** 读原始文件；缺失/坏 JSON/非对象 → 空配置（调用方按空表处理）。 */
async function readRaw(): Promise<McpFile> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(globalMcpPath(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as McpFile) : {};
  } catch {
    return {};
  }
}

/** mcpServers 归一为可写副本（缺失/非对象 → {}）。 */
const serverMap = (raw: McpFile): Record<string, unknown> =>
  raw.mcpServers && typeof raw.mcpServers === "object" ? { ...raw.mcpServers } : {};

async function writeRaw(raw: McpFile, servers: Record<string, unknown>): Promise<void> {
  const file = globalMcpPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify({ ...raw, mcpServers: servers }, null, 2)}\n`, "utf8");
}

/** 深比较（对象键序无关；数组按序）——幂等判定的依据。 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  return ak.length === Object.keys(bo).length && ak.every((k) => Object.hasOwn(bo, k) && deepEqual(ao[k], bo[k]));
}

/** 读 mcpServers 快照（只读；同样排队，保证看到的是某次写完成后的线性化状态）。 */
export function readMcpServers(): Promise<Record<string, unknown>> {
  return withLock(async () => serverMap(await readRaw()));
}

/**
 * 幂等 upsert：只增/改给定键，其余保留；内容一致（深比较）不落盘。
 * 返回 added = 实际新增或改写的键名（内容未变的键不计入）。
 */
export function upsertMcpServers(entries: Record<string, unknown>): Promise<{ written: boolean; added: string[] }> {
  return withLock(async () => {
    const raw = await readRaw();
    const servers = serverMap(raw);
    const added: string[] = [];
    for (const [key, value] of Object.entries(entries)) {
      if (deepEqual(servers[key], value)) continue;
      servers[key] = value;
      added.push(key);
    }
    if (added.length === 0) return { written: false, added };
    await writeRaw(raw, servers);
    return { written: true, added };
  });
}

/**
 * 删除指定键（其余保留）。文件缺失/坏 JSON 或键不存在 → 不落盘。
 * 返回 removed = 实际删除的键名。
 */
export function removeMcpServers(names: string[]): Promise<{ written: boolean; removed: string[] }> {
  return withLock(async () => {
    const raw = await readRaw();
    const servers = serverMap(raw);
    const removed = names.filter((name) => Object.hasOwn(servers, name));
    if (removed.length === 0) return { written: false, removed };
    for (const name of removed) delete servers[name];
    await writeRaw(raw, servers);
    return { written: true, removed };
  });
}

/**
 * admin 全量覆写（/admin/global/mcp PUT）：整文件直写，但必须走同一条串行锁——
 * 此前路由层裸 writeFile，与 wren/qmd 的 upsert/remove 并发时后写者覆盖前者刚写入的键。
 * 文本内容已由路由层 JSON.parse 校验。
 */
export function writeMcpFileText(text: string): Promise<void> {
  return withLock(async () => {
    const file = globalMcpPath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text, "utf8");
  });
}
