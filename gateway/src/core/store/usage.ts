// 用量统计（tenant-store 拆分，DESIGN §31）
import { db } from "./db.ts";

// ---- usage（token/成本统计，DESIGN §16）----

/** 单个 turn 的用量记录（SessionCtx 在 turn 终态写入）。 */
export interface UsageTurnRow {
  user_id: string;
  session_id: string;
  turn?: number | null;
  model_provider?: string | null;
  model_id?: string | null;
  input_tokens?: number;
  output_tokens?: number;
  cache_read?: number;
  cache_write?: number;
  total_tokens?: number;
  cost_usd?: number;
  duration_ms?: number | null;
  ttft_ms?: number | null;
}

/** 落一行 turn 用量（缺省字段补 0/null）。 */
export function insertUsage(u: UsageTurnRow): void {
  db.run(
    `INSERT INTO usage (user_id, session_id, turn, model_provider, model_id,
       input_tokens, output_tokens, cache_read, cache_write, total_tokens, cost_usd, duration_ms, ttft_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      u.user_id,
      u.session_id,
      u.turn ?? null,
      u.model_provider ?? null,
      u.model_id ?? null,
      u.input_tokens ?? 0,
      u.output_tokens ?? 0,
      u.cache_read ?? 0,
      u.cache_write ?? 0,
      u.total_tokens ?? 0,
      u.cost_usd ?? 0,
      u.duration_ms ?? null,
      u.ttft_ms ?? null,
    ],
  );
}

export interface UsageBucket {
  key: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costUsd: number;
}

const USAGE_SUM = `COUNT(*) AS turns,
  COALESCE(SUM(input_tokens),0) AS inputTokens,
  COALESCE(SUM(output_tokens),0) AS outputTokens,
  COALESCE(SUM(cache_read),0) AS cacheRead,
  COALESCE(SUM(cache_write),0) AS cacheWrite,
  COALESCE(SUM(total_tokens),0) AS totalTokens,
  COALESCE(SUM(cost_usd),0) AS costUsd`;

/** 会话级汇总（列表/详情内联展示用）。 */
export function sessionUsageSummary(sid: string): UsageBucket & { lastAt: string | null } {
  const row = db.query(`SELECT ${USAGE_SUM}, MAX(at) AS lastAt FROM usage WHERE session_id = ?`).get(sid) as any;
  return { key: sid, ...row };
}

/** 用户级聚合：group = day | model | session；from/to 为 ISO 日期（含当天）。 */
export function userUsage(uid: string, group: "day" | "model" | "session", from?: string, to?: string): UsageBucket[] {
  const keyExpr =
    group === "day"
      ? "substr(at,1,10)"
      : group === "model"
        ? "COALESCE(model_provider,'?')||'/'||COALESCE(model_id,'?')"
        : "session_id";
  const conds = ["user_id = ?"];
  const args: unknown[] = [uid];
  if (from) {
    conds.push("at >= ?");
    args.push(from);
  }
  if (to) {
    conds.push("at < date(?, '+1 day')");
    args.push(to);
  }
  const rows = db
    .query(
      `SELECT ${keyExpr} AS key, ${USAGE_SUM} FROM usage WHERE ${conds.join(" AND ")} GROUP BY ${keyExpr} ORDER BY key DESC`,
    )
    .all(...(args as any[])) as any[];
  return rows as UsageBucket[];
}

/** 全局总计（admin 面板）。 */
export function usageTotals(): { input: number; output: number; costUsd: number; turns: number } {
  const row = db
    .query(`SELECT COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output,
    COALESCE(SUM(cost_usd),0) AS costUsd, COUNT(*) AS turns FROM usage`)
    .get() as any;
  return row;
}

/** 会话最近 N 个 turn 的用量明细（时间倒序）。 */
export function usageTurns(
  sid: string,
  limit = 50,
): Array<
  Required<
    Pick<
      UsageTurnRow,
      | "turn"
      | "model_provider"
      | "model_id"
      | "input_tokens"
      | "output_tokens"
      | "total_tokens"
      | "cost_usd"
      | "duration_ms"
      | "ttft_ms"
    >
  > & { at: string }
> {
  return db
    .query(
      `SELECT turn, model_provider, model_id, input_tokens, output_tokens, total_tokens, cost_usd, duration_ms, ttft_ms, at
       FROM usage WHERE session_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(sid, limit) as any[];
}
