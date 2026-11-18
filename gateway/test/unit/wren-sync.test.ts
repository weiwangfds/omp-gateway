/**
 * 无人值守 schema 同步单测（M34/v3，DESIGN §39.2.2）：表指纹稳定性、全目录哈希、
 * planModelWrites 六情形全覆盖（含特殊字符列名/解析失败/M33 旧文件升级自愈）、注册表
 * catalogHash 向后兼容（旧 JSON 缺字段 = 未同步过）、WREN_AUTO_SYNC_MIN 解析。
 * 纯函数为主，不依赖本机 wren（WREN_BIN 指向不存在的路径）；注册表文件快照/还原隔离。
 * 注：fixture 只有 public 一个 schema（无同名冲突）→ 模型目录名 = 表名（orders/events/sync_demo）。
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  buildModelDocs,
  catalogHash,
  mdlModelsFromRows,
  parseModelYaml,
  planModelWrites,
  tableFingerprint,
} from "../../src/core/wren/models.ts";
import {
  loadWrenRegistry,
  saveWrenRegistry,
  wrenRegistryPath,
  type WrenDsEntry,
} from "../../src/core/wren/registry.ts";
import { wrenAutoSyncMinutes } from "../../src/core/wren/sync.ts";
import type { WrenCatalogRow } from "../../src/core/wren/introspect/types.ts";

process.env.WREN_BIN = "/nonexistent/wren";

// 业务目录行（系统 schema 在内省 SQL 层已排除，不会到模型生成器）
const rows: WrenCatalogRow[] = [
  { schema: "public", table: "orders", column: "id", type: "integer" },
  { schema: "public", table: "orders", column: "金额", type: "numeric" },
  { schema: "public", table: "events", column: "id", type: "integer" },
];

/** 用测试行生成 model 集（keyed by 模型目录名）。 */
const docsFor = (r: WrenCatalogRow[], tables: string[] | null = null) => mdlModelsFromRows(r, tables, "shop", false);

/** 模拟 agent enrich：替换 properties.description 行。 */
const enrich = (yaml: string, description: string) =>
  yaml.replace(/^ {2}description: .*$/m, `  description: ${JSON.stringify(description)}`);

const mapOf = (files: Record<string, string>) => new Map(Object.entries(files).map(([k, content]) => [k, { content }]));

describe("wren sync：tableFingerprint / catalogHash", () => {
  test("同集合不同行序 → 同指纹；列类型变/列增删 → 指纹变；无关表行不影响", () => {
    const a = tableFingerprint(rows, "public", "orders");
    const shuffled: WrenCatalogRow[] = [rows[1], rows[0], rows[2]];
    expect(tableFingerprint(shuffled, "public", "orders")).toBe(a);
    // 类型变
    const typeChanged: WrenCatalogRow[] = [rows[0], { ...rows[1], type: "decimal" }, rows[2]];
    expect(tableFingerprint(typeChanged, "public", "orders")).not.toBe(a);
    // 列增
    const colAdded: WrenCatalogRow[] = [...rows, { schema: "public", table: "orders", column: "region", type: "text" }];
    expect(tableFingerprint(colAdded, "public", "orders")).not.toBe(a);
    // 其他表的行（含系统 schema）不参与该表指纹
    expect(
      tableFingerprint(
        rows.filter((r) => r.table === "orders"),
        "public",
        "orders",
      ),
    ).toBe(a);
    expect(
      tableFingerprint(
        [...rows, { schema: "pg_catalog", table: "pg_class", column: "relname", type: "name" }],
        "public",
        "orders",
      ),
    ).toBe(a);
    // 12 位十六进制
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });

  test("catalogHash：行序无关；任何表变化 → 哈希变", () => {
    const h = catalogHash(rows);
    expect(catalogHash([rows[2], rows[0], rows[1]])).toBe(h);
    expect(catalogHash(rows.slice(0, 2))).not.toBe(h); // 少一张表
    const extra = [...rows, { schema: "public", table: "sync_demo", column: "id", type: "integer" }];
    expect(catalogHash(extra)).not.toBe(h);
    expect(h).toMatch(/^[0-9a-f]{12}$/);
  });

  test("生成的 YAML 带所有权标记：gateway_generated + table_fingerprint（首次全量生成）", () => {
    const files = docsFor(rows);
    for (const yaml of Object.values(files)) {
      expect(yaml).toContain("  gateway_generated: true");
      expect(yaml).toMatch(/table_fingerprint: "[0-9a-f]{12}"/);
    }
    expect(files.orders).toContain(`  - name: "金额"`);
    expect(files.orders).toContain(`catalog: "shop"`);
  });
});

