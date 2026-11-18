/**
 * MDL 生成纯函数（DESIGN §39.2.1 / §39.2.2）：目录行 → 每表一个 model YAML（wren schema
 * v5 directory-per-model）。所有字符串双引号 + 转义（列名/表名是目录数据，绝不进 SQL）。
 *
 * 所有权与增量（v3/M34）：生成的 model 在 properties 写入所有权标记
 * `gateway_generated: true` + `table_fingerprint`（该表规范化目录行的 sha256 前 12 位）；
 * planModelWrites 按指纹增量——指纹一致不落盘（agent enrich 安全），指纹变化只重写结构
 * 并保留 agent 的 description，手建 model 永不改动/删除。现有 model 解析用行扫描
 * （只认我们自己的固定格式，不引 YAML 库），解析失败视为非网关生成（跳过不动）。
 */
import type { WrenCatalogRow } from "./introspect/types.ts";
import { GENERATED_DESCRIPTION_PREFIX, parseModelYaml } from "./model-parse.ts";

export { GENERATED_DESCRIPTION_PREFIX, parseModelYaml } from "./model-parse.ts";
export type { ParsedModelMeta } from "./model-parse.ts";

/** YAML 安全序列化：所有字符串双引号 + 转义（\ " \n \r \t 与其余控制字符 → \uXXXX）。 */
export function quoteYamlString(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `"${out}"`;
}

/** 模型名净化：目录数据 → [A-Za-z0-9_] 标识符（数字开头加 m 前缀；空串回落 "m_"）。 */
export function sanitizeModelName(s: string): string {
  const clean = s.replace(/[^A-Za-z0-9_]/g, "_");
  const safe = /^[0-9]/.test(clean) ? `m${clean}` : clean;
  return safe || "m_";
}

/** table_reference 的 catalog：PG/CH 取连接的 database（duckdb 等由 agent 自行建模）。 */
export const catalogOf = (entry: { datasource: string; connection: Record<string, unknown> }): string =>
  entry.connection.database == null ? "" : String(entry.connection.database);

/**
 * ClickHouse 的标识符只有两段（database.table）：catalog 必须**省略**，否则生成
 * `shop.shop.fact_orders` 三段引用 → CH 解析到 `AS __source` 处报语法错误（实测踩到）。
 * PG/DuckDB 是三段（catalog.schema.table），保持写 catalog。
 */
export const omitsCatalog = (datasource: string): boolean => datasource === "clickhouse";

// ---- 指纹（drift 检测的规范化层，DESIGN §39.2.2）----

/** sha256 前 12 位十六进制（表指纹与目录哈希共用截断宽度）。 */
const shortSha = (s: string): string => new Bun.CryptoHasher("sha256").update(s).digest("hex").slice(0, 12);

/**
 * 单表指纹：该表规范化行（`column:type`，按列名排序——同集合不同行序同值）拼串 →
 * sha256 前 12 位。列增删/类型变化 → 指纹变；纯行序变化不影响。
 */
export function tableFingerprint(rows: WrenCatalogRow[], schema: string, table: string): string {
  const cols = rows
    .filter((r) => r.schema === schema && r.table === table && r.column)
    .map((r) => ({ c: r.column, t: r.type }))
    .sort((a, b) => (a.c < b.c ? -1 : a.c > b.c ? 1 : a.t < b.t ? -1 : a.t > b.t ? 1 : 0))
    .map((x) => `${x.c}:${x.t}`);
  return shortSha(cols.join("\n"));
}

/** 全目录哈希：全部行按 `schema.table.column:type` 规范化排序 → sha256 前 12 位（不含库名差异）。 */
export function catalogHash(rows: WrenCatalogRow[]): string {
  const lines = rows
    .filter((r) => r.table && r.column)
    .map((r) => `${r.schema}.${r.table}.${r.column}:${r.type}`)
    .sort();
  return shortSha(lines.join("\n"));
}

// ---- 生成（纯函数）----

