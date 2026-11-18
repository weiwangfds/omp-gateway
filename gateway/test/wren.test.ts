/**
 * WrenAI 挂接集成测试（skip-if-absent）：本机存在 wren 可执行（env WREN_BIN 指到
 * venv 的 wren，或 PATH 可查）才跑，否则整体跳过。范式同 kb-qmd.test.ts：
 * spawn 真实网关（独立端口/数据根），WREN_DATASOURCES=duckdemo（datasource=duckdb
 * 内置，无需外部数据库），断言全链路挂接——
 *   global/mcp.json 含 wren-duckdemo 环回条目；项目 target/mdl.json 编译产出；
 *   daemon 端口监听且 MCP initialize → tools/list 可达（含 run_sql）；
 *   data-query 全局 skill 物化（SKILL.md + references/）；WREN_HOME 下 profiles.yml
 *   落位。子进程 env 显式覆盖 WREN_BIN/WREN_HOME/WREN_MCP_PORT_BASE 保持确定性。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const wrenBin = process.env.WREN_BIN?.trim() || Bun.which("wren") || "";
const d = wrenBin ? describe : describe.skip;

const PORT = 8816;
const MCP_PORT = 8095;
const BASE = `http://127.0.0.1:${PORT}`;
const TOK = "wren-it-token";

const dataRoot = mkdtempSync(path.join(tmpdir(), "omp-gw-wren-"));
const wrenHomeDir = path.join(dataRoot, "wren-home");
// duckdb 数据目录：建库即校验连接（profile add 即使 --no-validate 也要求 url 可读才有意义）
const duckDir = path.join(dataRoot, "duck-data");

/** 用 wren 所在 venv 的 python 造一个含 orders 表的 DuckDB 文件（同一 venv 保证 duckdb 可用）。 */
function seedDuckdb(): boolean {
  const base = path.dirname(wrenBin);
  const py = ["python.exe", "python", "python3"].map((n) => path.join(base, n)).find(existsSync);
  if (!py) return false;
  const script = `
import duckdb, os
d = os.environ["WREN_DUCK_DIR"]
os.makedirs(d, exist_ok=True)
con = duckdb.connect(os.path.join(d, "shop.duckdb"))
con.execute("CREATE TABLE orders (id INTEGER, amount DOUBLE, region VARCHAR)")
con.execute("INSERT INTO orders VALUES (1, 100.5, 'east'), (2, 250.0, 'west')")
con.close()
`;
  const r = spawnSync(py, ["-I", "-c", script], {
    env: { ...process.env, WREN_DUCK_DIR: duckDir },
    encoding: "utf8",
    timeout: 60_000,
  });
  return r.status === 0 && existsSync(path.join(duckDir, "shop.duckdb"));
}

let proc: Bun.Subprocess | null = null;
let seeded = false;

beforeAll(async () => {
  seeded = seedDuckdb();
  if (!seeded) return;
  proc = Bun.spawn([process.execPath, "run", "src/index.ts"], {
    cwd: path.resolve(import.meta.dir, ".."),
    env: {
      ...process.env,
      GATEWAY_PORT: String(PORT),
      GATEWAY_DATA_ROOT: dataRoot,
      GATEWAY_SERVICE_TOKENS: TOK,
      WREN_MCP: "1",
      WREN_BIN: wrenBin,
      WREN_HOME: wrenHomeDir,
      WREN_DATASOURCES: "duckdemo",
      WREN_DS_CONNECTIONS: JSON.stringify({
        duckdemo: { datasource: "duckdb", url: duckDir, format: "duckdb" },
      }),
      WREN_MCP_PORT_BASE: String(MCP_PORT),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  // wren 挂接（profile/init/build/daemon）在 Bun.serve 之前完成 → healthz 即挂接完毕
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("gateway did not become healthy in 120s");
}, 150_000);

afterAll(() => {
  if (!proc) return;
  try {
    proc.kill();
  } catch {}
  // Windows 兜底：按树强杀（wren daemon 是网关子进程，一并带走）
  try {
    spawnSync("taskkill", ["/F", "/T", "/PID", String(proc.pid)], { timeout: 10_000 });
  } catch {}
  // POSIX 兜底：按命令行匹配清掉测试 daemon（避免占住 MCP_PORT 影响后续运行）
  try {
    spawnSync("pkill", ["-f", `wren serve mcp.*--port ${MCP_PORT}`], { timeout: 10_000 });
  } catch {}
});

/** MCP streamable-http 握手：initialize 取 session id → 调 method 取结果文本。 */
async function mcpCall(
  method: string,
  params: unknown,
): Promise<{ status: number; data: Record<string, unknown> | null }> {
  const init = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "wren-it", version: "0.0.1" } },
    }),
  });
  const sid = init.headers.get("mcp-session-id") ?? "";
  const r = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sid,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }),
  });
  const text = await r.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  return { status: r.status, data: line ? (JSON.parse(line.slice(6)) as Record<string, unknown>) : null };
}