describe("wren sync：planModelWrites 六情形", () => {
  test("① 指纹一致 → 全部 unchanged，不写文件不删除（agent enrich 安全）", () => {
    const plan = planModelWrites({
      existing: mapOf(docsFor(rows)),
      rows,
      tables: null,
      catalog: "shop",
      omitCatalog: false,
    });
    expect(plan.writes).toEqual({});
    expect(plan.deletes).toEqual([]);
    expect(plan.unchanged.sort()).toEqual(["events", "orders"]);
  });

  test("② 指纹变 + gateway_generated → 重写结构并保留 agent description；指纹打上新值", () => {
    const old = docsFor(rows);
    const enrichedOrders = enrich(old.orders, "订单表：核心业务事实表，金额单位为元");
    const newRows: WrenCatalogRow[] = [...rows, { schema: "public", table: "orders", column: "region", type: "text" }];
    const plan = planModelWrites({
      existing: mapOf({ orders: enrichedOrders, events: old.events }),
      rows: newRows,
      tables: null,
      catalog: "shop",
      omitCatalog: false,
    });
    expect(Object.keys(plan.writes)).toEqual(["orders"]);
    expect(plan.unchanged).toEqual(["events"]);
    expect(plan.deletes).toEqual([]);
    const rewritten = plan.writes.orders;
    expect(rewritten).toContain('"订单表：核心业务事实表，金额单位为元"'); // enrich 保留
    expect(rewritten).not.toContain("网关内省自动生成");
    expect(rewritten).toContain(`  - name: "region"`); // 新列进结构
    expect(rewritten).toContain(`  - name: "金额"`); // 原列保留
    // 指纹更新为新表的指纹
    expect(rewritten).toContain(`table_fingerprint: "${tableFingerprint(newRows, "public", "orders")}"`);
    expect(rewritten).toContain("  gateway_generated: true");
  });

  test("③ 指纹变 + 非网关生成（手建）→ 跳过不动；⑥ 表消失 + 手建 → 保留", () => {
    const handBuilt = `name: "orders"
properties:
  description: "订单事实表（agent 手建，含自定义注释）"
table_reference:
  schema: "public"
  table: "orders"
columns:
  - name: "id"
    type: "integer"
`;
    // ③ 行变：手建文件不出现在 writes/unchanged
    const changed: WrenCatalogRow[] = [...rows, { schema: "public", table: "orders", column: "region", type: "text" }];
    const plan = planModelWrites({
      existing: mapOf({ orders: handBuilt, events: docsFor(rows).events }),
      rows: changed,
      tables: null,
      catalog: "shop",
      omitCatalog: false,
    });
    expect(Object.hasOwn(plan.writes, "orders")).toBeFalse();
    expect(plan.unchanged).toEqual(["events"]);
    // ⑥ 表消失：手建文件不在 deletes
    const gone: WrenCatalogRow[] = rows.filter((r) => r.table !== "orders");
    const plan2 = planModelWrites({
      existing: mapOf({ orders: handBuilt, events: docsFor(rows).events }),
      rows: gone,
      tables: null,
      catalog: "shop",
      omitCatalog: false,
    });
    expect(plan2.deletes).toEqual([]);
    expect(plan2.writes).toEqual({});
  });

  test("④ 新表（白名单内）→ 生成（带标记）；⑤ 表消失 + 网关生成 → deletes", () => {
    const old = docsFor(rows);
    // ④ 新表出现在 rows（初始内省时 sync_demo 尚不存在）
    const withNew: WrenCatalogRow[] = [
      ...rows,
      { schema: "public", table: "sync_demo", column: "id", type: "integer" },
    ];
    const plan = planModelWrites({
      existing: mapOf(old),
      rows: withNew,
      tables: null,
      catalog: "shop",
      omitCatalog: false,
    });
    expect(Object.keys(plan.writes)).toEqual(["sync_demo"]);
    expect(plan.writes.sync_demo).toContain("  gateway_generated: true");
    expect(plan.writes.sync_demo).toContain(`table_fingerprint: "${tableFingerprint(withNew, "public", "sync_demo")}"`);
    expect(plan.unchanged.sort()).toEqual(["events", "orders"]);
    expect(plan.deletes).toEqual([]);
    // ⑤ 表消失 + 网关生成 → 删除
    const plan2 = planModelWrites({
      existing: mapOf({ ...old, sync_demo: docsFor(withNew).sync_demo }),
      rows,
      tables: null,
      catalog: "shop",
      omitCatalog: false,
    });
    expect(plan2.deletes).toEqual(["sync_demo"]);
    expect(plan2.writes).toEqual({});
    expect(plan2.unchanged.sort()).toEqual(["events", "orders"]);
  });

  test("解析失败（agent 大改结构）→ 视为手建跳过；M33 旧文件（无标记+占位文案）→ 升级自愈重写", () => {
    const changed: WrenCatalogRow[] = [...rows, { schema: "public", table: "orders", column: "region", type: "text" }];
    // 解析失败：无顶层 name
    const garbage = "hello: [\n  world\n";
    const plan = planModelWrites({
      existing: mapOf({ orders: garbage }),
      rows: changed,
      tables: null,
      catalog: "shop",
      omitCatalog: false,
    });
    expect(Object.hasOwn(plan.writes, "orders")).toBeFalse(); // 坏文件不重写
    expect(plan.deletes).toEqual([]);
    // M33 旧文件：description 是占位文案、无所有权标记 → 视为网关生成，重写并补指纹
    const m33 = docsFor(rows)
      .orders.replace(/^ {2}gateway_generated: true\n/m, "")
      .replace(/^ {2}table_fingerprint: .*\n/m, "");
    expect(m33).not.toContain("gateway_generated");
    const plan2 = planModelWrites({
      existing: mapOf({ orders: m33 }),
      rows: changed,
      tables: null,
      catalog: "shop",
      omitCatalog: false,
    });
    expect(Object.hasOwn(plan2.writes, "orders")).toBeTrue();
    expect(plan2.writes.orders).toContain("  gateway_generated: true");
    expect(plan2.writes.orders).toMatch(/table_fingerprint: "[0-9a-f]{12}"/);
  });

  test("tables 白名单：白名单外的新表不生成；parseModelYaml 对 enrich/手建/坏文件分类正确", () => {
    const withNew: WrenCatalogRow[] = [
      ...rows,
      { schema: "public", table: "sync_demo", column: "id", type: "integer" },
    ];
    const plan = planModelWrites({
      existing: mapOf(docsFor(rows)),
      rows: withNew,
      tables: ["public.orders", "public.events"],
      catalog: "shop",
      omitCatalog: false,
    });
    expect(plan.writes).toEqual({}); // sync_demo 不在白名单 → 不生成
    expect(plan.unchanged.length).toBe(2);
    // 解析器分类
    const docs = buildModelDocs(rows, null, "shop", false);
    const ok = parseModelYaml(docs.orders.yaml);
    expect(ok).toMatchObject({ name: "orders", gatewayGenerated: true });
    expect(ok!.fingerprint).toBe(tableFingerprint(rows, "public", "orders"));
    expect(ok!.description).toContain("网关内省自动生成（public.orders）");
    const enriched = parseModelYaml(enrich(docs.orders.yaml, "自定义描述"));
    expect(enriched!.description).toBe("自定义描述");
    expect(parseModelYaml("not-a-model: true")).toBeNull();
  });
});

