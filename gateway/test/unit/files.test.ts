import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { config } from "../../src/config.ts";
import {
  FileGuardError,
  listTree,
  readFileContent,
  removePath,
  resolveInside,
  writeFileContent,
} from "../../src/core/files.ts";
import { insertUsage, sessionUsageSummary, userUsage } from "../../src/core/tenant-store.ts";

const root = config.dataRoot;

describe("resolveInside 路径守卫", () => {
  const ws = path.join(root, "guard-ws");

  test("workspace 内相对路径放行", async () => {
    const p = await resolveInside(ws, "src/a.ts");
    expect(p.startsWith(path.resolve(ws))).toBeTrue();
  });

  test("../ 逃逸拒绝", async () => {
    await expect(resolveInside(ws, "../escape.txt")).rejects.toThrow(FileGuardError);
    await expect(resolveInside(ws, "a/../../escape.txt")).rejects.toThrow(FileGuardError);
  });

  test("绝对路径按 workspace 相对解析，盘外绝对路径拒绝", async () => {
    if (process.platform === "win32") {
      await expect(resolveInside(ws, "C:\\Windows\\system32\\evil")).rejects.toThrow(FileGuardError);
    }
  });

  test("符号链接逃逸拒绝（指向 workspace 外的链接）", async () => {
    // workspace 外的敏感目录 + 指向它的 junction
    const outside = path.join(root, "outside-secret");
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "secret.txt"), "x");
    await fs.mkdir(ws, { recursive: true });
    const linkDir = path.join(ws, "link-out");
    try {
      await fs.symlink(outside, linkDir, "junction");
      // workspace 内部链接放行（realpath 前缀仍在 ws 内）
      await fs.mkdir(path.join(ws, "real"), { recursive: true });
      await fs.writeFile(path.join(ws, "real", "ok.txt"), "x");
      await fs.symlink(path.join(ws, "real"), path.join(ws, "link-in"), "junction");
      expect((await readFileContent(ws, "link-in/ok.txt")).content).toBe("x");
      // workspace 外逃逸拒绝
      await expect(readFileContent(ws, "link-out/secret.txt")).rejects.toThrow(FileGuardError);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EPERM") return; // 无符号链接权限的环境跳过
      throw err;
    }
  });

  test("workspace 根本身不可删除", async () => {
    await expect(removePath(ws, ".")).rejects.toThrow(FileGuardError);
  });
});

describe("listTree", () => {
  const ws = path.join(root, "tree-ws");

  test("结构、跳过重目录、深度与条目上限", async () => {
    await fs.mkdir(path.join(ws, "src/deep/deeper"), { recursive: true });
    await fs.mkdir(path.join(ws, "node_modules/pkg"), { recursive: true });
    await fs.mkdir(path.join(ws, ".git/objects"), { recursive: true });
    await fs.writeFile(path.join(ws, "README.md"), "# t");
    await fs.writeFile(path.join(ws, "src", "a.ts"), "export 1");
    await fs.writeFile(path.join(ws, "src/deep/deeper", "b.ts"), "export 2");
    await fs.writeFile(path.join(ws, "node_modules/pkg", "x.js"), "{}");

    const t1 = await listTree(ws, { depth: 3 });
    const names = t1.entries.map((e) => e.name);
    expect(names).toContain("README.md");
    expect(names).toContain("src");
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain(".git");
    // depth=3 = 列 3 层：src(L1) → deep(L2) → deeper(L3) 均可见
    expect(names).toContain("deep");
    expect(names).toContain("deeper");

    // depth=2 时 L3 不可见
    const t1b = await listTree(ws, { depth: 2 });
    expect(t1b.entries.map((e) => e.name)).not.toContain("deeper");

    const t2 = await listTree(ws, { depth: 5, includeHeavy: true });
    expect(t2.entries.map((e) => e.name)).toContain("node_modules");

    const t3 = await listTree(ws, { depth: 2, maxEntries: 3 });
    expect(t3.truncated).toBeTrue();
  });

  test("subPath 从子目录列出", async () => {
    const t = await listTree(path.join(root, "tree-ws"), { subPath: "src" });
    expect(t.path).toBe("src");
    expect(t.entries.map((e) => e.name)).toContain("a.ts");
  });
});

describe("文件读写边界", () => {
  const ws = path.join(root, "fileops-ws");

  test("utf8 与 base64 写读往返 + 二进制识别", async () => {
    const r1 = await writeFileContent(ws, "docs/a.md", "# 你好 gateway");
    expect(r1.size).toBeGreaterThan(0);
    const c1 = await readFileContent(ws, "docs/a.md");
    expect(c1.encoding).toBe("utf8");
    expect(c1.content).toContain("你好");

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]); // 含 \0 → 二进制
    await writeFileContent(ws, "img/a.png", png.toString("base64"), "base64");
    const c2 = await readFileContent(ws, "img/a.png");
    expect(c2.encoding).toBe("base64");
  });

  test("写逃逸路径被拒", async () => {
    await expect(writeFileContent(ws, "../outside.txt", "x")).rejects.toThrow(FileGuardError);
  });
});

describe("usage 聚合", () => {
  const uid = "u-usage-test";
  const sid = "s-usage-1";

  test("insert → session 汇总 / user 分桶 / totals", () => {
    insertUsage({
      user_id: uid,
      session_id: sid,
      turn: 1,
      model_provider: "minimax",
      model_id: "M3.1",
      input_tokens: 100,
      output_tokens: 10,
      total_tokens: 110,
      cost_usd: 0.01,
      duration_ms: 900,
      ttft_ms: 300,
    });
    insertUsage({
      user_id: uid,
      session_id: sid,
      turn: 2,
      model_provider: "minimax",
      model_id: "M3",
      input_tokens: 50,
      output_tokens: 5,
      total_tokens: 55,
      cost_usd: 0.005,
    });
    insertUsage({
      user_id: "other",
      session_id: "s-other",
      turn: 1,
      model_provider: "openai",
      model_id: "gpt",
      input_tokens: 7,
      output_tokens: 1,
      total_tokens: 8,
      cost_usd: 0.001,
    });

    const sum = sessionUsageSummary(sid);
    expect(sum.turns).toBe(2);
    expect(sum.inputTokens).toBe(150);
    expect(sum.outputTokens).toBe(15);
    expect(sum.totalTokens).toBe(165);
    expect(sum.costUsd).toBeCloseTo(0.015);
    expect(sum.lastAt).toBeTruthy();

    const byModel = userUsage(uid, "model");
    expect(byModel.find((b) => b.key === "minimax/M3.1")?.inputTokens).toBe(100);
    expect(byModel.every((b) => b.key !== "openai/gpt")).toBeTrue();

    const bySession = userUsage(uid, "session");
    expect(bySession).toHaveLength(1);
    expect(bySession[0].key).toBe(sid);

    const byDay = userUsage(uid, "day");
    expect(byDay).toHaveLength(1);
    expect(byDay[0].key).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // from/to 过滤：仅今天 → 仍有；未来区间 → 空
    const today = new Date().toISOString().slice(0, 10);
    expect(userUsage(uid, "day", today, today)).toHaveLength(1);
    expect(userUsage(uid, "day", "2099-01-01", "2099-01-02")).toHaveLength(0);
  });
});
