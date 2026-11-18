/**
 * SDK 桥共享上下文（DESIGN §31）。
 *
 * 每个能力模块（state/control/history/agents/...）都只拿到这一份 `SdkShared`：
 *  - `live`：统一会话访问（归属 → 归档检查 → 复活 → 409 映射，core/session-access.ts）
 *  - `modelOf`：SDK Model → {provider, modelId}
 *  - `jsonError` / `withTurnSlot` / `parseImages` / `ownedSession`
 *
 * 这样拆分后的路由模块不重复构造 Façade、也不会各自实现一套错误码。
 */
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { parseImages } from "../../core/images.ts";
import type { SessionAccess } from "../../core/session-access.ts";
import { createSessionAccess } from "../../core/session-access.ts";
import type { SessionCtx } from "../../core/session-registry.ts";
import type { SessionRow } from "../../core/tenant-store.ts";

export type SdkEnv = { Variables: { userId: string } };

export interface SdkBridgeDeps {
  ownedSession(sid: string, userId: string): SessionRow | undefined;
  getOrRevive(row: SessionRow, userId: string): Promise<SessionCtx | undefined>;
  withTurnSlot<T>(ctx: SessionCtx, userId: string, fn: () => Promise<T>): Promise<T>;
  jsonError(
    c: any,
    status: 400 | 401 | 403 | 404 | 409 | 413 | 500 | 501 | 503,
    code: string,
    message: string,
  ): Response;
  enforceTurnPolicy(
    userId: string,
  ): { status: 402 | 429; body: { error: { code: string; message: string } }; retryAfter?: number } | null;
}

export interface SdkShared {
  live: SessionAccess["resolve"];
  modelOf: (session: AgentSession) => { provider: string; modelId: string } | null;
  jsonError: SdkBridgeDeps["jsonError"];
  withTurnSlot: SdkBridgeDeps["withTurnSlot"];
  parseImages: typeof parseImages;
  ownedSession: SdkBridgeDeps["ownedSession"];
  enforceTurnPolicy: SdkBridgeDeps["enforceTurnPolicy"];
}

export function createSdkShared(deps: SdkBridgeDeps): SdkShared {
  const { ownedSession, getOrRevive, withTurnSlot, jsonError, enforceTurnPolicy } = deps;
  const live = createSessionAccess({ ownedSession, getOrRevive, jsonError }).resolve;
  const modelOf = (session: AgentSession) => {
    const m = (session as unknown as { model?: { provider?: string; id?: string } }).model;
    return m?.provider && m?.id ? { provider: m.provider, modelId: m.id } : null;
  };
  return { live, modelOf, jsonError, withTurnSlot, parseImages, ownedSession, enforceTurnPolicy };
}
