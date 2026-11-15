import { describe, expect, test } from "bun:test";
import {
  activeSessionCount,
  audit,
  getOrCreateTenant,
  getSession,
  insertSession,
  listSessions,
  setSessionStatus,
  setTenantStatus,
  tenantLimits,
  touchSession,
  updateTenantLimits,
} from "../../src/core/tenant-store.ts";
import { config } from "../../src/config.ts";

const UID = "u-tenant-test";

describe("tenant-store", () => {
  test("懒 provision：幂等创建，默认限额来自 config", () => {
    const t1 = getOrCreateTenant(UID);
    const t2 = getOrCreateTenant(UID);
    expect(t1.user_id).toBe(UID);
    expect(t2.user_id).toBe(UID);
    const lim = tenantLimits(t1);
    expect(lim.maxSessions).toBe(config.defaultMaxSessions);
    expect(lim.maxConcurrent).toBe(config.defaultMaxConcurrent);
    expect(lim.allowedProviders).toBeNull();
  });

  test("限额更新合并而非替换", () => {
    updateTenantLimits(UID, { maxSessions: 3 });
    updateTenantLimits(UID, { allowedProviders: ["minimax"] });
    const lim = tenantLimits(getOrCreateTenant(UID));
    expect(lim.maxSessions).toBe(3);
    expect(lim.allowedProviders).toEqual(["minimax"]);
    expect(lim.maxConcurrent).toBe(config.defaultMaxConcurrent); // 未触碰的字段保留默认
  });

  test("租户状态迁移", () => {
    setTenantStatus(UID, "disabled");
    expect(getOrCreateTenant(UID).status).toBe("disabled");
    setTenantStatus(UID, "active");
    expect(getOrCreateTenant(UID).status).toBe("active");
  });

  test("会话行 CRUD + 状态机 + active 计数", () => {
    insertSession({ id: "s1", user_id: UID, workspace_id: "ws1", title: "t" });
    insertSession({ id: "s2", user_id: UID, workspace_id: "ws2", parent_id: "s1" });
    expect(activeSessionCount(UID)).toBe(2);

    touchSession("s1", { title: "renamed", model_provider: "minimax", model_id: "M3" });
    const s1 = getSession("s1")!;
    expect(s1.title).toBe("renamed");
    expect(s1.model_provider).toBe("minimax");
    expect(s1.last_live_at).toBeTruthy();

    setSessionStatus("s1", "archived");
    expect(getSession("s1")!.status).toBe("archived");
    expect(getSession("s1")!.archived_at).toBeTruthy();
    expect(activeSessionCount(UID)).toBe(1);

    // 归档→回active 不覆盖首次归档时间戳的语义：COALESCE 保证 archived_at 保留
    setSessionStatus("s1", "active");
    expect(getSession("s1")!.archived_at).toBeTruthy();

    setSessionStatus("s2", "deleted");
    expect(getSession("s2")!.deleted_at).toBeTruthy();
    expect(listSessions(UID, "active").map((s) => s.id)).toEqual(["s1"]);
    expect(listSessions(UID, "deleted").map((s) => s.id)).toEqual(["s2"]);
  });

  test("血缘 parent_id 落库", () => {
    expect(getSession("s2")!.parent_id).toBe("s1");
  });

  test("audit 写入", () => {
    const before = auditCount();
    audit("test.action", "session", "s1", UID, { k: 1 });
    expect(auditCount()).toBe(before + 1);
  });

  function auditCount(): number {
    // 直接走同进程模块内的连接：借 audit 插入返回值不可行，改查独立连接（WAL 支持并发读）
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const db = new Database(`${config.dataRoot}/gateway.db`, { readonly: true });
    try {
      return (db.query("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n;
    } finally {
      db.close();
    }
  }
});
