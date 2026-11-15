/**
 * 跨模块实例桥（globalThis + Symbol.for）：SDK 扩展在独立模块图加载，
 * 直接 import 网关模块会得到另一份 sessionMap；扩展与网关必须共享同一桥。
 */
/**
 * 进程级桥（跨模块实例）：SDK 的扩展加载器会在**独立模块图**中 import 扩展，
 * 扩展再 import 本文件时拿到的是另一个模块实例（单例不共享，实测 mapSize=0）。
 * 用 globalThis + Symbol.for 共享会话映射与分发实现——网关主体先于扩展加载，
 * 因此 bridge.dispatch 由网关实例提供，扩展只调用。
 */
import type { HookEventName } from "./events.ts";
import type { HookOutcome } from "./types.ts";

const BRIDGE_KEY = Symbol.for("omp.gateway.hooks.v1");
interface HookBridge {
  sessionMap: Map<string, { sid: string; userId: string }>;
  dispatch?: (ompId: string, event: HookEventName, raw: Record<string, any>) => Promise<HookOutcome | null>;
}
const g = globalThis as unknown as Record<symbol, HookBridge | undefined>;
if (!g[BRIDGE_KEY]) g[BRIDGE_KEY] = { sessionMap: new Map() };
const hookBridge = g[BRIDGE_KEY];

/** omp session id → 网关会话身份（扩展进程内回调时反查）。 */
export function registerHookSession(ompSessionId: string, sid: string, userId: string): void {
  if (!ompSessionId) return;
  hookBridge.sessionMap.set(ompSessionId, { sid, userId });
}

/** 会话注销/归档时移除映射（不清理会随复活累积泄漏）。 */
export function unregisterHookSession(ompSessionId: string | undefined | null): void {
  if (!ompSessionId) return;
  hookBridge.sessionMap.delete(ompSessionId);
}

/** omp session id → 网关会话身份；未注册返回 undefined。 */
export function hookSessionOf(ompSessionId: string): { sid: string; userId: string } | undefined {
  return hookBridge.sessionMap.get(ompSessionId);
}

/** 已注册会话数（debug 日志用）。 */
export function hookSessionCount(): number {
  return hookBridge.sessionMap.size;
}

/** 网关主体安装 dispatch 实现；扩展模块实例只读复用（不重复建 DB/缓存）。 */
export function installBridgeDispatch(fn: NonNullable<HookBridge["dispatch"]>): void {
  if (!hookBridge.dispatch) hookBridge.dispatch = fn;
}

/** 供扩展调用（跨模块实例安全）：已由网关实例安装。 */
export function dispatchViaBridge(
  ompSessionId: string,
  event: HookEventName,
  raw: Record<string, any>,
): Promise<HookOutcome | null> {
  const fn = hookBridge.dispatch;
  if (!fn) return Promise.resolve(null);
  return fn(ompSessionId, event, raw);
}
