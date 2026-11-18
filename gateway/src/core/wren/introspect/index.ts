/**
 * 内省适配器 Factory（DESIGN §40）：按 wren 数据源类型选择适配器。
 * postgres/clickhouse 之外的实现返回 null → 调用方走空骨架路径（不内省）。
 */
import { introspectClickhouse, testClickhouse } from "./clickhouse.ts";
import { introspectPostgres, testPostgres } from "./postgres.ts";
import type { Introspector, WrenCatalogRow } from "./types.ts";

export type { IntrospectOptions, Introspector, WrenCatalogRow } from "./types.ts";
export { INTROSPECT_TIMEOUT_MS } from "./types.ts";
export { introspectClickhouse, testClickhouse } from "./clickhouse.ts";
export { introspectPostgres, postgresConnStr, testPostgres } from "./postgres.ts";

const INTROSPECTORS: Record<string, Introspector> = {
  postgres: {
    introspect: (connection) => introspectPostgres(connection),
    testConnection: (connection) => testPostgres(connection),
  },
  clickhouse: {
    introspect: (connection, opts) => introspectClickhouse(connection, opts?.limit),
    testConnection: (connection) => testClickhouse(connection),
  },
};

/** 数据源类型 → 内省适配器；未适配类型返回 null（空骨架路径）。 */
export function selectIntrospector(datasource: string): Introspector | null {
  return Object.hasOwn(INTROSPECTORS, datasource) ? INTROSPECTORS[datasource] : null;
}

/** 按数据源类型分发内省；postgres/clickhouse 之外的类型返回 []（跳过内省，空骨架路径）。 */
export async function introspectWrenDatasource(entry: {
  datasource: string;
  connection: Record<string, unknown>;
}): Promise<WrenCatalogRow[]> {
  const introspector = selectIntrospector(entry.datasource);
  return introspector ? introspector.introspect(entry.connection) : [];
}

/** 连接测试（不落注册表）：postgres → SELECT 1；clickhouse → 内省查询 LIMIT 1；其余不支持。 */
export async function testWrenConnection(entry: {
  datasource: string;
  connection: Record<string, unknown>;
}): Promise<{ ok: boolean; detail: string }> {
  const introspector = selectIntrospector(entry.datasource);
  if (!introspector) {
    throw new Error(`connection test not supported for datasource "${entry.datasource}" (postgres/clickhouse only)`);
  }
  return introspector.testConnection(entry.connection);
}
