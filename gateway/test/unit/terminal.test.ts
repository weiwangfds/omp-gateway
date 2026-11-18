/**
 * TUI 终端桥纯函数面（DESIGN §41.9）：spawn 参数构造（PI_CODING_AGENT_DIR/session flags/
 * workspace cwd）、JSONL 头部 omp 会话 id 解析、活跃守卫语义。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildTuiSpawn, ompSessionIdFromJsonl } from "../../src/routes/terminal.ts";
import { isTuiActive, markTuiActive, markTuiClosed } from "../../src/core/tui-registry.ts";

const ORIG_ENV = { ...process.env };

describe("buildTuiSpawn", () => {
  afterEach(() => (process.env = { ...ORIG_ENV }));

  test("args 指向 CLI + --session-dir/--session；cwd=workspace；env 注入 TERM 与 PI_CODING_AGENT_DIR", () => {
    const s = buildTuiSpawn({ ompSessionId: "omp-123", userId: "u1", sid: "s1" });
    expect(s.application).toBe(process.execPath);
    expect(s.args.filter((a) => a === "--session-dir" || a === "--session")).toEqual(["--session-dir", "--session"]);
    expect(s.args).toContain("omp-123");
    expect(s.args.at(-1)).toBe("omp-123");
    expect(s.cwd).toContain(path.join("users", "u1", "workspaces", "s1"));
    expect(s.env.PI_CODING_AGENT_DIR).toContain(path.join("users", "u1", "agent"));
    expect(s.env.TERM).toBe("xterm-256color");
    expect(s.env.COLORTERM).toBe("truecolor");
  });

  test("继承网关 env（镜像源等部署配置跟随 TUI 子进程）", () => {
    process.env.NPM_CONFIG_REGISTRY = "https://npmmirror.example";
    const s = buildTuiSpawn({ ompSessionId: "x", userId: "u1", sid: "s1" });
    expect(s.env.NPM_CONFIG_REGISTRY).toBe("https://npmmirror.example");
  });
});

describe("ompSessionIdFromJsonl", () => {
  let root: string;
  beforeEach(() => (root = mkdtempSync(path.join(tmpdir(), "omp-tui-"))));
  afterEach(() => fs.rm(root, { recursive: true, force: true }).catch(() => {}));

  test("首行 header 携带 id → 返回", async () => {
    const f = path.join(root, "2026-01-01_abc-123.jsonl");
    await fs.writeFile(f, '{"type":"session","id":"abc-123","cwd":"/w"}\n{"type":"message"}\n');
    expect(await ompSessionIdFromJsonl(f)).toBe("abc-123");
  });

  test("空文件/缺失文件 → null（不抛）", async () => {
    expect(await ompSessionIdFromJsonl(path.join(root, "missing.jsonl"))).toBeNull();
    const f = path.join(root, "empty.jsonl");
    await fs.writeFile(f, "");
    expect(await ompSessionIdFromJsonl(f)).toBeNull();
  });
});

describe("tui-registry 守卫", () => {
  test("mark → active → closed", () => {
    expect(isTuiActive("gx1")).toBeFalse();
    markTuiActive("gx1");
    expect(isTuiActive("gx1")).toBeTrue();
    markTuiClosed("gx1");
    expect(isTuiActive("gx1")).toBeFalse();
  });
});
