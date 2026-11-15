/** 控制台路由共享层（DESIGN §21 / §31）：会话访问 Façade + SDK 宽松视图。 */
import { createSessionAccess } from "../../core/session-access.ts";
import type { SessionAccess } from "../../core/session-access.ts";
import type { SessionCtx } from "../../core/session-registry.ts";
import type { SessionRow } from "../../core/tenant-store.ts";

export type ConsoleEnv = { Variables: { userId: string } };

export interface ConsoleBridgeDeps {
  ownedSession: (sid: string, userId: string) => SessionRow | undefined;
  getOrRevive: (row: SessionRow, userId: string) => Promise<SessionCtx | undefined>;
  jsonError: (c: any, status: any, code: string, message: string) => any;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ConsoleShared {
  live: SessionAccess["resolve"];
  s: (ctx: SessionCtx) => Record<string, any>;
  jsonError: ConsoleBridgeDeps["jsonError"];
}

export function createConsoleShared(deps: ConsoleBridgeDeps): ConsoleShared {
  const { ownedSession, getOrRevive, jsonError } = deps;
  const live = createSessionAccess({ ownedSession, getOrRevive, jsonError }).resolve;
  const s = (ctx: SessionCtx) => ctx.session as unknown as Record<string, any>;
  return { live, s, jsonError };
}