d("Wren 挂接：mcp.json 注册、MDL 编译、daemon 可达、skill 物化", () => {
  test("global/mcp.json 含 wren-duckdemo 环回条目；profiles.yml 落 WREN_HOME", () => {
    const mcp = JSON.parse(readFileSync(path.join(dataRoot, "global", "mcp.json"), "utf8"));
    expect(mcp.mcpServers["wren-duckdemo"]).toEqual({ type: "http", url: `http://127.0.0.1:${MCP_PORT}/mcp` });
    expect(existsSync(path.join(wrenHomeDir, "profiles.yml"))).toBeTrue();
    expect(readFileSync(path.join(wrenHomeDir, "profiles.yml"), "utf8")).toContain("duckdemo");
  });

  test("项目骨架 + 空模型集编译出 target/mdl.json", () => {
    expect(existsSync(path.join(dataRoot, "global", "wren", "duckdemo", "wren_project.yml"))).toBeTrue();
    expect(existsSync(path.join(dataRoot, "global", "wren", "duckdemo", "target", "mdl.json"))).toBeTrue();
  });

  test("daemon 端口监听：initialize → tools/list 含 run_sql", async () => {
    const listed = await mcpCall("tools/list", {});
    expect(listed.status).toBe(200);
    const result = listed.data?.result as { tools?: { name: string }[] } | undefined;
    const names = (result?.tools ?? []).map((t) => t.name);
    expect(names).toContain("run_sql");
    expect(names).toContain("dry_run");
    expect(names).toContain("describe_schema");
    expect(names).toContain("recall_queries");
  }, 30_000);

  test("MCP run_sql 只读查数（duckdb 内置引擎，SELECT 1）", async () => {
    const r = await mcpCall("tools/call", { name: "run_sql", arguments: { sql: "SELECT 41 + 1 AS answer" } });
    expect(r.status).toBe(200);
    const payload = JSON.stringify(r.data);
    expect(payload).not.toContain('"isError":true');
    expect(payload).toContain("answer");
    expect(payload).toContain("42");
  }, 30_000);

  test("data-query 全局 skill 物化：SKILL.md + references（版本自动匹配）", () => {
    const skillDir = path.join(dataRoot, "global", "skills", "data-query");
    const md = readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
    expect(md).toContain("name: data-query");
    expect(md).toContain("wren-duckdemo");
    expect(md).toContain("不要编造数据");
    for (const guide of ["onboarding", "usage", "generate-mdl"]) {
      expect(existsSync(path.join(skillDir, "references", `${guide}.md`))).toBeTrue();
    }
  });

  test("网关健康（wren 挂接完成后 /healthz 可达）", async () => {
    expect((await fetch(`${BASE}/healthz`)).ok).toBeTrue();
  });
});

