/** 单钩子 HTTP 投递（HMAC 签名头 + 超时）。 */
import { SIGNATURE_HEADER } from "../signature.ts";
import type { IntegrationHookRow } from "../tenant-store.ts";

/** 单钩子投递（带签名头与超时）；网络层任何失败统一返回 {ok:false}。 */
export async function postHook(
  row: IntegrationHookRow,
  body: string,
  sig: string,
  timeoutMs: number,
): Promise<{ ok: boolean; status?: number; json?: unknown }> {
  try {
    const res = await fetch(row.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: sig,
        "x-omp-hook-event": row.event,
        "x-omp-hook-id": row.id,
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, json };
  } catch {
    return { ok: false };
  }
}
/** 事件规则里的去重工具（resources paths 等）。 */
export const uniq = (xs: string[]): string[] => [...new Set(xs)];
