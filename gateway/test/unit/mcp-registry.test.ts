/**
 * mcp-registry 单测：global/mcp.json 的唯一读写点。
 * 覆盖拆分前真实存在的竞态（三处独立读-改-写并发丢条目）、幂等不重写、remove 精准删除。
 * 文件位于 preload 的临时 dataRoot 内；快照/还原避免污染同进程其他测试文件。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { readMcpServers, removeMcpServers, upsertMcpServers } from "../../src/core/mcp-registry.ts";
import { globalMcpPath } from "../../src/core/paths.ts";

const file = globalMcpPath();
let snapshot: string | null = null;

beforeAll(async () => {
  snapshot = await fs.readFile(file, "utf8").catch(() => null);
});

afterAll(async () => {
  if (snapshot !== null) await fs.writeFile(file, snapshot, "utf8");
  else await fs.rm(file, { force: true });
});

const reset = async (servers: Record<string, unknown> = {}): Promise<void> => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, "utf8");
};

const httpEntry = (port: number) => ({ type: "http", url: `http://127.0.0.1:${port}/mcp` });

describe("mcp-registry：并发安全", () => {
  test("并发 upsert 两个不同键 → 两个都在（读-改-写竞态回归）", async () => {
    await reset();
    const [a, b] = await Promise.all([
      upsertMcpServers({ alpha: httpEntry(9101) }),
      upsertMcpServers({ beta: httpEntry(9102) }),
    ]);
    expect(a).toEqual({ written: true, added: ["alpha"] });
    expect(b).toEqual({ written: true, added: ["beta"] });
    const servers = await readMcpServers();
    expect(servers.alpha).toEqual(httpEntry(9101));
    expect(servers.beta).toEqual(httpEntry(9102));
    expect(Object.keys(servers).sort()).toEqual(["alpha", "beta"]);
  });

  test("高并发 20 个不同键 → 一个不丢", async () => {
    await reset();
    const entries = Array.from({ length: 20 }, (_, i) => [`k${i}`, httpEntry(9200 + i)] as const);
    await Promise.all(entries.map(([key, value]) => upsertMcpServers({ [key]: value })));
    const servers = await readMcpServers();
    expect(Object.keys(servers)).toHaveLength(20);
    for (const [key, value] of entries) expect(servers[key]).toEqual(value);
  });
});

describe("mcp-registry：幂等与保留", () => {
  test("内容一致 → 不落盘（written=false, added=[]，文件字节级不变）", async () => {
    await reset({ existing: { type: "stdio", command: "x" } });
    const once = await upsertMcpServers({ added: httpEntry(9301) });
    expect(once).toEqual({ written: true, added: ["added"] });
    const before = await fs.readFile(file, "utf8");
    const twice = await upsertMcpServers({ added: httpEntry(9301) });
    expect(twice).toEqual({ written: false, added: [] });
    expect(await fs.readFile(file, "utf8")).toBe(before);
    // 既有键（非本次给定）原样保留
    expect((await readMcpServers()).existing).toEqual({ type: "stdio", command: "x" });
  });

  test("内容变化（URL 变）→ 只改该键并写入", async () => {
    await reset({ a: httpEntry(9401), b: httpEntry(9402) });
    const r = await upsertMcpServers({ a: httpEntry(9501) });
    expect(r).toEqual({ written: true, added: ["a"] });
    const servers = await readMcpServers();
    expect(servers.a).toEqual(httpEntry(9501));
    expect(servers.b).toEqual(httpEntry(9402));
  });
});

describe("mcp-registry：remove 只删指定键", () => {
  test("删除点名键并保留其余；重复删除幂等", async () => {
    await reset({ a: httpEntry(9601), b: httpEntry(9602), c: httpEntry(9603) });
    const r = await removeMcpServers(["b", "missing"]);
    expect(r).toEqual({ written: true, removed: ["b"] });
    const servers = await readMcpServers();
    expect(Object.keys(servers).sort()).toEqual(["a", "c"]);
    expect(servers.a).toEqual(httpEntry(9601));
    expect(servers.c).toEqual(httpEntry(9603));
    const before = await fs.readFile(file, "utf8");
    const again = await removeMcpServers(["b"]);
    expect(again).toEqual({ written: false, removed: [] });
    expect(await fs.readFile(file, "utf8")).toBe(before);
  });
});
