// 租户 / 限额 / 审计（tenant-store 拆分，DESIGN §31）
import { config } from "../../config.ts";
import { db } from "./db.ts";
import type { TenantLimits, TenantRow } from "./types.ts";

/** 懒 provision：首次出现即建行（幂等），限额走 config 默认值。 */
export function getOrCreateTenant(uid: string): TenantRow {
  const existing = db.query("SELECT * FROM tenants WHERE user_id = ?").get(uid) as TenantRow | undefined;
  if (existing) return existing;
  db.run("INSERT INTO tenants (user_id) VALUES (?)", [uid]);
  return db.query("SELECT * FROM tenants WHERE user_id = ?").get(uid) as TenantRow;
}

/** limits_json → 生效限额；缺省字段回落 config 默认（懒 provision 后未 PATCH 过的用户）。 */
export function tenantLimits(t: TenantRow): TenantLimits {
  const raw = JSON.parse(t.limits_json || "{}") as Partial<TenantLimits>;
  return {
    maxSessions: raw.maxSessions ?? config.defaultMaxSessions,
    maxConcurrent: raw.maxConcurrent ?? config.defaultMaxConcurrent,
    allowedProviders: raw.allowedProviders ?? null,
    rpm: raw.rpm ?? null,
    monthlyBudgetUsd: raw.monthlyBudgetUsd ?? null,
  };
}

/** 用户当月已产生成本（预算约束用）。 */
export function monthCostUsd(userId: string): number {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const row = db
    .query("SELECT COALESCE(SUM(cost_usd),0) AS c FROM usage WHERE user_id = ? AND at >= ?")
    .get(userId, monthStart.toISOString()) as { c: number };
  return row.c;
}

/** 审计查询（内部契约，DESIGN §18）。 */
export function queryAudit(opts: { user?: string; action?: string; limit?: number; offset?: number }): {
  total: number;
  rows: Array<Record<string, unknown>>;
} {
  const conds: string[] = [];
  const args: unknown[] = [];
  if (opts.user) {
    conds.push("(on_behalf_of = ? OR actor = ?)");
    args.push(opts.user, opts.user);
  }
  if (opts.action) {
    conds.push("action = ?");
    args.push(opts.action);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const total = (db.query(`SELECT COUNT(*) AS n FROM audit_log ${where}`).get(...(args as any[])) as { n: number }).n;
  const rows = db
    .query(
      `SELECT at, actor, on_behalf_of, action, resource_type, resource_id, detail_json FROM audit_log ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
    )
    .all(...(args as any[]), limit, opts.offset ?? 0) as Array<Record<string, unknown>>;
  return { total, rows };
}

/** PATCH 语义：与现值合并而非整体替换；未触碰字段保留默认。 */
export function updateTenantLimits(uid: string, limits: Partial<TenantLimits>): void {
  const t = getOrCreateTenant(uid);
  const merged = { ...tenantLimits(t), ...limits };
  // 剔除 null/undefined 的可选字段（rpm/monthlyBudgetUsd 显式 null = 取消限制）
  const clean = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined));
  db.run("UPDATE tenants SET limits_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id = ?", [
    JSON.stringify(clean),
    uid,
  ]);
}

/** 租户状态机迁移：active → disabled（拒绝服务）→ deleted（级联清除由上游触发）。 */
export function setTenantStatus(uid: string, status: TenantRow["status"]): void {
  db.run("UPDATE tenants SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id = ?", [
    status,
    uid,
  ]);
}

/**
 * 审计落库：所有变更动作都要走这里（内部契约，DESIGN §18）。
 * actor 固定 "upstream"——网关不持有用户体系，操作者即注入 X-User-Id 的上游。
 */
export function audit(
  action: string,
  resourceType: string,
  resourceId: string,
  onBehalfOf: string,
  detail?: unknown,
): void {
  db.run(
    "INSERT INTO audit_log (actor, on_behalf_of, action, resource_type, resource_id, detail_json) VALUES (?,?,?,?,?,?)",
    ["upstream", onBehalfOf, action, resourceType, resourceId, detail ? JSON.stringify(detail) : null],
  );
}
