/**
 * qmd 包装模块单测：二进制缺失 → 全部函数 no-op；子进程 env 拼装指向 dataRoot；
 * 全局 MCP 注册（KB_QMD_MCP=1）写入与幂等。不依赖本机安装 qmd（KB_QMD_BIN 指向
 * 不存在的路径）；config 是加载期单例（test/setup.ts preload 已把 GATEWAY_DATA_ROOT
 * 指到临时目录），KB_QMD_BIN 在本文件里置好后保持，让同进程的后续单测同样免 qmd。
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { config } from "../../src/config.ts";
import { globalMcpPath } from "../../src/core/paths.ts";

process.env.KB_QMD_BIN = "/nonexistent/qmd";
const qmd = await import("../../src/core/kb/qmd.ts");

const NOOP = { ok: false, reason: "qmd not installed" };

describe("kb qmd：二进制缺失 → no-op", () => {
  test("kbQmdAdd / kbQmdUpdate / kbQmdRemove 返回 {ok:false, reason}，不抛异常", async () => {
    expect(await qmd.kbQmdAdd("qmdno")).toEqual(NOOP);
    expect(await qmd.kbQmdUpdate()).toEqual(NOOP);
    expect(await qmd.kbQmdRemove("qmdno")).toEqual(NOOP);
  });

  test("scheduleKbQmdEmbed：三件套未配 → skipped（不同步等、不抛、状态可读）", () => {
    const saved = {
      b: process.env.KB_QMD_EMBED_BASE_URL,
      k: process.env.KB_QMD_EMBED_API_KEY,
      m: process.env.KB_QMD_EMBED_MODEL,
    };
    delete process.env.KB_QMD_EMBED_BASE_URL;
    delete process.env.KB_QMD_EMBED_API_KEY;
    delete process.env.KB_QMD_EMBED_MODEL;
    qmd.scheduleKbQmdEmbed("qmdskip");
    const st = qmd.kbEmbedStatus("qmdskip");
    expect(st.state).toBe("skipped");
    expect(st.error).toContain("KB_QMD_EMBED_");
    expect(qmd.kbEmbedRunning()).not.toContain("kb-qmdskip");
    if (saved.b) process.env.KB_QMD_EMBED_BASE_URL = saved.b;
    if (saved.k) process.env.KB_QMD_EMBED_API_KEY = saved.k;
    if (saved.m) process.env.KB_QMD_EMBED_MODEL = saved.m;
  });

  test("scheduleKbQmdEmbed：未触发过的 slug 状态为 idle", () => {
    expect(qmd.kbEmbedStatus("never-seen")).toMatchObject({ state: "idle", startedAt: null, error: null });
  });
});

describe("kb qmd：env 拼装", () => {
  test("QMD_CONFIG_DIR / XDG_CACHE_HOME 指向 dataRoot 下 global/kb/qmd/*，索引名默认 kb", () => {
    const env = qmd.qmdSubprocessEnv();
    expect(env.QMD_CONFIG_DIR).toBe(path.join(config.dataRoot, "global", "kb", "qmd", "config"));
    expect(env.XDG_CACHE_HOME).toBe(path.join(config.dataRoot, "global", "kb", "qmd", "cache"));
    expect(qmd.qmdIndexName()).toBe("kb");
    process.env.KB_QMD_INDEX = "kb-team";
    expect(qmd.qmdIndexName()).toBe("kb-team");
    process.env.KB_QMD_INDEX = "bad index!"; // 白名单外（含空格）回落默认
    expect(qmd.qmdIndexName()).toBe("kb");
    delete process.env.KB_QMD_INDEX;
  });
});

describe("kb qmd：ensureQmdMcpRegistered", () => {
  const mcpFile = globalMcpPath();
  let snapshot: string | null = null;

  test("KB_QMD_MCP=1：无 qmd 键 → 写入环回 http 条目且保留既有 server；重复调用幂等", async () => {
    snapshot = await fs.readFile(mcpFile, "utf8").catch(() => null);
    await fs.mkdir(path.dirname(mcpFile), { recursive: true });
    await fs.writeFile(
      mcpFile,
      `${JSON.stringify({ mcpServers: { "shared-fs": { type: "stdio", command: "global-cmd" } } }, null, 2)}\n`,
      "utf8",
    );
    process.env.KB_QMD_MCP = "1";
    await qmd.ensureQmdMcpRegistered();
    const once = JSON.parse(await fs.readFile(mcpFile, "utf8"));
    expect(once.mcpServers.qmd).toEqual({ type: "http", url: "http://127.0.0.1:8181/mcp" });
    expect(once.mcpServers["shared-fs"]).toEqual({ type: "stdio", command: "global-cmd" });
    // 幂等：重复调用不重写（内容字节级不变、qmd 键唯一）
    const before = await fs.readFile(mcpFile, "utf8");
    await qmd.ensureQmdMcpRegistered();
    const after = await fs.readFile(mcpFile, "utf8");
    expect(after).toBe(before);
    expect(Object.keys(JSON.parse(after).mcpServers).filter((k) => k === "qmd")).toHaveLength(1);
  });

  test("KB_QMD_MCP 未设 → 不写（文件原样）", async () => {
    delete process.env.KB_QMD_MCP;
    const before = await fs.readFile(mcpFile, "utf8");
    await qmd.ensureQmdMcpRegistered();
    expect(await fs.readFile(mcpFile, "utf8")).toBe(before);
  });

  afterAll(async () => {
    delete process.env.KB_QMD_MCP;
    // 还原全局 mcp.json，不给同进程的其他单测（mcp-compose 等）留 qmd 键
    if (snapshot !== null) await fs.writeFile(mcpFile, snapshot, "utf8");
  });
});
