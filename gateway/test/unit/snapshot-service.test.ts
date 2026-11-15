import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { copySnapshotLines, runSnapshotPruner } from "../../src/core/snapshot-service.ts";

const tmp = async () => fs.mkdtemp(path.join(os.tmpdir(), "snap-"));

describe("copySnapshotLines", () => {
  test("完整行复制 + 尾行容忍（丢弃截断半行）", async () => {
    const dir = await tmp();
    const src = path.join(dir, "a.jsonl");
    const dest = path.join(dir, "b.jsonl");
    // 3 条合法 + 1 条截断半行（无换行结尾）
    await fs.writeFile(src, '{"a":1}\n{"a":2}\n{"a":3}\n{"a":4', "utf8");
    const n = await copySnapshotLines(src, dest);
    expect(n).toBe(3);
    const out = await fs.readFile(dest, "utf8");
    expect(out).toBe('{"a":1}\n{"a":2}\n{"a":3}\n');
    expect(out.endsWith("\n")).toBeTrue();
  });

  test("截断尾行若为合法 JSON 则保留", async () => {
    const dir = await tmp();
    const src = path.join(dir, "a.jsonl");
    await fs.writeFile(src, '{"a":1}\n{"b":"完整行"}', "utf8"); // 无换行结尾但可解析
    const n = await copySnapshotLines(src, path.join(dir, "b.jsonl"));
    expect(n).toBe(2);
  });

  test("空文件 → 0 行", async () => {
    const dir = await tmp();
    await fs.writeFile(path.join(dir, "a.jsonl"), "", "utf8");
    const n = await copySnapshotLines(path.join(dir, "a.jsonl"), path.join(dir, "b.jsonl"));
    expect(n).toBe(0);
  });
});

// Pruner 的 ring/TTL/孤儿清理走集成测试（需 DB + 目录布局）
describe("runSnapshotPruner（孤儿文件清理，无 DB 依赖部分）", () => {
  test("孤儿 .jsonl 被清理，合法快照保留", async () => {
    const root = await tmp();
    // 伪造：users/u1/snapshots/s1/{orphan.jsonl, valid-id.jsonl}——DB 无行 → 都视为孤儿删除
    const dir = path.join(root, "users", "u1", "snapshots", "s1");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "orphan.jsonl"), '{"a":1}\n');
    const res = await runSnapshotPruner(root);
    expect(res.orphansDeleted).toBeGreaterThanOrEqual(1);
    await expect(fs.stat(path.join(dir, "orphan.jsonl"))).rejects.toBeTruthy();
  });
});
