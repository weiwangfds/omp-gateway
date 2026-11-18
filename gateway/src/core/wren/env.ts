/**
 * wren 安装/配置解析（DESIGN §40）：可执行文件、WREN_HOME、env 种子解析、白名单正则。
 *
 * 安全：数据源名/类型进 argv/mcp.json 键/注册表键/项目目录名前必须过白名单；
 * env 种子里的非法项只进 rejected（调用方告警后跳过），绝不把白名单外的值带进 argv。
 */
import path from "node:path";
import { config } from "../../config.ts";
import { resolveBin } from "../proc.ts";

/** 本模块族统一日志前缀（与拆分前一致）。 */
export const WREN_LOG = "[gateway:wren]";

/** 数据源名白名单（进 argv/mcp.json 键/注册表键/项目目录名前必过） */
export const WREN_DS_NAME_RE = /^[a-z][a-z0-9-]{0,15}$/;
/** wren 数据源类型白名单（datasource 字段，如 postgres/clickhouse） */
export const WREN_DS_TYPE_RE = /^[a-z][a-z0-9_]{0,31}$/;
/** tables 白名单条目（"schema.table"，禁引号/反斜杠/空白——只做精确字符串匹配） */
export const WREN_TABLE_REF_RE = /^[^"\\\s]+\.[^"\\\s]+$/;

export interface WrenDatasourceSpec {
  /** 部署方声明的数据源名（白名单内；作 profile 名/mcp.json 键后缀/项目目录名） */
  name: string;
  /** wren 数据源类型（datasource 字段） */
  datasource: string;
  /** 连接字段（已剥掉 datasource；可能含敏感字段） */
  connection: Record<string, unknown>;
  /** daemon 端口（种子解析序号仅作展示/兼容；实际端口以注册表分配为准） */
  port: number;
}

export interface WrenParseResult {
  specs: WrenDatasourceSpec[];
  rejected: { name: string; reason: string }[];
}

export const wrenBin = (): string => process.env.WREN_BIN?.trim() || "wren";

/** WREN_HOME（默认落 dataRoot 内 → 随迁移 bundle 整体搬移）。 */
export const wrenHome = (): string => path.resolve(process.env.WREN_HOME?.trim() || path.join(config.dataRoot, "wren"));

export const wrenPortBase = (): number => {
  const n = Number(process.env.WREN_MCP_PORT_BASE ?? 8081);
  return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : 8081;
};

/** PATH 查找 wren：绝对/相对路径直接判存在，裸名走 PATH。找不到返回 null（调用方降级）。 */
export function resolveWrenBin(): string | null {
  return resolveBin(wrenBin());
}

/** 子进程 env：继承容器 env，注入 WREN_HOME（profiles 解析与会话内 CLI 保持一致）。 */
export const wrenSubprocessEnv = (): Record<string, string | undefined> => ({
  ...process.env,
  WREN_HOME: wrenHome(),
});

/**
 * 解析 WREN_DATASOURCES + WREN_DS_CONNECTIONS（env 种子）：非法名/缺配置/缺
 * datasource 类型的数据源进 rejected（调用方逐条告警后跳过），绝不把白名单外的值带进 argv。
 */
export function parseWrenDatasources(): WrenParseResult {
  const specs: WrenDatasourceSpec[] = [];
  const rejected: { name: string; reason: string }[] = [];
  const raw = (process.env.WREN_DATASOURCES ?? "").trim();
  if (!raw) return { specs, rejected };
  let byName: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(process.env.WREN_DS_CONNECTIONS ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      byName = parsed as Record<string, unknown>;
    }
  } catch {
    // JSON 坏 → 下面统一按缺配置处理
  }
  if (!byName) {
    rejected.push({ name: "*", reason: "WREN_DS_CONNECTIONS 缺失或不是 JSON 对象，全部数据源跳过" });
    return { specs, rejected };
  }
  const base = wrenPortBase();
  let i = 0;
  for (const name of raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (!WREN_DS_NAME_RE.test(name)) {
      rejected.push({ name, reason: "名字不满足 ^[a-z][a-z0-9-]{0,15}$" });
      continue;
    }
    const cfg = byName[name];
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
      rejected.push({ name, reason: "WREN_DS_CONNECTIONS 中没有该数据源的配置对象" });
      continue;
    }
    const connection = { ...(cfg as Record<string, unknown>) };
    const datasource = connection.datasource;
    if (typeof datasource !== "string" || !WREN_DS_TYPE_RE.test(datasource)) {
      rejected.push({
        name,
        reason: '连接 JSON 缺少合法 "datasource" 字段（wren 类型，如 "postgres"/"clickhouse"）',
      });
      continue;
    }
    delete connection.datasource;
    specs.push({ name, datasource, connection, port: base + i });
    i++;
  }
  return { specs, rejected };
}
