/**
 * WrenAI 数据源管理面（DESIGN §39.2.1）：/admin/wren/*，组合根模式挂 admin.ts
 * （X-Admin-Id 门禁，requireAdmin 继承）。
 *
 * 数据源的唯一事实源是注册表 <dataRoot>/global/wren/datasources.json（core/wren/registry.ts）；
 * 本路由做运行时增删改查 + 生命周期触发：
 *   - GET  /datasources           列表（state/daemon 存活/models 数/同步观测；connection 脱敏）
 *   - GET  /datasources/:name     详情
 *   - PUT  /datasources/:name     创建/更新（合并 connection/tables）→ 全量 re-provision
 *                                  （daemon 强制重启，让新 MDL 快照生效，§39.5.1）→ 201/200
 *   - DELETE /datasources/:name   杀 daemon → mcp.json 移除 → 项目目录删除 → 注册表移除
 *   - POST /datasources/:name/rebuild  重内省 + 重生成 models + context build + daemon 重启
 *   - POST /datasources/:name/sync     按 drift 增量同步（{"force":true} 跳过短路；§39.2.2）
 *   - POST /sync                  全量遍历注册表逐个 drift 同步
 *   - POST /datasources/:name/test     仅连接测试（PG SELECT 1 / CH 内省 LIMIT 1），不落注册表
 * 全部 audit("admin.wren.*")；错误映射沿用 mgmtErr 风格。变更操作经 runWrenAdminOp
 * 串行化（与启动 provision 互斥，防注册表/daemon 竞态）。内省失败非致命：注册表记
 * lastError、GET state="error"，骨架与 daemon 照常（空模型集可用）。
 */
import { Hono } from "hono";
import { audit } from "../core/tenant-store.ts";
import { requireAdmin } from "../middleware/auth.ts";
import {
  allocateWrenPort,
  deprovisionWrenDatasource,
  loadWrenRegistry,
  provisionWrenDatasource,
  refreshDataQuerySkill,
  resolveWrenBin,
  runWrenAdminOp,
  saveWrenRegistry,
  syncAll,
  syncDatasource,
  testWrenConnection,
  WREN_DS_NAME_RE,
  WREN_DS_TYPE_RE,
  WREN_TABLE_REF_RE,
  wrenEntryDto,
} from "../core/wren.ts";
import type { WrenDsEntry } from "../core/wren.ts";

export const wrenAdminApp = new Hono();
wrenAdminApp.use("*", requireAdmin);

const actor = (c: any): string => c.get("adminId") ?? "admin";

/** 兜底 500（校验/404/409/503 由 gate() 与各路由内联返回，不经这里）。 */
const mgmtErr = (c: any, err: unknown) => {
  console.error("[admin-wren]", err);
  return c.json({ error: { code: "INTERNAL", message: "wren datasource operation failed" } }, 500);
};

/** 门禁：数据查询层启用（WREN_MCP=1）且 wren CLI 可用；返回 null 或错误响应。 */
function gate(c: any): Response | null {
  if (process.env.WREN_MCP !== "1") {
    return c.json({ error: { code: "WREN_DISABLED", message: "数据查询层未启用（需 WREN_MCP=1）" } }, 409);
  }
  if (!resolveWrenBin()) {
    return c.json({ error: { code: "WREN_UNAVAILABLE", message: "wren CLI 不可用（WREN_BIN/PATH 均未找到）" } }, 503);
  }
  return null;
}

/** tables 字段归一：undefined → null（= 全部非系统表）；null → null；数组逐条白名单校验。 */
function normalizeTables(v: unknown): { ok: true; tables: string[] | null } | { ok: false; reason: string } {
  if (v === undefined || v === null) return { ok: true, tables: null };
  if (!Array.isArray(v)) return { ok: false, reason: 'tables 必须为 null 或 "schema.table" 字符串数组' };
  for (const t of v) {
    if (typeof t !== "string" || !WREN_TABLE_REF_RE.test(t)) {
      return { ok: false, reason: `tables 条目非法（须为 "schema.table"，禁引号/空白/反斜杠）: ${JSON.stringify(t)}` };
    }
  }
  return { ok: true, tables: v.map(String) };
}