describe("wren sync：注册表向后兼容", () => {
  let snapshot: string | null = null;

  test("旧 JSON 缺同步字段 → 视为未同步过（缺键）；新字段 save→load 往返", async () => {
    snapshot = await fs.readFile(wrenRegistryPath(), "utf8").catch(() => null);
    const oldEntry = {
      datasource: "postgres",
      connection: { host: "h", password: "pw" },
      tables: null,
      port: 9320,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      lastError: null,
    };
    const synced: WrenDsEntry = {
      ...(oldEntry as WrenDsEntry),
      catalogHash: "abc123def456",
      lastSyncedAt: "2026-11-17T00:00:00.000Z",
      lastDriftAt: "2026-11-17T01:00:00.000Z",
      lastSyncError: null,
    };
    await fs.mkdir(path.dirname(wrenRegistryPath()), { recursive: true });
    await fs.writeFile(wrenRegistryPath(), `${JSON.stringify({ pg: oldEntry, ch: synced }, null, 2)}\n`, "utf8");
    const loaded = await loadWrenRegistry();
    // 旧条目：同步字段缺省（= 未同步过）
    expect(loaded.pg.catalogHash).toBeUndefined();
    expect(loaded.pg.lastSyncedAt).toBeUndefined();
    expect(loaded.pg.lastDriftAt).toBeUndefined();
    expect(loaded.pg.lastSyncError).toBeUndefined();
    // 新条目：字段原样往返
    expect(loaded.ch.catalogHash).toBe("abc123def456");
    expect(loaded.ch.lastSyncedAt).toBe("2026-11-17T00:00:00.000Z");
    expect(loaded.ch.lastDriftAt).toBe("2026-11-17T01:00:00.000Z");
    expect(loaded.ch.lastSyncError).toBeNull();
    await saveWrenRegistry(loaded);
    expect(await loadWrenRegistry()).toEqual(loaded);
  });

  afterAll(async () => {
    if (snapshot !== null) await fs.writeFile(wrenRegistryPath(), snapshot, "utf8");
    else await fs.rm(wrenRegistryPath(), { force: true });
  });
});

