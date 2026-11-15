/**
 * 集成门面共享层（DESIGN §22 / §31）。
 *
 * 把「会话访问 + 安全取值 + 事件类型过滤 + 错误体」集中在一处，
 * inject / webhooks / hooks / business-events / http-tools 各模块复用。
 */
import type { SessionAccess } from "../../core/session-access.ts";
import { createSessionAccess } from "../../core/session-access.ts";
import type { SessionCtx } from "../../core/session-registry.ts";
import type { SessionRow } from "../../core/tenant-store.ts";

export type IntegrationEnv = { Variables: { userId: string } };

export interface IntegrationDeps {
  ownedSession: (sid: string, userId: string) => SessionRow | undefined;
  getOrRevive: (row: SessionRow, userId: string) => Promise<SessionCtx | undefined>;
  jsonError: (c: any, status: any, code: string, message: string) => any;
  withTurnSlot: <T>(ctx: SessionCtx, userId: string, fn: () => Promise<T>) => Promise<T>;
  enforceTurnPolicy: (userId: string) => { status: 402 | 429; body: unknown; retryAfter?: number } | null;
}

export interface IntegrationShared {
  live: SessionAccess["resolve"];
  /** SDK 会话的宽松视图（集成面只读探测，SDK 未建模的可选方法按需调用）。 */
  s: (ctx: SessionCtx) => Record<string, any>;
  safe: (fn: () => unknown) => any;
  allowType: (filter: string[]) => (type: string) => boolean;
  jsonError: IntegrationDeps["jsonError"];
  ownedSession: IntegrationDeps["ownedSession"];
  withTurnSlot: IntegrationDeps["withTurnSlot"];
  enforceTurnPolicy: IntegrationDeps["enforceTurnPolicy"];
}

/* eslint-disable @typescript-eslint/no-explicit-any */

export function createIntegrationShared(deps: IntegrationDeps): IntegrationShared {
  const { ownedSession, getOrRevive, jsonError, withTurnSlot, enforceTurnPolicy } = deps;
  const live = createSessionAccess({ ownedSession, getOrRevive, jsonError }).resolve;
  const s = (ctx: SessionCtx) => ctx.session as unknown as Record<string, any>;
  const safe = (fn: () => unknown) => {
    try {
      return fn() ?? null;
    } catch {
      return null;
    }
  };
  const allowType =
    (filter: string[]) =>
    (type: string): boolean => {
      if (filter.length === 0) return true;
      return filter.some((f) => (f.endsWith("*") ? type.startsWith(f.slice(0, -1)) : type === f));
    };
  return { live, s, safe, allowType, jsonError, ownedSession, withTurnSlot, enforceTurnPolicy };
}