/** PUT 校验 + 合并：connection 浅合并（body 提供的字段覆盖），tables 显式给才替换。 */
function mergeEntry(
  existing: WrenDsEntry | undefined,
  body: Record<string, unknown>,
): { ok: true; entry: WrenDsEntry } | { ok: false; reason: string } {
  const datasource = body.datasource ?? existing?.datasource;
  if (typeof datasource !== "string" || !WREN_DS_TYPE_RE.test(datasource)) {
    return { ok: false, reason: 'body.datasource 必填且须为 wren 类型（如 "postgres"/"clickhouse"）' };
  }
  const rawConn = body.connection ?? existing?.connection;
  if (!rawConn || typeof rawConn !== "object" || Array.isArray(rawConn)) {
    return { ok: false, reason: "body.connection 必须为连接字段对象（字段以 wren docs connection-info <type> 为准）" };
  }
  const connection = { ...(existing?.connection ?? {}), ...(rawConn as Record<string, unknown>) };
  const tables = normalizeTables(body.tables);
  if (!tables.ok) return { ok: false, reason: tables.reason };
  const now = new Date().toISOString();
  return {
    ok: true,
    entry: {
      datasource,
      connection,
      tables: tables.tables,
      port: existing?.port ?? 0, // 占位：创建路径由调用方 allocateWrenPort 后覆写
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(existing?.daemonPid ? { daemonPid: existing.daemonPid } : {}),
      ...(existing?.generatedModels ? { generatedModels: existing.generatedModels } : {}),
      lastError: existing?.lastError ?? null,
    },
  };
}

// ---- 列表 / 详情 ----

wrenAdminApp.get("/datasources", async (c) => {
  try {
    const reg = await loadWrenRegistry();
    const dtos = await Promise.all(
      Object.keys(reg)
        .sort()
        .map((name) => wrenEntryDto(name, reg[name])),
    );
    return c.json({ datasources: dtos });
  } catch (err) {
    return mgmtErr(c, err);
  }
});

wrenAdminApp.get("/datasources/:name", async (c) => {
  const name = c.req.param("name");
  try {
    const reg = await loadWrenRegistry();
    const entry = reg[name];
    if (!entry) return c.json({ error: { code: "NOT_FOUND", message: "wren datasource not found" } }, 404);
    return c.json(await wrenEntryDto(name, entry));
  } catch (err) {
    return mgmtErr(c, err);
  }
});

// ---- 创建 / 更新（全量 re-provision，daemon 强制重启） ----

wrenAdminApp.put("/datasources/:name", async (c) => {
  const name = c.req.param("name");
  const gated = gate(c);
  if (gated) return gated;
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: { code: "BAD_REQUEST", message: "JSON body required" } }, 400);
  }
  if (!WREN_DS_NAME_RE.test(name)) {
    return c.json({ error: { code: "BAD_REQUEST", message: "name must match ^[a-z][a-z0-9-]{0,15}$" } }, 400);
  }
  const bin = resolveWrenBin()!;
  try {
    const result = await runWrenAdminOp(async () => {
      const reg = await loadWrenRegistry();
      const existing = reg[name];
      const merged = mergeEntry(existing, body as Record<string, unknown>);
      if (!merged.ok) return { status: 400, body: { error: { code: "BAD_REQUEST", message: merged.reason } } };
      const entry = merged.entry;
      if (!existing) entry.port = await allocateWrenPort(reg); // 创建时分配，稳定复用
      reg[name] = entry;
      await saveWrenRegistry(reg);
      const created = !existing;
      const provisioned = await provisionWrenDatasource(name, entry, bin, { restartDaemon: true });
      reg[name] = provisioned;
      await saveWrenRegistry(reg);
      await refreshDataQuerySkill(); // SKILL.md 的工具组清单随数据源变化
      audit("admin.wren.put", "global", name, actor(c), {
        created,
        datasource: provisioned.datasource,
        tables: provisioned.tables,
        port: provisioned.port,
        state: provisioned.lastError ? "error" : "ready",
      });
      return {
        status: created ? 201 : 200,
        body: { ...(await wrenEntryDto(name, provisioned)), note: "applies to new sessions (global/mcp.json 已更新)" },
      };
    });
    return result.status === 400 ? c.json(result.body, 400) : c.json(result.body, result.status as 200 | 201);
  } catch (err) {
    return mgmtErr(c, err);
  }
});

// ---- 删除（deprovision 清理链） ----

wrenAdminApp.delete("/datasources/:name", async (c) => {
  const name = c.req.param("name");
  // 删除不做 wren CLI 门禁：杀 pid/删目录/改 mcp.json 均进程内完成（但层总开关仍生效）
  if (process.env.WREN_MCP !== "1") {
    return c.json({ error: { code: "WREN_DISABLED", message: "数据查询层未启用（需 WREN_MCP=1）" } }, 409);
  }
  try {
    const result = await runWrenAdminOp(async () => {
      const reg = await loadWrenRegistry();
      const entry = reg[name];
      if (!entry) return { ok: false };
      await deprovisionWrenDatasource(name, entry);
      delete reg[name];
      await saveWrenRegistry(reg);
      await refreshDataQuerySkill(); // 移除该数据源的工具组说明
      audit("admin.wren.delete", "global", name, actor(c), { port: entry.port, datasource: entry.datasource });
      return { ok: true };
    });
    if (!result.ok) return c.json({ error: { code: "NOT_FOUND", message: "wren datasource not found" } }, 404);
    return c.json({ ok: true, note: "daemon 已停、项目目录与注册表条目已删；profiles.yml 残留条目无害" });
  } catch (err) {
    return mgmtErr(c, err);
  }
});