d("Wren admin API：注册表可见、PUT→GET→rebuild→DELETE 全链路（duckdb 走空骨架路径）", () => {
  const H = {
    authorization: `Bearer ${TOK}`,
    "content-type": "application/json",
    "x-admin-id": "admin",
    "x-user-id": "admin",
  };

  test("GET /admin/wren/datasources：env 种子已入注册表（state ready、端口 = 分配器首值）", async () => {
    const r = await fetch(`${BASE}/admin/wren/datasources`, { headers: H });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { datasources: Array<Record<string, unknown>> };
    const dd = body.datasources.find((x) => x.name === "duckdemo");
    expect(dd).toBeTruthy();
    expect(dd!.datasource).toBe("duckdb");
    expect(dd!.state).toBe("ready");
    expect(dd!.port).toBe(MCP_PORT);
  }, 20_000);

  test("PUT duck2 → 201；详情 ready、端口 = duckdemo+1；mcp.json 增 wren-duck2；test 端点对 duckdb 报不支持", async () => {
    const put = await fetch(`${BASE}/admin/wren/datasources/duck2`, {
      method: "PUT",
      headers: H,
      body: JSON.stringify({ datasource: "duckdb", connection: { url: duckDir, format: "duckdb" } }),
    });
    expect(put.status).toBe(201);
    const dto = (await put.json()) as Record<string, unknown>;
    expect(dto.state).toBe("ready");
    expect(dto.port).toBe(MCP_PORT + 1);
    // GET 详情
    const get = await fetch(`${BASE}/admin/wren/datasources/duck2`, { headers: H });
    expect(get.status).toBe(200);
    const detail = (await get.json()) as Record<string, unknown>;
    expect(detail.name).toBe("duck2");
    expect(existsSync(path.join(dataRoot, "global", "wren", "duck2", "wren_project.yml"))).toBeTrue();
    // mcp.json 合并（保留 wren-duckdemo）
    const mcp = JSON.parse(readFileSync(path.join(dataRoot, "global", "mcp.json"), "utf8"));
    expect(mcp.mcpServers["wren-duck2"]).toEqual({ type: "http", url: `http://127.0.0.1:${MCP_PORT + 1}/mcp` });
    expect(mcp.mcpServers["wren-duckdemo"]).toBeTruthy();
    // 连接测试：duckdb 非内省支持类型 → ok:false（不落注册表）
    const t = await fetch(`${BASE}/admin/wren/datasources/duck2/test`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ datasource: "duckdb", connection: { url: duckDir, format: "duckdb" } }),
    });
    expect(t.status).toBe(200);
    const tr = (await t.json()) as { ok: boolean; detail: string };
    expect(tr.ok).toBeFalse();
    expect(tr.detail).toContain("not supported");
  }, 120_000);

  test("PUT 同名 → 200（更新语义）；rebuild → 200 且 daemon 复活", async () => {
    const put = await fetch(`${BASE}/admin/wren/datasources/duck2`, {
      method: "PUT",
      headers: H,
      body: JSON.stringify({ tables: null }),
    });
    expect(put.status).toBe(200);
    const rebuild = await fetch(`${BASE}/admin/wren/datasources/duck2/rebuild`, { method: "POST", headers: H });
    expect(rebuild.status).toBe(200);
    const dto = (await rebuild.json()) as Record<string, unknown>;
    expect(dto.state).toBe("ready");
    // rebuild 后 daemon 重新监听（tools/list 可达）
    const probe = await fetch(`http://127.0.0.1:${MCP_PORT + 1}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(probe.status).toBeGreaterThan(0);
  }, 120_000);

  test("校验面：坏名/缺 datasource/tables 非法 → 400；DELETE duck2 → mcp.json 键消失、详情 404", async () => {
    const badName = await fetch(`${BASE}/admin/wren/datasources/BadName`, {
      method: "PUT",
      headers: H,
      body: JSON.stringify({ datasource: "duckdb", connection: {} }),
    });
    expect(badName.status).toBe(400);
    const noDs = await fetch(`${BASE}/admin/wren/datasources/duck3`, {
      method: "PUT",
      headers: H,
      body: JSON.stringify({ connection: { url: "x" } }),
    });
    expect(noDs.status).toBe(400);
    const badTables = await fetch(`${BASE}/admin/wren/datasources/duck3`, {
      method: "PUT",
      headers: H,
      body: JSON.stringify({ datasource: "duckdb", connection: {}, tables: ["no-dot"] }),
    });
    expect(badTables.status).toBe(400);
    const del = await fetch(`${BASE}/admin/wren/datasources/duck2`, { method: "DELETE", headers: H });
    expect(del.status).toBe(200);
    const mcp = JSON.parse(readFileSync(path.join(dataRoot, "global", "mcp.json"), "utf8"));
    expect(mcp.mcpServers["wren-duck2"]).toBeUndefined();
    expect(mcp.mcpServers["wren-duckdemo"]).toBeTruthy(); // 他人键保留
    const get = await fetch(`${BASE}/admin/wren/datasources/duck2`, { headers: H });
    expect(get.status).toBe(404);
    const delAgain = await fetch(`${BASE}/admin/wren/datasources/duck2`, { method: "DELETE", headers: H });
    expect(delAgain.status).toBe(404);
  }, 60_000);
});

d("Wren schema 同步（M34）：drift 检测 + force 重建 + 全量 sync", () => {
  const H = {
    authorization: `Bearer ${TOK}`,
    "content-type": "application/json",
    "x-admin-id": "admin",
    "x-user-id": "admin",
  };

  test("POST /datasources/duckdemo/sync → changed:false（duckdb 无内省器）；GET DTO 含同步观测字段", async () => {
    const r = await fetch(`${BASE}/admin/wren/datasources/duckdemo/sync`, { method: "POST", headers: H, body: "{}" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { changed: boolean; reason: string; models: number };
    expect(body.changed).toBeFalse();
    expect(body.reason).toBe("no introspector");
    expect(body.models).toBe(0);
    // provision 已基线 catalogHash（duckdb = 空目录哈希）；尚未 sync 过 → lastSyncedAt 为 null
    const get = await fetch(`${BASE}/admin/wren/datasources/duckdemo`, { headers: H });
    const dto = (await get.json()) as Record<string, unknown>;
    expect(typeof dto.catalogHash).toBe("string");
    expect(dto.lastSyncedAt).toBeNull();
    expect(dto.lastSyncError).toBeNull();
  }, 60_000);

  test("force:true → changed:true 且 daemon 定点重启后仍可服务；lastSyncedAt 落库", async () => {
    const r = await fetch(`${BASE}/admin/wren/datasources/duckdemo/sync`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ force: true }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { changed: boolean; reason: string };
    expect(body.changed).toBeTrue();
    // daemon 重启后重新监听（就绪轮询在网关侧已等待；此处兜底确认）
    const deadline = Date.now() + 45_000;
    let up = false;
    while (Date.now() < deadline) {
      try {
        const p = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        if (p.status > 0) {
          up = true;
          break;
        }
      } catch {}
      await new Promise((r2) => setTimeout(r2, 500));
    }
    expect(up).toBeTrue();
    const get = await fetch(`${BASE}/admin/wren/datasources/duckdemo`, { headers: H });
    const dto = (await get.json()) as Record<string, unknown>;
    expect(typeof dto.lastSyncedAt).toBe("string");
    expect(dto.lastSyncError).toBeNull();
  }, 90_000);

  test("POST /admin/wren/sync → 200 且 results 含每源结果；不存在的源 sync → 404", async () => {
    const r = await fetch(`${BASE}/admin/wren/sync`, { method: "POST", headers: H });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { results: Array<{ changed: boolean; reason: string }> };
    expect(Array.isArray(body.results)).toBeTrue();
    expect(body.results.some((x) => x.reason === "no introspector")).toBeTrue();
    const missing = await fetch(`${BASE}/admin/wren/datasources/ghost/sync`, {
      method: "POST",
      headers: H,
      body: "{}",
    });
    expect(missing.status).toBe(404);
  }, 60_000);
});