/** 单个 model 的生成产物：YAML 文本 + 归属表引用 + 表指纹（增量判定依据）。 */
export interface ModelDoc {
  yaml: string;
  /** 归属表引用 "schema.table" */
  ref: string;
  /** tableFingerprint(rows, schema, table)——写入 properties.table_fingerprint */
  fingerprint: string;
}

const generatedDescription = (schema: string, table: string): string =>
  `${GENERATED_DESCRIPTION_PREFIX}${schema}.${table}）；业务描述与指标请由会话 agent 按 data-query skill enrich`;

/**
 * 目录行 → 每表一个 model 文档（wren schema v5：models/<name>/metadata.yml）。
 * 键名与最小结构以 `wren skills get generate-mdl` 为准：name / properties.description /
 * properties.gateway_generated + table_fingerprint / table_reference{catalog,schema,table} /
 * columns[{name,type}]。types 原样透传。tables 白名单（"schema.table" 精确匹配）过滤；
 * 命名基于全量目录行（同名冲突回退 `<schema>_<table>`，仍冲突追加序号）→ 同一物理表的
 * 模型名稳定，PUT 收紧白名单不改变既有模型名。
 */
export function buildModelDocs(
  rows: WrenCatalogRow[],
  tables: string[] | null,
  catalog: string,
  omitCatalog = false,
): Record<string, ModelDoc> {
  const allow = tables && tables.length > 0 ? new Set(tables) : null;
  const groups = new Map<string, { schema: string; table: string; columns: Array<{ name: string; type: string }> }>();
  const refsByTableName = new Map<string, Set<string>>(); // sanitize(table) → 引用它的 ref 集合（全量行，命名稳定不受白名单影响）
  for (const row of rows) {
    if (!row.table || !row.column) continue;
    const ref = `${row.schema}.${row.table}`;
    const tkey = sanitizeModelName(row.table);
    if (!refsByTableName.has(tkey)) refsByTableName.set(tkey, new Set());
    refsByTableName.get(tkey)!.add(ref);
    if (allow && !allow.has(ref)) continue;
    let g = groups.get(ref);
    if (!g) {
      g = { schema: row.schema, table: row.table, columns: [] };
      groups.set(ref, g);
    }
    g.columns.push({ name: row.column, type: row.type });
  }
  // 命名：sanitize(table)；全量行里同名表 >1（跨 schema 冲突）回退 sanitize(schema_table)；
  // 再冲突追加序号。基于全量行而非白名单过滤后的子集 → 模型名稳定。
  const used = new Set<string>();
  const nameOf = new Map<string, string>();
  for (const ref of groups.keys()) {
    const g = groups.get(ref)!;
    let name = sanitizeModelName(g.table);
    if ((refsByTableName.get(sanitizeModelName(g.table))?.size ?? 0) > 1) {
      name = sanitizeModelName(`${g.schema}_${g.table}`);
    }
    if (used.has(name)) {
      let i = 2;
      while (used.has(`${name}_${i}`)) i++;
      name = `${name}_${i}`;
    }
    used.add(name);
    nameOf.set(ref, name);
  }
  const out: Record<string, ModelDoc> = {};
  for (const [ref, g] of groups) {
    const model = nameOf.get(ref)!;
    const fingerprint = tableFingerprint(rows, g.schema, g.table);
    const lines: string[] = [
      `name: ${quoteYamlString(model)}`,
      `properties:`,
      `  description: ${quoteYamlString(generatedDescription(g.schema, g.table))}`,
      // 所有权标记（§39.2.2）：增量更新的判据，agent 请勿删除
      `  gateway_generated: true`,
      `  table_fingerprint: ${quoteYamlString(fingerprint)}`,
      `table_reference:`,
      // ClickHouse 只有两段（database.table）：catalog 省略（详见 omitsCatalog 注释）
      ...(omitCatalog ? [] : [`  catalog: ${quoteYamlString(catalog)}`]),
      `  schema: ${quoteYamlString(g.schema)}`,
      `  table: ${quoteYamlString(g.table)}`,
      `columns:`,
    ];
    for (const col of g.columns) {
      lines.push(`  - name: ${quoteYamlString(col.name)}`);
      lines.push(`    type: ${quoteYamlString(col.type)}`);
    }
    out[model] = { yaml: `${lines.join("\n")}\n`, ref, fingerprint };
  }
  return out;
}

