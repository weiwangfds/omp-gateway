/**
 * wren 数据源注册表（Repository，DESIGN §39.2.1 / §40）：唯一事实源
 * `<dataRoot>/global/wren/datasources.json`（含明文连接 → chmod 600）。
 *
 *   {"<name>": {"datasource","connection","tables","port","createdAt","updatedAt",
 *               "daemonPid"?,"generatedModels"?,"lastError"?}}
 *
 * env（WREN_DATASOURCES + WREN_DS_CONNECTIONS）只是种子：启动合并仅补缺失名，
 * 已存在的 admin 条目优先。
 */
import * as fs from "node:fs/promises";
import path from "node:path";
import { config } from "../../config.ts";
import { isPortListening } from "../daemon.ts";
import { WREN_DS_NAME_RE, wrenPortBase, type WrenDatasourceSpec } from "./env.ts";

/** 端口分配向上扫描上限（base+64；数据源数量远小于此） */
const PORT_SCAN_LIMIT = 64;

/** 注册表条目（datasources.json 的值；唯一事实源，DESIGN §39.2.1）。 */
export interface WrenDsEntry {
  /** wren 数据源类型（postgres/clickhouse/…） */
  datasource: string;
  /** 连接字段（含敏感字段；明文落注册表，文件 chmod 600） */
  connection: Record<string, unknown>;
  /** 表白名单（"schema.table" 精确匹配）；null = 全部非系统表 */
  tables: string[] | null;
  /** daemon 端口（创建时分配，稳定复用） */
  port: number;
  createdAt: string;
  updatedAt: string;
  /** 最近一次 daemon spawn 的 pid（重启/删除时定点杀；容器重启后自然失效） */
  daemonPid?: number;
  /** 上一轮内省生成的 model 目录名清单（本轮集合外的自动生成目录会被移除；agent 自建文件不在清单，永不删除） */
  generatedModels?: string[];
  /** 最近一次 provision 的错误（null = ready；非致命，骨架/daemon 照常） */
  lastError?: string | null;
  /** 最近一次同步后的全目录哈希（drift 检测基线；缺省 = 未同步过，§39.2.2） */
  catalogHash?: string;
  /** 最近一次成功 sync 时间（ISO；缺省 = 未同步过） */
  lastSyncedAt?: string;
  /** 最近一次检测到 drift 的时间（ISO） */
  lastDriftAt?: string;
  /** 最近一次 sync 的错误（null = 无；内省/build 失败等非致命，保留旧模型继续服务） */
  lastSyncError?: string | null;
}

export const wrenRegistryPath = (): string => path.join(config.dataRoot, "global", "wren", "datasources.json");

/** 项目目录：<dataRoot>/global/wren/<name>/（GLOBAL_ROOT 卷挂载 → 宿主 ./global/wren/<name>/）。 */
export const wrenProjectDir = (name: string): string => path.join(config.dataRoot, "global", "wren", name);

/** 读注册表：文件缺失/坏 JSON → 空注册表（不抛，调用方 best-effort）。 */
export async function loadWrenRegistry(): Promise<Record<string, WrenDsEntry>> {
  const raw = await fs.readFile(wrenRegistryPath(), "utf8").catch(() => null);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, WrenDsEntry> = {};
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!WREN_DS_NAME_RE.test(name)) continue;
      const e = value as Partial<WrenDsEntry> | null;
      if (!e || typeof e !== "object" || typeof e.datasource !== "string") continue;
      if (!e.connection || typeof e.connection !== "object" || Array.isArray(e.connection)) continue;
      out[name] = {
        datasource: e.datasource,
        connection: e.connection as Record<string, unknown>,
        tables: Array.isArray(e.tables) ? e.tables.map(String) : null,
        port: Number(e.port) || wrenPortBase(),
        createdAt: String(e.createdAt ?? ""),
        updatedAt: String(e.updatedAt ?? ""),
        ...(Number.isFinite(Number(e.daemonPid)) && Number(e.daemonPid) > 0 ? { daemonPid: Number(e.daemonPid) } : {}),
        ...(Array.isArray(e.generatedModels) ? { generatedModels: e.generatedModels.map(String) } : {}),
        lastError: typeof e.lastError === "string" ? e.lastError : null,
        // 同步字段（§39.2.2）：旧文件缺省 → 视为未同步过（缺键，不写 null/undefined 占位）
        ...(typeof e.catalogHash === "string" && e.catalogHash !== "" ? { catalogHash: e.catalogHash } : {}),
        ...(typeof e.lastSyncedAt === "string" && e.lastSyncedAt !== "" ? { lastSyncedAt: e.lastSyncedAt } : {}),
        ...(typeof e.lastDriftAt === "string" && e.lastDriftAt !== "" ? { lastDriftAt: e.lastDriftAt } : {}),
        ...(e.lastSyncError !== undefined
          ? { lastSyncError: typeof e.lastSyncError === "string" ? e.lastSyncError : null }
          : {}),
      };
    }
    return out;
  } catch {
    return {};
  }
}

/** 写注册表 + chmod 600（含明文连接，收权限）。 */
export async function saveWrenRegistry(reg: Record<string, WrenDsEntry>): Promise<void> {
  const file = wrenRegistryPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(reg, null, 2)}\n`, "utf8");
  await fs.chmod(file, 0o600).catch(() => {});
}

/**
 * 端口分配：从 WREN_MCP_PORT_BASE 向上找第一个「未被注册表占用且未监听」的端口
 * （写入注册表稳定复用）。扫描上限 base+PORT_SCAN_LIMIT，耗尽抛错（调用方 400/500）。
 */
export async function allocateWrenPort(reg: Record<string, WrenDsEntry>): Promise<number> {
  const used = new Set(Object.values(reg).map((e) => e.port));
  const base = wrenPortBase();
  for (let p = base; p < base + PORT_SCAN_LIMIT; p++) {
    if (used.has(p)) continue;
    if (await isPortListening(p)) continue;
    return p;
  }
  throw new Error(`no free wren daemon port in [${base}, ${base + PORT_SCAN_LIMIT})`);
}

/** env 种子合并：仅补注册表缺失的名字（已存在的 admin 条目优先）。返回新增名列表。 */
export async function mergeWrenSeeds(reg: Record<string, WrenDsEntry>, seeds: WrenDatasourceSpec[]): Promise<string[]> {
  const added: string[] = [];
  for (const spec of seeds) {
    if (reg[spec.name]) continue;
    let port = spec.port;
    try {
      port = await allocateWrenPort(reg);
    } catch {
      // 分配失败退回种子序号端口（provision 阶段会暴露端口冲突）
    }
    reg[spec.name] = {
      datasource: spec.datasource,
      connection: spec.connection,
      tables: null,
      port,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastError: null,
    };
    added.push(spec.name);
  }
  return added;
}
