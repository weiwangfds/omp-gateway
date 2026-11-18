import type { GatewayEvent } from "./events.ts";
import { config } from "../config.ts";
import { listWebhooksForDispatch } from "./tenant-store.ts";
import { SIGNATURE_HEADER, signPayload } from "./signature.ts";

/**
 * 会话事件 webhook 分发（pi-web push 对标）：fire-and-forget，HMAC-SHA256 签名，
 * 5s 超时不重试（v1）。事件匹配：hook.events 含 "*" 或事件 type。
 * 高频增量事件（text.delta/omp.raw）不投递——webhook 只承载生命周期事件。
 */
const HIGH_FREQ_EVENTS = new Set(["text.delta", "omp.raw"]);

/** webhook 目标守卫（M10）：GATEWAY_WEBHOOK_HOSTS_ALLOWLIST 非空时仅放行白名单 host（SSRF 收紧）。 */
export function isWebhookUrlAllowed(url: string): boolean {
  if (config.webhookHostAllowlist.length === 0) return true;
  try {
    const host = new URL(url).host.toLowerCase();
    return config.webhookHostAllowlist.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  } catch {
    return false;
  }
}

const hookCache = new Map<
  string,
  { hooks: Array<{ id: string; url: string; secret: string; events: string[] }>; at: number }
>();
const HOOK_TTL_MS = 10_000;

/**
 * 事件分发入口（SessionCtx.publish fire-and-forget 调用）。订阅集合带 10s 缓存；
 * 每次投递失败重试一次（2s 后）；函数永不抛错。
 */
export async function dispatchWebhookEvent(userId: string, sessionId: string, ev: GatewayEvent): Promise<void> {
  if (HIGH_FREQ_EVENTS.has(ev.type)) return;
  // 缓存键含 sessionId：会话级订阅与用户级订阅匹配集合不同（DESIGN §22）
  const cacheKey = `${userId}\0${sessionId}`;
  let cached = hookCache.get(cacheKey);
  if (!cached || Date.now() - cached.at > HOOK_TTL_MS) {
    if (cached) hookCache.delete(cacheKey); // 过期键即时回收（无淘汰扫描下的最低成本回收）
    const rows = listWebhooksForDispatch(userId, sessionId)
      .map((r) => {
        try {
          return { id: r.id, url: r.url, secret: r.secret, events: JSON.parse(r.events_json) as string[] };
        } catch {
          // 契约承诺本函数永不抛错：单行坏 events_json 只跳过该 hook，
          // 不让整批投递 reject（旧实现对坏行 unhandled rejection，拖垮该会话所有投递）
          return null;
        }
      })
      .filter((h): h is NonNullable<typeof h> => h !== null);
    cached = { hooks: rows, at: Date.now() };
    hookCache.set(cacheKey, cached);
  }
  for (const hook of cached.hooks) {
    if (!hook.events.includes("*") && !hook.events.includes(ev.type)) continue;
    if (!isWebhookUrlAllowed(hook.url)) continue; // 白名单双保险（注册期已挡）
    const body = JSON.stringify({ sessionId, event: ev });
    const sig = signPayload(hook.secret, body);
    // 单次重试（LiteLLM/logging 集成惯例）：失败或非 2xx → 2s 后重试一次
    void (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetch(hook.url, {
            method: "POST",
            headers: { "content-type": "application/json", [SIGNATURE_HEADER]: sig, "x-omp-session": sessionId },
            body,
            signal: AbortSignal.timeout(5_000),
          });
          if (res.ok) return;
        } catch {
          // 网络失败 → 重试
        }
        if (attempt === 0) await new Promise((r) => setTimeout(r, 2_000));
      }
    })();
  }
}

/** 注册/注销回调后失效缓存；不传 sessionId 则清该用户全部键（用户级变更影响所有会话）。 */
export function invalidateHookCache(userId: string, sessionId?: string): void {
  if (sessionId !== undefined) {
    hookCache.delete(`${userId}\0${sessionId}`);
    return;
  }
  // 用户级变更影响该用户所有会话的匹配集合
  for (const key of hookCache.keys()) {
    if (key.startsWith(`${userId}\0`)) hookCache.delete(key);
  }
}
