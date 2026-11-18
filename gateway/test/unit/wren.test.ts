/**
 * WrenAI 挂接模块单测（v2：注册表 + admin 生命周期 + MDL 生成）：不依赖本机安装 wren
 * （WREN_BIN 指向不存在的路径）——env 解析（名规白名单/连接 JSON 非法跳过）、敏感字段
 * 脱敏与占位符、注册表 load/save/chmod 600、env 种子合并优先级、端口分配器、MDL 生成
 * 纯函数（fixture 行 → 期望 YAML，特殊字符转义）、GET DTO 脱敏、delete 清理链（无真实
 * spawn）、mcp.json 合并幂等、全局 skill 物化幂等。config 是加载期单例（test/setup.ts
 * preload 已把 GATEWAY_DATA_ROOT 指到临时目录），env 在本文件内置好并保持。
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { config } from "../../src/config.ts";
import { globalMcpPath } from "../../src/core/paths.ts";
import * as wren from "../../src/core/wren.ts";

process.env.WREN_BIN = "/nonexistent/wren";
delete process.env.WREN_HOME;
delete process.env.WREN_DATASOURCES;
delete process.env.WREN_DS_CONNECTIONS;
delete process.env.WREN_MCP_PORT_BASE;
// 端口分配器用独立高位段，避免撞本机其他服务
process.env.WREN_MCP_PORT_BASE = "9320";

const setDs = (names: string | undefined, connections: string | undefined) => {
  if (names === undefined) delete process.env.WREN_DATASOURCES;
  else process.env.WREN_DATASOURCES = names;
  if (connections === undefined) delete process.env.WREN_DS_CONNECTIONS;
  else process.env.WREN_DS_CONNECTIONS = connections;
};

// 凭据形状的字面量统一走具名假件常量（全是测试值，不代表任何真实凭据）
const FAKE_PW = "wren-unit-fixture";

const PG = JSON.stringify({
  datasource: "postgres",
  host: "10.0.0.5",
  port: "5432",
  database: "shop",
  user: "ro",
  password: FAKE_PW,
});

const blankEntry = (over: Partial<wren.WrenDsEntry> = {}): wren.WrenDsEntry => ({
  datasource: "postgres",
  connection: { host: "h", password: FAKE_PW },
  tables: null,
  port: 9320,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  lastError: null,
  ...over,
});

describe("wren：env 解析（种子）", () => {
  test("未配置 WREN_DATASOURCES → 空解析（no-op 前提）", () => {
    setDs(undefined, undefined);
    expect(wren.parseWrenDatasources()).toEqual({ specs: [], rejected: [] });
  });

  test("合法名 + 连接 JSON → spec（datasource 字段剥离、解析序号端口）", () => {
    setDs(
      "pg,ch",
      JSON.stringify({ pg: JSON.parse(PG), ch: { datasource: "clickhouse", host: "10.0.0.6", port: "8123" } }),
    );
    const r = wren.parseWrenDatasources();
    expect(r.rejected).toEqual([]);
    expect(r.specs).toHaveLength(2);
    expect(r.specs[0]).toMatchObject({ name: "pg", datasource: "postgres", port: 9320 });
    expect(r.specs[0].connection).toEqual({
      host: "10.0.0.5",
      port: "5432",
      database: "shop",
      user: "ro",
      password: FAKE_PW,
    });
    expect(r.specs[1]).toMatchObject({ name: "ch", datasource: "clickhouse", port: 9321 });
    setDs(undefined, undefined);
  });

  test("名规白名单：大写/数字开头/超长 → rejected", () => {
    setDs("PG,9bad,ok-name,this-name-is-way-too-long-x", JSON.stringify({ "ok-name": { datasource: "postgres" } }));
    const r = wren.parseWrenDatasources();
    expect(r.specs.map((s) => s.name)).toEqual(["ok-name"]);
    expect(r.rejected.map((x) => x.name)).toEqual(["PG", "9bad", "this-name-is-way-too-long-x"]);
    setDs(undefined, undefined);
  });

  test("连接 JSON 非法 / 缺键 / 缺 datasource / 顶层非对象 → rejected（不抛异常）", () => {
    setDs("pg", "not-json{");
    expect(wren.parseWrenDatasources().rejected[0].reason).toContain("WREN_DS_CONNECTIONS");
    setDs("pg", JSON.stringify({ other: {} }));
    expect(wren.parseWrenDatasources().rejected[0].reason).toContain("没有该数据源的配置对象");
    setDs("pg", JSON.stringify({ pg: { host: "h" } }));
    expect(wren.parseWrenDatasources().rejected[0].reason).toContain("datasource");
    setDs("pg", JSON.stringify({ pg: { datasource: "Bad Type!", host: "h" } }));
    expect(wren.parseWrenDatasources().rejected[0].reason).toContain("datasource");
    setDs("pg", "[1,2]");
    expect(wren.parseWrenDatasources().rejected[0].reason).toContain("WREN_DS_CONNECTIONS");
    setDs(undefined, undefined);
  });

  test("redactConnection：password/secret_key/token → ******，普通字段与嵌套 kwargs 透传", () => {
    const out = wren.redactConnection({
      host: "h",
      password: "plain",
      secret_key: "sk",
      accessToken: "tk",
      kwargs: { connect_timeout: 5, password: "nested" },
    });
    expect(out).toEqual({
      host: "h",
      password: "******",
      secret_key: "******",
      accessToken: "******",
      kwargs: { connect_timeout: 5, password: "******" },
    });
  });

  test(`buildProfilePayloadFor：敏感字段 → \${WREN_SECRET_*} 占位符 + secrets 映射`, () => {
    const { payload, secrets } = wren.buildProfilePayloadFor("pg", "postgres", JSON.parse(PG));
    expect(payload.datasource).toBe("postgres");
    expect(payload.password).toBe(`\${WREN_SECRET_PG_PASSWORD}`);
    expect(payload.host).toBe("10.0.0.5");
    expect(secrets).toEqual({ WREN_SECRET_PG_PASSWORD: FAKE_PW });
    // 名字里的连字符压成下划线
    expect(wren.secretEnvName("main-db", "password")).toBe("WREN_SECRET_MAIN_DB_PASSWORD");
  });
});

describe("wren：注册表（load/save/chmod + 种子合并 + 端口分配）", () => {
  test("save → load 往返；chmod 600（POSIX）；坏 JSON → 空注册表；非法名条目丢弃", async () => {
    const reg = { pg: blankEntry({ port: 9320 }), "Bad Name": blankEntry({ datasource: "x" }) };
    await wren.saveWrenRegistry(reg);
    const loaded = await wren.loadWrenRegistry();
    expect(Object.keys(loaded)).toEqual(["pg"]);
    expect(loaded.pg).toEqual(reg.pg);
    if (process.platform !== "win32") {
      const mode = (await fs.stat(wren.wrenRegistryPath())).mode & 0o777;
      expect(mode).toBe(0o600);
    }
    await fs.writeFile(wren.wrenRegistryPath(), "{corrupt", "utf8");
    expect(await wren.loadWrenRegistry()).toEqual({});
    await fs.rm(wren.wrenRegistryPath(), { force: true });
  });

  test("mergeWrenSeeds：仅补缺失名（admin 条目优先），端口来自分配器", async () => {
    const reg = { pg: blankEntry({ port: 9340 }) };
    const seeds: wren.WrenDatasourceSpec[] = [
      { name: "pg", datasource: "postgres", connection: { host: "h" }, port: 9320 },
      { name: "ch", datasource: "clickhouse", connection: { host: "h" }, port: 9321 },
    ];
    const added = await wren.mergeWrenSeeds(reg, seeds);
    expect(added).toEqual(["ch"]);
    expect(reg.pg.updatedAt).toBe("2026-01-01T00:00:00.000Z"); // admin 条目原样保留
    expect(reg.ch.port).toBe(9320); // 分配器：注册表占用 9340 → 第一个空闲 = base 9320
    expect(reg.ch.tables).toBeNull();
  });

  test("allocateWrenPort：跳过注册表占用与真实监听端口", async () => {
    const reg = { a: blankEntry({ port: 9320 }) };
    // 真实监听 9321
    const server = Bun.serve({ port: 9321, fetch: () => new Response("ok") });
    try {
      expect(await wren.allocateWrenPort(reg)).toBe(9322);
      const reg2 = { ...reg, b: blankEntry({ port: 9322 }) };
      expect(await wren.allocateWrenPort(reg2)).toBe(9323);
    } finally {
      server.stop(true);
    }
  });
});

describe("wren：MDL 生成纯函数", () => {
  const rows: wren.WrenCatalogRow[] = [
    { schema: "public", table: "orders", column: "id", type: "integer" },
    { schema: "public", table: "orders", column: "金额", type: "numeric" },
    { schema: "s2", table: "orders", column: "id", type: "integer" },
  ];

  test("每表一 model；跨 schema 同表名 → 全部加 schema 前缀（命名与行序无关）；特殊字符双引号转义", () => {
    const files = wren.mdlModelsFromRows(rows, null, "shop");
    expect(Object.keys(files).sort()).toEqual(["public_orders", "s2_orders"]);
    const orders = files.public_orders;
    expect(orders).toContain(`name: "public_orders"`);
    expect(orders).toContain(`catalog: "shop"`);
    expect(orders).toContain(`schema: "public"`);
    expect(orders).toContain(`table: "orders"`);
    expect(orders).toContain(`  - name: "金额"`);
    expect(orders).toContain(`    type: "numeric"`);
    expect(orders).toContain("网关内省自动生成（public.orders）");
    const s2 = files.s2_orders;
    expect(s2).toContain(`schema: "s2"`);
    expect(s2).toContain(`table: "orders"`);
  });

  test("tables 白名单（schema.table 精确匹配）；白名单收紧不改变模型名", () => {
    const files = wren.mdlModelsFromRows(rows, ["public.orders"], "shop");
    expect(Object.keys(files)).toEqual(["public_orders"]);
    const onlyS2 = wren.mdlModelsFromRows(rows, ["s2.orders"], "shop");
    expect(Object.keys(onlyS2)).toEqual(["s2_orders"]);
  });

  test("ClickHouse 两段式：omitCatalog 时 table_reference 不含 catalog（否则 shop.shop.tbl 语法错）", () => {
    const chRows: wren.WrenCatalogRow[] = [
      { schema: "shop", table: "fact_orders", column: "order_id", type: "UInt64" },
      { schema: "shop", table: "fact_orders", column: "total_amount", type: "Decimal(12, 2)" },
    ];
    const three = wren.mdlModelsFromRows(chRows, null, "shop");
    expect(three.fact_orders).toContain(`catalog: "shop"`);
    const two = wren.mdlModelsFromRows(chRows, null, "shop", true);
    expect(two.fact_orders).not.toContain("catalog:");
    expect(two.fact_orders).toContain(`schema: "shop"`);
    expect(two.fact_orders).toContain(`table: "fact_orders"`);
    // ClickHouse 复合类型原样透传（不得被改写）
    expect(two.fact_orders).toContain(`type: "Decimal(12, 2)"`);
  });

  test("quoteYamlString：反斜杠/双引号/换行/控制字符", () => {
    expect(wren.quoteYamlString('a"b\\c')).toBe(`"a\\"b\\\\c"`);
    expect(wren.quoteYamlString("x\ny")).toBe(`"x\\ny"`);
    expect(wren.quoteYamlString("tab\there")).toBe(`"tab\\there"`);
    expect(wren.quoteYamlString(`ctl${String.fromCharCode(1)}x`)).toBe(`"ctl\\u0001x"`);
  });

  test("sanitizeModelName：数字开头加前缀，非法字符压下划线，空串回落", () => {
    expect(wren.sanitizeModelName("9orders")).toBe("m9orders");
    expect(wren.sanitizeModelName("my-table.v2")).toBe("my_table_v2");
    expect(wren.sanitizeModelName("")).toBe("m_");
  });
});

describe("wren：wrenEntryDto（GET 脱敏）", () => {
  test("connection 敏感字段恒为 ******；state 依 lastError；daemon 存活随真实端口", async () => {
    const dead = await wren.wrenEntryDto("pg", blankEntry({ port: 9330, lastError: "introspect: boom" }));
    expect(dead.state).toBe("error");
    expect(dead.lastError).toBe("introspect: boom");
    expect(dead.models).toBe(0);
    expect((dead.daemon as { alive: boolean }).alive).toBeFalse();
    expect((dead.connection as Record<string, unknown>).password).toBe("******");
    expect((dead.connection as Record<string, unknown>).host).toBe("h");
    expect(dead.tables).toBeNull();
  });
});

describe("wren：delete 清理链（deprovision，无真实 daemon）", () => {
  const mcpFile = globalMcpPath();

  test("杀 daemon（端口不在听 → no-op）→ mcp.json 键移除 → 项目目录删除；注册表移除由调用方做", async () => {
    // 造一个"已注册"的假象：mcp.json 有 wren-dd 键 + 项目目录存在 + 注册表条目（端口不在听）
    await fs.mkdir(path.dirname(mcpFile), { recursive: true });
    await fs.writeFile(
      mcpFile,
      `${JSON.stringify({ mcpServers: { "wren-dd": { type: "http", url: "http://127.0.0.1:9390/mcp" }, keep: { type: "stdio", command: "x" } } }, null, 2)}\n`,
      "utf8",
    );
    const projDir = wren.wrenProjectDir("dd");
    await fs.mkdir(path.join(projDir, "models", "orders"), { recursive: true });
    await fs.writeFile(path.join(projDir, "wren_project.yml"), "name: dd\n", "utf8");
    const entry = blankEntry({ port: 9390 }); // 端口无服务 → killWrenDaemonFor no-op
    await wren.deprovisionWrenDatasource("dd", entry);
    const mcp = JSON.parse(await fs.readFile(mcpFile, "utf8"));
    expect(mcp.mcpServers["wren-dd"]).toBeUndefined();
    expect(mcp.mcpServers.keep).toEqual({ type: "stdio", command: "x" }); // 他人键保留
    expect(await fs.exists(projDir)).toBeFalse();
    // removeWrenMcpServer 幂等：键已不在 → 再调不抛不重写
    const before = await fs.readFile(mcpFile, "utf8");
    await wren.removeWrenMcpServer("dd");
    expect(await fs.readFile(mcpFile, "utf8")).toBe(before);
  });
});

describe("wren：registerWrenMcpServers（global/mcp.json 合并幂等）", () => {
  const mcpFile = globalMcpPath();

  test("写入 wren-<name> 环回条目且保留既有 server；URL 变化才重写；重复调用幂等", async () => {
    await fs.writeFile(
      mcpFile,
      `${JSON.stringify({ mcpServers: { "shared-fs": { type: "stdio", command: "global-cmd" } } }, null, 2)}\n`,
      "utf8",
    );
    await wren.registerWrenMcpServers([
      { name: "pg", port: 9320 },
      { name: "ch", port: 9321 },
    ]);
    const once = JSON.parse(await fs.readFile(mcpFile, "utf8"));
    expect(once.mcpServers["wren-pg"]).toEqual({ type: "http", url: "http://127.0.0.1:9320/mcp" });
    expect(once.mcpServers["wren-ch"]).toEqual({ type: "http", url: "http://127.0.0.1:9321/mcp" });
    expect(once.mcpServers["shared-fs"]).toEqual({ type: "stdio", command: "global-cmd" });
    const before = await fs.readFile(mcpFile, "utf8");
    await wren.registerWrenMcpServers([
      { name: "pg", port: 9320 },
      { name: "ch", port: 9321 },
    ]);
    expect(await fs.readFile(mcpFile, "utf8")).toBe(before);
    await wren.registerWrenMcpServers([{ name: "pg", port: 9420 }]);
    const updated = JSON.parse(await fs.readFile(mcpFile, "utf8"));
    expect(updated.mcpServers["wren-pg"]).toEqual({ type: "http", url: "http://127.0.0.1:9420/mcp" });
    expect(updated.mcpServers["wren-ch"]).toEqual({ type: "http", url: "http://127.0.0.1:9321/mcp" });
  });

  test("空 specs → no-op（文件不动）", async () => {
    const before = await fs.readFile(mcpFile, "utf8");
    await wren.registerWrenMcpServers([]);
    expect(await fs.readFile(mcpFile, "utf8")).toBe(before);
  });
});

describe("wren：materializeDataQuerySkill（wren 不可用 → 仅 SKILL.md）", () => {
  const skillDir = path.join(config.dataRoot, "global", "skills", "data-query");

  test("specs 非空 + bin=null → SKILL.md 落盘、references 为空、文案含工具组与降级", async () => {
    const spec: wren.WrenDatasourceSpec = { name: "pg", datasource: "postgres", connection: { host: "h" }, port: 9320 };
    await wren.materializeDataQuerySkill([spec], null);
    const md = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
    expect(md).toContain("name: data-query");
    expect(md).toContain("wren-pg");
    expect(md).toContain("run_sql");
    expect(md).toContain("describe_schema");
    expect(md).toContain("recall_queries");
    expect(md).toContain("不要编造数据");
    const refs = await fs.readdir(path.join(skillDir, "references")).catch(() => [] as string[]);
    expect(refs).toEqual([]);
  });

  test("幂等：再次物化内容字节级不变", async () => {
    const spec: wren.WrenDatasourceSpec = { name: "pg", datasource: "postgres", connection: { host: "h" }, port: 9320 };
    const before = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
    await wren.materializeDataQuerySkill([spec], null);
    expect(await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8")).toBe(before);
  });

  test("specs 为空 → 不建 skill 目录、mcp.json 不动", async () => {
    const mcpFile = globalMcpPath();
    const before = await fs.readFile(mcpFile, "utf8");
    await wren.materializeDataQuerySkill([], null);
    expect(await fs.exists(path.join(config.dataRoot, "global", "skills", "data-query-none"))).toBeFalse();
    expect(await fs.readFile(mcpFile, "utf8")).toBe(before);
  });
});

describe("wren：ensureWrenDatasources（启动流程）", () => {
  const mcpFile = globalMcpPath();
  let mcpSnapshot: string | null = null;

  // 本 describe 前面的用例会在 mcp.json 留 wren-* 键——快照 + 还原，隔离断言
  const before = async () => {
    mcpSnapshot = await fs.readFile(mcpFile, "utf8").catch(() => null);
  };
  const restore = async () => {
    if (mcpSnapshot !== null) await fs.writeFile(mcpFile, mcpSnapshot, "utf8");
  };

  test("WREN_MCP!=1 → 完全 no-op（mcp.json 与已物化 skill 均字节级不变，无挂接产物）", async () => {
    await before();
    delete process.env.WREN_MCP;
    setDs("pg", `{"pg":${PG}}`);
    const beforeMcp = await fs.readFile(mcpFile, "utf8");
    const skillFile = path.join(config.dataRoot, "global", "skills", "data-query", "SKILL.md");
    const beforeSkill = await fs.readFile(skillFile, "utf8").catch(() => null);
    await wren.ensureWrenDatasources();
    expect(await fs.readFile(mcpFile, "utf8")).toBe(beforeMcp);
    if (beforeSkill !== null) expect(await fs.readFile(skillFile, "utf8")).toBe(beforeSkill);
    expect(await fs.exists(path.join(config.dataRoot, "wren", "profiles.yml"))).toBeFalse();
    expect(await fs.exists(wren.wrenProjectDir("pg"))).toBeFalse();
    expect(await fs.exists(wren.wrenRegistryPath())).toBeFalse();
  });

  test("WREN_MCP=1 + wren 不存在 → 不新增 mcp.json wren 键、SKILL.md 物化、注册表不产生、不抛异常", async () => {
    await before();
    process.env.WREN_MCP = "1";
    setDs("pg", `{"pg":${PG}}`);
    await wren.ensureWrenDatasources();
    const mcp = JSON.parse(await fs.readFile(mcpFile, "utf8"));
    const beforeKeys = Object.keys((JSON.parse(mcpSnapshot!) as { mcpServers: Record<string, unknown> }).mcpServers);
    expect(Object.keys(mcp.mcpServers).filter((k) => !beforeKeys.includes(k))).toEqual([]); // 无新增键
    expect(await fs.exists(path.join(config.dataRoot, "global", "skills", "data-query", "SKILL.md"))).toBeTrue();
    expect(await fs.exists(wren.wrenRegistryPath())).toBeFalse(); // wren 缺失 → 不写种子（避免留下永远无法 provision 的僵尸条目）
    expect(await fs.exists(path.join(config.dataRoot, "wren", "profiles.yml"))).toBeFalse();
    await restore();
  });
});

afterAll(() => {
  // 不给同进程的其他单测留 wren env
  for (const k of [
    "WREN_MCP",
    "WREN_BIN",
    "WREN_DATASOURCES",
    "WREN_DS_CONNECTIONS",
    "WREN_MCP_PORT_BASE",
    "WREN_HOME",
  ]) {
    delete process.env[k];
  }
});