describe("wren sync：WREN_AUTO_SYNC_MIN 解析", () => {
  const withEnv = (v: string | undefined, fn: () => void) => {
    const saved = process.env.WREN_AUTO_SYNC_MIN;
    if (v === undefined) delete process.env.WREN_AUTO_SYNC_MIN;
    else process.env.WREN_AUTO_SYNC_MIN = v;
    try {
      fn();
    } finally {
      if (saved === undefined) delete process.env.WREN_AUTO_SYNC_MIN;
      else process.env.WREN_AUTO_SYNC_MIN = saved;
    }
  };

  test("默认 1440；0 = 关闭；正整数生效；非法回落默认；超上限视为非法", () => {
    withEnv(undefined, () => expect(wrenAutoSyncMinutes()).toBe(1440));
    withEnv("0", () => expect(wrenAutoSyncMinutes()).toBe(0));
    withEnv("30", () => expect(wrenAutoSyncMinutes()).toBe(30));
    withEnv("1440", () => expect(wrenAutoSyncMinutes()).toBe(1440));
    withEnv("abc", () => expect(wrenAutoSyncMinutes()).toBe(1440));
    withEnv("-5", () => expect(wrenAutoSyncMinutes()).toBe(1440));
    withEnv("3.5", () => expect(wrenAutoSyncMinutes()).toBe(1440));
    withEnv("99999999", () => expect(wrenAutoSyncMinutes()).toBe(1440)); // 超上限（setInterval 安全域）→ 非法
    withEnv("43200", () => expect(wrenAutoSyncMinutes()).toBe(43200)); // 上限内合法
  });
});

afterAll(() => {
  delete process.env.WREN_AUTO_SYNC_MIN;
});
