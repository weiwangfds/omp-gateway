/**
 * 内省适配器的公共契约（Adapter，DESIGN §40）：PG / CH 两个实现统一把目录元数据
 * 归一成 WrenCatalogRow，供 MDL 生成纯函数消费。
 */

/** 内省行归一形态（PG/CH 两个来源统一到此）。 */
export interface WrenCatalogRow {
  schema: string;
  table: string;
  column: string;
  type: string;
}

export interface IntrospectOptions {
  /** 仅采样前 N 行（连接测试用；clickhouse 内省查询末尾 LIMIT）。 */
  limit?: number;
}

/** 数据源内省适配器：类型分发由 Factory（selectIntrospector）完成。 */
export interface Introspector {
  introspect(connection: Record<string, unknown>, opts?: IntrospectOptions): Promise<WrenCatalogRow[]>;
  testConnection(connection: Record<string, unknown>): Promise<{ ok: boolean; detail: string }>;
}

/** 内省/连接测试的单次超时（与拆分前一致）。 */
export const INTROSPECT_TIMEOUT_MS = 15_000;
