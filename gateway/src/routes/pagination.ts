/**
 * 分页查询参数解析：非数字/NaN 回退默认值。
 * 此前各路由裸 `Number(query)`，`?page=abc` → NaN 直达 SQL LIMIT/OFFSET 绑定参数报 500（应 4xx/回退）。
 */

/** 非负整数或回退值（负数/小数/非数字 → fallback；调用方按需再 clamp 上下限）。 */
export function parseUInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}
