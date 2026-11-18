/**
 * postgres 内省适配器（DESIGN §39.2.1）：Bun 内置 SQL 客户端 + 固定常量目录查询
 * （无插值 → 无注入面）。连接串由注册表 connection 拼装——部署方/admin 提供，
 * 非用户输入路径。
 */
import { SQL } from "bun";
import { INTROSPECT_TIMEOUT_MS, type WrenCatalogRow } from "./types.ts";

/** 由注册表 connection 拼装 postgres 连接串（部署方/admin 提供，非用户输入路径）。 */
export function postgresConnStr(connection: Record<string, unknown>): string {
  const host = String(connection.host ?? "localhost");
  const port = String(connection.port ?? "5432");
  const database = String(connection.database ?? "postgres");
  const user =
    connection.user == null || String(connection.user) === "" ? "" : encodeURIComponent(String(connection.user));
  const pass =
    connection.password == null || String(connection.password) === ""
      ? ""
      : encodeURIComponent(String(connection.password));
  const auth = user ? `${user}:${pass}@` : "";
  return `postgres://${auth}${host}:${port}/${database}`;
}

/** Promise.race + 超时：定时器在 finally 清理（不清理则每次内省遗留一个最长 15s 的待触发定时器，阻碍进程退出）。 */
async function withTimeout<T, R>(query: Promise<T>, message: string, map: (rows: T) => R): Promise<R> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const rows = await Promise.race([
      query,
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(message)), INTROSPECT_TIMEOUT_MS);
      }),
    ]);
    return map(rows);
  } finally {
    clearTimeout(timer);
  }
}

/** postgres 目录内省：固定常量查询（无插值 → 无注入面），Bun 内置 SQL 客户端。 */
export async function introspectPostgres(connection: Record<string, unknown>): Promise<WrenCatalogRow[]> {
  const sql = new SQL(postgresConnStr(connection));
  try {
    return await withTimeout(
      sql`SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns
          WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_schema <> ''
          ORDER BY 1,2,4`,
      "postgres introspect timeout",
      (rows) =>
        (rows as Array<Record<string, unknown>>).map((r) => ({
          schema: String(r.table_schema ?? ""),
          table: String(r.table_name ?? ""),
          column: String(r.column_name ?? ""),
          type: String(r.data_type ?? ""),
        })),
    );
  } finally {
    await sql.close().catch(() => {});
  }
}

/** 连接测试：SELECT 1（失败抛出，调用方映射为 {ok:false,detail}）。 */
export async function testPostgres(connection: Record<string, unknown>): Promise<{ ok: boolean; detail: string }> {
  const sql = new SQL(postgresConnStr(connection));
  try {
    await withTimeout(sql`SELECT 1`, "postgres connect timeout", () => undefined);
    return { ok: true, detail: "postgres SELECT 1 ok" };
  } finally {
    await sql.close().catch(() => {});
  }
}
