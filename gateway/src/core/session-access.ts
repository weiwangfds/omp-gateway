import type { SessionRow } from "./tenant-store.ts";
import type { SessionCtx } from "./session-registry.ts";

/**
 * 会话访问门面（Façade + Factory）：统一「取当前用户的会话 + 按需复活 + 错误映射」。
 *
 * 此前 session-sdk / session-console / session-integration 各写一份 live()（含 revive
 * 失败→409 的映射），三处逻辑必须同步修改。集中后路由只依赖 `resolve(c)`，
 * 新增会话级路由不会漏掉守卫或错误码。
 */
/** 路由注入的三个依赖：归属查询、按文件复活、统一错误体。 */
export interface SessionAccessDeps {
  ownedSession: (sid: string, userId: string) => SessionRow | undefined;
  getOrRevive: (row: SessionRow, userId: string) => Promise<SessionCtx | undefined>;
  jsonError: (c: any, status: any, code: string, message: string, details?: unknown) => any;
}

/** resolve 的结果：二选一，调用方 `"error" in r` 分支。 */
export type SessionAccessResult = { row: SessionRow; ctx: SessionCtx } | { error: any };

export interface SessionAccess {
  /** 需要 live 会话（内存未命中时按 sessionFile 复活）：`{ error }` 或 `{ row, ctx }`。 */
  resolve: (c: any) => Promise<SessionAccessResult>;
  /** 只做归属与归档检查（不复活）：快照列表这类只读元数据场景。 */
  resolveRow: (c: any) => { row: SessionRow } | { error: any };
}

/** 构造会话访问门面。每个路由域（sdk/console/integration）各建一份，deps 由组合根注入。 */
export function createSessionAccess(deps: SessionAccessDeps): SessionAccess {
  const { ownedSession, getOrRevive, jsonError } = deps;

  // 闭包而非 this：调用方常解构（`const live = access.resolve`），this 绑定会丢
  function resolveRow(c: any): { row: SessionRow } | { error: any } {
    const row = ownedSession(c.req.param("sid"), c.get("userId"));
    if (!row) return { error: jsonError(c, 404, "NOT_FOUND", "session not found") };
    if (row.status !== "active") {
      return { error: jsonError(c, 409, "SESSION_ARCHIVED", `session status: ${row.status}`) };
    }
    return { row };
  }

  async function resolve(c: any): Promise<SessionAccessResult> {
    const base = resolveRow(c);
    if ("error" in base) return base;
    let ctx: SessionCtx | undefined;
    try {
      ctx = await getOrRevive(base.row, c.get("userId"));
    } catch (err) {
      // 复活失败（会话文件的模型不可用等）→ 409 明确错误，不裸 500（DESIGN §25）
      const e = err as { code?: string; message?: string };
      return { error: jsonError(c, 409, e?.code ?? "REVIVE_FAILED", e?.message ?? String(err)) };
    }
    if (!ctx) return { error: jsonError(c, 409, "SESSION_NOT_LIVE", "no session file to revive") };
    return { row: base.row, ctx };
  }

  return { resolve, resolveRow };
}
