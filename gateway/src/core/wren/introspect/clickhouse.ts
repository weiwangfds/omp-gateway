/**
 * clickhouse 内省适配器（DESIGN §39.2.1）：HTTP POST 固定常量查询 system.columns
 * （TSV 解析；httpPort 缺省 8123，X-ClickHouse-User/Key 认证）。
 */
import { INTROSPECT_TIMEOUT_MS, type WrenCatalogRow } from "./types.ts";

/**
 * clickhouse 目录内省：HTTP 固定常量查询 system.columns（TSV 解析）。
 *
 * 库范围（实测修正）：CH 的 system.columns 会连 `information_schema`/`INFORMATION_SCHEMA`
 * 一起列出（各 14 张元数据表）——只排除 `system` 会生成 7 个垃圾 model（17 vs 10）。
 * 因此：connection.database 有值 → **只内省该库**（用户配置的就是这个库的语义）；
 * 未指定 → 排除 system 与两个 information_schema（大小写各一）。
 */
export async function introspectClickhouse(
  connection: Record<string, unknown>,
  limit?: number,
): Promise<WrenCatalogRow[]> {
  const host = String(connection.host ?? "localhost");
  const port = String(connection.httpPort ?? connection.port ?? "8123");
  const user = String(connection.user ?? "default");
  const key = connection.password == null ? "" : String(connection.password);
  // 库名来自部署方 connection（非用户输入）；仍做标识符白名单校验后再拼进常量查询
  const db = typeof connection.database === "string" ? connection.database.trim() : "";
  const DB_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const scope =
    db && DB_RE.test(db)
      ? `database = '${db}'`
      : `database NOT IN ('system','information_schema','INFORMATION_SCHEMA')`;
  const query =
    `SELECT database, table, name, type FROM system.columns WHERE ${scope} ` +
    `ORDER BY database, table, position${limit ? ` LIMIT ${Number(limit)}` : ""} FORMAT TabSeparatedWithNames`;
  const resp = await fetch(`http://${host}:${port}/`, {
    method: "POST",
    headers: { "X-ClickHouse-User": user, ...(key ? { "X-ClickHouse-Key": key } : {}) },
    body: query,
    signal: AbortSignal.timeout(INTROSPECT_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`clickhouse http ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const lines = (await resp.text()).split("\n").filter((l) => l.length > 0);
  return lines.slice(1).map((line) => {
    const [database, table, name, type] = line.split("\t");
    return {
      schema: String(database ?? ""),
      table: String(table ?? ""),
      column: String(name ?? ""),
      type: String(type ?? ""),
    };
  });
}

/** 连接测试：内省查询 LIMIT 1（只验证连通与鉴权，不落库）。 */
export async function testClickhouse(connection: Record<string, unknown>): Promise<{ ok: boolean; detail: string }> {
  const rows = await introspectClickhouse(connection, 1);
  return { ok: true, detail: `clickhouse ok (${rows.length} column row(s) sampled)` };
}