// ---- rebuild（重内省 + 重生成 + build + daemon 重启） ----

wrenAdminApp.post("/datasources/:name/rebuild", async (c) => {
  const name = c.req.param("name");
  const gated = gate(c);
  if (gated) return gated;
  const bin = resolveWrenBin()!;
  try {
    const result = await runWrenAdminOp(async () => {
      const reg = await loadWrenRegistry();
      const entry = reg[name];
      if (!entry) return null;
      const provisioned = await provisionWrenDatasource(name, entry, bin, { restartDaemon: true });
      reg[name] = provisioned;
      await saveWrenRegistry(reg);
      await refreshDataQuerySkill();
      audit("admin.wren.rebuild", "global", name, actor(c), {
        state: provisioned.lastError ? "error" : "ready",
      });
      return provisioned;
    });
    if (!result) return c.json({ error: { code: "NOT_FOUND", message: "wren datasource not found" } }, 404);
    return c.json(await wrenEntryDto(name, result));
  } catch (err) {
    return mgmtErr(c, err);
  }
});

// ---- sync（按 drift 增量同步；与 rebuild 的区别见 DESIGN §39.2.2）----

/**
 * POST /datasources/:name/sync：单源 drift 同步。body 可选 {"force":true} 跳过
 * catalogHash 短路（无内省器类型仅重编译 + 重启 daemon）。syncDatasource 自带
 * enqueueWrenOp 串行（不与 runWrenAdminOp 嵌套，避免队列内互等）。
 */
wrenAdminApp.post("/datasources/:name/sync", async (c) => {
  const name = c.req.param("name");
  const gated = gate(c);
  if (gated) return gated;
  const body = await c.req.json().catch(() => null);
  const force =
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    (body as Record<string, unknown>).force === true;
  try {
    if (!(await loadWrenRegistry())[name]) {
      return c.json({ error: { code: "NOT_FOUND", message: "wren datasource not found" } }, 404);
    }
    const result = await syncDatasource(name, { force });
    audit("admin.wren.sync", "global", name, actor(c), { changed: result.changed, reason: result.reason, force });
    return c.json(result);
  } catch (err) {
    return mgmtErr(c, err);
  }
});

/** POST /sync：全量遍历注册表逐个 drift 同步（单个失败不中断）。 */
wrenAdminApp.post("/sync", async (c) => {
  if (process.env.WREN_MCP !== "1") {
    return c.json({ error: { code: "WREN_DISABLED", message: "数据查询层未启用（需 WREN_MCP=1）" } }, 409);
  }
  try {
    const results = await syncAll();
    audit("admin.wren.sync_all", "global", "*", actor(c), {
      total: results.length,
      changed: results.filter((r) => r.changed).length,
    });
    return c.json({ results });
  } catch (err) {
    return mgmtErr(c, err);
  }
});

// ---- 连接测试（不落注册表） ----

wrenAdminApp.post("/datasources/:name/test", async (c) => {
  const name = c.req.param("name");
  if (process.env.WREN_MCP !== "1") {
    return c.json({ error: { code: "WREN_DISABLED", message: "数据查询层未启用（需 WREN_MCP=1）" } }, 409);
  }
  // body 可选：给 {datasource, connection} 即测未落库的载荷；否则测注册表里的既有条目
  const body = await c.req.json().catch(() => null);
  let override: { datasource: string; connection: Record<string, unknown> } | null = null;
  if (body && typeof body === "object" && !Array.isArray(body) && (body.datasource || body.connection)) {
    const merged = mergeEntry(undefined, body as Record<string, unknown>);
    if (!merged.ok) return c.json({ error: { code: "BAD_REQUEST", message: merged.reason } }, 400);
    override = { datasource: merged.entry.datasource, connection: merged.entry.connection };
  }
  try {
    const result = await runWrenAdminOp(async () => {
      const target = override ?? (await loadWrenRegistry())[name] ?? null;
      if (!target) return { notFound: true } as const;
      try {
        return { notFound: false as const, result: await testWrenConnection(target) };
      } catch (err) {
        return { notFound: false as const, result: { ok: false, detail: String(err) } };
      }
    });
    if (result.notFound) return c.json({ error: { code: "NOT_FOUND", message: "wren datasource not found" } }, 404);
    audit("admin.wren.test", "global", name, actor(c), { ok: result.result.ok });
    return c.json({ ok: result.result.ok, detail: result.result.detail });
  } catch (err) {
    return mgmtErr(c, err);
  }
});