/** 首次全量生成（模型名 → metadata.yml 文本）。增量路径请用 planModelWrites。 */
export function mdlModelsFromRows(
  rows: WrenCatalogRow[],
  tables: string[] | null,
  catalog: string,
  omitCatalog = false,
): Record<string, string> {
  const docs = buildModelDocs(rows, tables, catalog, omitCatalog);
  return Object.fromEntries(Object.entries(docs).map(([name, doc]) => [name, doc.yaml]));
}

/** 重写生成 YAML 的 properties.description（保留 agent enrich 用）；只替换该固定行。 */
function withDescription(yaml: string, description: string): string {
  const line = `  description: ${quoteYamlString(description)}`;
  return yaml
    .split("\n")
    .map((l) => (l.startsWith("  description:") ? line : l))
    .join("\n");
}

// ---- 增量计划（六情形，§39.2.2）----

export interface ModelWritePlan {
  /** 需要落盘的 model（新表生成 / 指纹变化重写——重写已保留 agent description） */
  writes: Record<string, string>;
  /** 需删除的 model 目录（表消失且确为网关生成） */
  deletes: string[];
  /** 指纹一致、不落盘的 model（agent enrich 安全） */
  unchanged: string[];
}

export interface PlanModelWritesArgs {
  /** 现有 model 集（模型目录名 → metadata.yml 内容） */
  existing: Map<string, { content: string }>;
  rows: WrenCatalogRow[];
  tables: string[] | null;
  catalog: string;
  omitCatalog: boolean;
}

/**
 * 按表指纹计算增量落盘计划（纯函数，无 I/O）：
 *   指纹一致 → unchanged；指纹变 + gateway_generated → 重写（保留原 description，占位除外）；
 *   指纹变 + 非网关生成（含解析失败/手建/指纹缺失且非网关标记）→ 跳过；
 *   新表 → 生成；表消失 + gateway_generated → deletes；表消失 + 其余 → 保留。
 */
export function planModelWrites(args: PlanModelWritesArgs): ModelWritePlan {
  const docs = buildModelDocs(args.rows, args.tables, args.catalog, args.omitCatalog);
  const writes: Record<string, string> = {};
  const deletes: string[] = [];
  const unchanged: string[] = [];
  for (const [name, doc] of Object.entries(docs)) {
    const cur = args.existing.get(name);
    if (!cur) {
      writes[name] = doc.yaml; // 新表
      continue;
    }
    const parsed = parseModelYaml(cur.content);
    if (!parsed) continue; // 解析失败 → 视为 agent 手建，跳过
    if (parsed.fingerprint && parsed.fingerprint === doc.fingerprint) {
      unchanged.push(name); // 指纹一致 → 不写文件
      continue;
    }
    if (!parsed.gatewayGenerated) continue; // 手建（或网关标记缺失）→ 跳过
    // 网关生成且指纹已变 → 重写结构，保留 agent 的 description（占位文案除外）
    writes[name] =
      parsed.description && !parsed.description.startsWith(GENERATED_DESCRIPTION_PREFIX)
        ? withDescription(doc.yaml, parsed.description)
        : doc.yaml;
  }
  for (const [name, cur] of args.existing) {
    if (Object.hasOwn(docs, name)) continue;
    const parsed = parseModelYaml(cur.content);
    if (parsed?.gatewayGenerated) deletes.push(name); // 表消失 + 网关生成 → 删
    // 其余（手建/解析失败）→ 保留
  }
  return { writes, deletes, unchanged };
}
