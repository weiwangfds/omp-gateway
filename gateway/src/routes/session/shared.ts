/**
 * 会话路由共享层（DESIGN §31）。
 *
 * 这里放"跨模块复用且带语义"的守卫/编排，而不是纯工具函数：
 *  - jsonError / ownedSession：统一错误体与租户归属（404 不泄露存在性）
 *  - withIdempotency：建会话/建快照的 24h 重放
 *  - enforceTurnPolicy：预算 402 + RPM 429
 *  - withTurnSlot：流式并发槽位（空闲会话才占槽，排队超时 429）
 *  - getOrRevive / requireLive：内存未命中时按 sessionFile 复活
 *
 * lifecycle/conversation/model/sharing/events 各模块只依赖本文件，
 * 不各自实现一套守卫，新增会话面子路由不会漏掉配额/复活/错误码。
 */
import { createHash } from "node:crypto";
import { config } from "../../config.ts";
import { createGatewaySession } from "../../core/session-factory.ts";
import { registry, type SessionCtx } from "../../core/session-registry.ts";
import { RateLimitedError, checkRpm, countBudgetExceeded, countRateLimited } from "../../core/rate-limit.ts";
import { streamingGate } from "../../core/streaming-gate.ts";
import { fromStorePath } from "../../core/paths.ts";
import {
  getOrCreateTenant,
  getSession,
  idempotencyGet,
  idempotencyPut,
  monthCostUsd,
  tenantLimits,
  type SessionRow,
} from "../../core/tenant-store.ts";

export type SessionEnv = { Variables: { userId: string } };

export function jsonError(
  c: any,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 500 | 501 | 503,
  code: string,
  message: string,
) {
  return c.json({ error: { code, message } }, status);
}

export function ownedSession(sid: string, userId: string): SessionRow | undefined {
  const row = getSession(sid);
  // 归属失配或已删除一律 404（不泄漏存在性，DESIGN §10；trash 恢复走 /internal，M3）
  return row && row.user_id === userId && row.status !== "deleted" ? row : undefined;
}

/** 幂等包装（DESIGN §7）：Idempotency-Key 命中 24h 窗口内同 user+scope 的响应则重放（仅缓存 2xx）。 */
export async function withIdempotency(
  c: any,
  userId: string,
  scope: string,
  fn: () => Promise<{ status: number; body: unknown }>,
): Promise<Response> {
  const key = c.req.header("idempotency-key");
  if (!key) {
    const out = await fn();
    return c.json(out.body as any, out.status as any);
  }
  const keyHash = createHash("sha256").update(`${userId}:${scope}:${key}`).digest("hex");
  const hit = idempotencyGet(keyHash);
  if (hit) {
    c.header("Idempotency-Replayed", "true");
    return c.json(JSON.parse(hit.response_json), hit.status_code as any);
  }
  const out = await fn();
  if (out.status < 400) idempotencyPut(keyHash, out.status, JSON.stringify(out.body));
  return c.json(out.body as any, out.status as any);
}

/** 开启新 turn 前的租户策略：预算硬约束（402）+ RPM 限流（429）。null = 通过。 */
export function enforceTurnPolicy(userId: string): {
  status: 402 | 429;
  body: { error: { code: string; message: string } };
  retryAfter?: number;
} | null {
  const limits = tenantLimits(getOrCreateTenant(userId));
  if (limits.monthlyBudgetUsd && monthCostUsd(userId) >= limits.monthlyBudgetUsd) {
    countBudgetExceeded();
    return {
      status: 402,
      body: { error: { code: "BUDGET_EXCEEDED", message: `monthly budget ${limits.monthlyBudgetUsd} USD exceeded` } },
    };
  }
  try {
    checkRpm(userId, limits.rpm ?? null);
  } catch (err) {
    if (err instanceof RateLimitedError) {
      countRateLimited();
      return {
        status: 429,
        body: { error: { code: "RATE_LIMITED", message: err.message } },
        retryAfter: err.retryAfterSec,
      };
    }
    throw err;
  }
  return null;
}

// 每用户 streaming 槽位上限来自 tenants 限额（M2：maxConcurrent 真正执行）
streamingGate.setUserLimitProvider((uid) => tenantLimits(getOrCreateTenant(uid)).maxConcurrent);

/**
 * 流式槽位封装（M2，DESIGN §8）：idle 会话上开启新 turn（prompt/steer）前持槽；
 * 已在 streaming（steer/排队进 omp）不新增并发 turn，不占槽。
 */
export async function withTurnSlot<T>(ctx: SessionCtx, userId: string, fn: () => Promise<T>): Promise<T> {
  const wasStreaming = ctx.streaming;
  let release: (() => void) | null = null;
  let off: (() => void) | null = null;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  const cleanup = () => {
    off?.();
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = null;
    release?.();
    release = null;
  };
  if (!wasStreaming) {
    release = await streamingGate.acquire(userId, config.streamQueueTimeoutMs);
    // 排队期间会话可能已被回收（IdleCuller/删除）
    if (registry.get(ctx.sid) !== ctx) {
      release();
      const err = new Error("session no longer live after queue wait");
      (err as any).code = "SESSION_NOT_LIVE";
      throw err;
    }
    off = ctx.onTerminal(cleanup);
    holdTimer = setTimeout(cleanup, config.streamMaxHoldMs);
    holdTimer.unref?.();
  }
  try {
    const out = await fn();
    // 排队进 omp（会话本就 streaming）或未能开 turn：不占槽，立即释放
    if (wasStreaming || !ctx.streaming) cleanup();
    return out;
  } catch (err) {
    cleanup();
    throw err;
  }
}

/** 取活跃 ctx；不在内存时按 sessionFile 复活（IdleCuller 后的"下条消息秒醒"）。 */
export async function getOrRevive(row: SessionRow, userId: string): Promise<SessionCtx | undefined> {
  const existing = registry.get(row.id);
  if (existing) return existing;
  if (!row.session_file) return undefined;
  try {
    const { ctx } = await createGatewaySession({
      userId,
      sid: row.id,
      resumeSessionFile: fromStorePath(row.session_file),
    });
    registry.register(ctx);
    ctx.publish({ type: "session.status", status: "idle" });
    return ctx;
  } catch (err) {
    // 会话文件引用的模型已不可用（模型被删/换 provider/导入文件缺 model_change）：
    // 明确映射为 409 MODEL_UNAVAILABLE，而不是裸 500（DESIGN §25 导入语义）
    const msg = err instanceof Error ? err.message : String(err);
    if (/Could not restore model/i.test(msg) || (err as { name?: string })?.name === "SessionModelRestoreError") {
      const e = new Error(
        `session file references an unavailable model; set an available model (POST /api/sessions/${row.id}/model) or add the provider to models.yml`,
      );
      (e as { code?: string }).code = "MODEL_UNAVAILABLE";
      throw e;
    }
    throw err;
  }
}

export async function requireLive(c: any): Promise<{ row: SessionRow; ctx: SessionCtx } | { error: Response }> {
  const row = ownedSession(c.req.param("sid"), c.get("userId"));
  if (!row) return { error: jsonError(c, 404, "NOT_FOUND", "session not found") };
  if (row.status !== "active") return { error: jsonError(c, 409, "SESSION_ARCHIVED", `session status: ${row.status}`) };
  const ctx = await getOrRevive(row, c.get("userId"));
  if (!ctx) return { error: jsonError(c, 409, "SESSION_NOT_LIVE", "session has no session file to revive") };
  return { row, ctx };
}
