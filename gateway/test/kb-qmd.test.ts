/**
 * KB × qmd 集成测试（skip-if-absent）：本机装了 qmd（PATH 可查）才跑，否则整体跳过。
 * 范式同 kb.test.ts：spawn 真实网关（独立端口/数据根），全链路断言 qmd 挂接——
 *   建 KB → collection 注册（`qmd --index kb collection list` 含 kb-<slug>）；
 *   upload → 201 且管理面不被 qmd 阻塞；未配 KB_QMD_EMBED_* 三件套 → embed 被跳过
 *   （只 update，绝不触发本地 GGUF 模型下载）；KB_QMD_MCP=1 → global/mcp.json 有 qmd 环回条目；
 *   删 KB → collection 注销。子进程 env 显式覆盖 KB_QMD_BIN/KB_QMD_INDEX 保持确定性。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { strToU8, zipSync } from "fflate";

const qmdBin = Bun.which("qmd");
const d = qmdBin ? describe : describe.skip;

const PORT = 8814;
const BASE = `http://127.0.0.1:${PORT}`;
const TOK = "kb-qmd-it-token";
const H = {
  authorization: `Bearer ${TOK}`,
  "content-type": "application/json",
  "x-admin-id": "admin",
  "x-user-id": "admin",
};
// multipart 用（不得带 content-type——fetch 依 FormData 自动补 boundary）
const ADMF = { authorization: `Bearer ${TOK}`, "x-admin-id": "admin", "x-user-id": "admin" };

const dataRoot = mkdtempSync(path.join(tmpdir(), "omp-gw-kbqmd-"));
const qmdEnv = () => ({
  ...process.env,
  KB_QMD_BIN: qmdBin!,
  KB_QMD_INDEX: "kb",
  QMD_CONFIG_DIR: path.join(dataRoot, "global", "kb", "qmd", "config"),
  XDG_CACHE_HOME: path.join(dataRoot, "global", "kb", "qmd", "cache"),
});

/** 用与网关子进程相同的 env 跑一条 qmd 命令（验证索引状态用）。 */
const qmdRun = (args: string[]): { stdout: string; ok: boolean } => {
  const p = spawnSync(qmdBin!, args, { env: qmdEnv(), encoding: "utf8", timeout: 120_000 });
  return { stdout: `${p.stdout ?? ""}\n${p.stderr ?? ""}`, ok: p.status === 0 };
};

let proc: Bun.Subprocess | null = null;

beforeAll(async () => {
  proc = Bun.spawn([process.execPath, "run", "src/index.ts"], {
    cwd: path.resolve(import.meta.dir, ".."),
    env: {
      ...process.env,
      GATEWAY_PORT: String(PORT),
      GATEWAY_DATA_ROOT: dataRoot,
      GATEWAY_SERVICE_TOKENS: TOK,
      KB_QMD_BIN: qmdBin!,
      KB_QMD_INDEX: "kb",
      KB_QMD_MCP: "1",
      // 不设 KB_QMD_EMBED_* 三件套：embed 必须被跳过（BM25-only），不得触发模型下载
      KB_QMD_EMBED_BASE_URL: "",
      KB_QMD_EMBED_API_KEY: "",
      KB_QMD_EMBED_MODEL: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("gateway did not become healthy in 20s");
}, 30_000);

afterAll(() => {
  if (!proc) return;
  try {
    proc.kill();
  } catch {}
  // Windows 兜底：按树强杀
  try {
    spawnSync("taskkill", ["/F", "/T", "/PID", String(proc.pid)], { timeout: 10_000 });
  } catch {}
});

const mkZip = () =>
  zipSync({
    "markdown.md": strToU8("# Qmd Demo\nsemantic corpus body\n"),
    "middle_json.json": strToU8(JSON.stringify({ pdf_info: [{}, {}] })),
    "structured_content.json": strToU8("{}"),
  });

d("KB × qmd：建库即注册、上传即构建、删库即注销", () => {
  test("建 KB → collection list 含 kb-qmdit；KB_QMD_MCP=1 → global/mcp.json 有 qmd 条目", async () => {
    const r = await fetch(`${BASE}/admin/kb`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ slug: "qmdit", title: "QMD IT" }),
    });
    expect(r.status).toBe(201);
    // collection 注册（createKb → kbQmdAdd）
    const deadline = Date.now() + 60_000;
    let listed = "";
    while (Date.now() < deadline) {
      listed = qmdRun(["--index", "kb", "collection", "list"]).stdout;
      if (listed.includes("kb-qmdit")) break;
      await new Promise((r2) => setTimeout(r2, 500));
    }
    expect(listed).toContain("kb-qmdit");
    // 全局 MCP 注册（网关启动 ensureQmdMcpRegistered）
    expect(existsSync(path.join(dataRoot, "global", "mcp.json"))).toBeTrue();
    const mcp = JSON.parse(readFileSync(path.join(dataRoot, "global", "mcp.json"), "utf8"));
    expect(mcp.mcpServers.qmd).toEqual({ type: "http", url: "http://127.0.0.1:8181/mcp" });
  }, 120_000);

  test("upload → 201（qmd update 不阻塞管理面；embed 未配三件套被跳过、无模型下载）", async () => {
    const fd = new FormData();
    fd.append("zip", new File([mkZip() as BlobPart], "qmd-demo.zip", { type: "application/zip" }));
    const r = await fetch(`${BASE}/admin/kb/qmdit/upload`, { method: "POST", headers: ADMF, body: fd });
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body).toMatchObject({ ok: true, doc: "qmd-demo", pages: 2 });
    // update 已跑：collection 仍注册且状态可查（BM25 即刻可用；embed 跳过不报错）
    const list = qmdRun(["--index", "kb", "collection", "list"]);
    expect(list.ok).toBeTrue();
    expect(list.stdout).toContain("kb-qmdit");
    // 语料本体落位（qmd collection 指向的目录）
    expect(
      existsSync(path.join(dataRoot, "global", "skills", "kb-qmdit", "docs", "qmd-demo", "qmd-demo.md")),
    ).toBeTrue();
  }, 120_000);

  test("删文档 → 删 KB → collection 注销（幂等，管理面不失败）", async () => {
    expect((await fetch(`${BASE}/admin/kb/qmdit/doc/qmd-demo`, { method: "DELETE", headers: H })).status).toBe(200);
    expect((await fetch(`${BASE}/admin/kb/qmdit`, { method: "DELETE", headers: H })).status).toBe(200);
    const deadline = Date.now() + 60_000;
    let listed = "";
    while (Date.now() < deadline) {
      listed = qmdRun(["--index", "kb", "collection", "list"]).stdout;
      if (!listed.includes("kb-qmdit")) break;
      await new Promise((r2) => setTimeout(r2, 500));
    }
    expect(listed).not.toContain("kb-qmdit");
  }, 120_000);
});
