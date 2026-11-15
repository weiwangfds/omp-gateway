/**
 * 会话格式与工具面（DESIGN §25，对齐 docs/session-format + docs/tools）：
 * - JSONL 校验/导入/原始下载
 * - entry 标签（label entry）+ 类型过滤 + 分页
 * - 工具能力发现（getAllToolInfos）
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 8911;
const BASE = `http://127.0.0.1:${PORT}`;
const TOK = "sessfmt-token";
const h = (uid: string) => ({ authorization: `Bearer ${TOK}`, "content-type": "application/json", "x-user-id": uid });

function readMiniMaxKey(): string | null {
  try {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const cfg = JSON.parse(readFileSync(path.join(process.env.USERPROFILE!, ".zcode", "cli", "config.json"), "utf8"));
    const key = cfg?.mcp?.servers?.minimax?.env?.MINIMAX_API_KEY;
    return typeof key === "string" && key.length > 20 ? key : null;
  } catch {
    return null;
  }
}
const mmKey = readMiniMaxKey();
const liveOk = mmKey !== null;
const dataRoot = mkdtempSync(path.join(tmpdir(), "omp-sessfmt-"));
let proc: Bun.Subprocess | null = null;
let sid = "";

/** 构造一份合法的最小会话 JSONL（v3 header + 两个条目）。 */
function makeSessionJsonl(headerId: string, opts: { cycle?: boolean; dupId?: boolean } = {}): string {
  const header = {
    type: "session",
    version: 3,
    id: headerId,
    timestamp: new Date().toISOString(),
    cwd: "/tmp/ws",
    title: "imported",
  };
  const e1 = {
    type: "message",
    id: "e1",
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: [{ type: "text", text: "hello" }] },
  };
  const e2 = {
    type: "message",
    id: "e2",
    parentId: opts.cycle ? "e3" : "e1",
    timestamp: new Date().toISOString(),
    message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
  };
  const e3 = {
    type: "message",
    id: opts.dupId ? "e1" : "e3",
    parentId: "e2",
    timestamp: new Date().toISOString(),
    message: { role: "user", content: [{ type: "text", text: "again" }] },
  };
  return `${[header, e1, e2, e3].map((o) => JSON.stringify(o)).join("\n")}\n`;
}

beforeAll(async () => {
  proc = Bun.spawn([process.execPath, "run", "src/index.ts"], {
    cwd: path.resolve(import.meta.dir, ".."),
    env: { ...process.env, GATEWAY_PORT: String(PORT), GATEWAY_DATA_ROOT: dataRoot, GATEWAY_SERVICE_TOKENS: TOK },
    stdout: "ignore",
    stderr: "ignore",
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  if (liveOk) {
    await fetch(`${BASE}/api/me/models/config`, {
      method: "PUT",
      headers: h("fu"),
      body: [
        "providers:",
        "  minimax:",
        "    baseUrl: https://api.minimax.cn/v1",
        "    api: openai-completions",
        "    models:",
        "      - id: MiniMax-M3.1-Flash",
        "        name: MiniMax M3.1 Flash",
        "",
      ].join("\n"),
    });
    await fetch(`${BASE}/api/me/models/credentials`, {
      method: "POST",
      headers: h("fu"),
      body: JSON.stringify({ provider: "minimax", apiKey: mmKey }),
    });
  }
  const created = await (await fetch(`${BASE}/api/sessions`, { method: "POST", headers: h("fu"), body: "{}" })).json();
  sid = created.id;
}, 25_000);

afterAll(() => {
  if (!proc) return;
  try {
    proc.kill();
  } catch {}
  try {
    Bun.spawnSync(["taskkill", "/F", "/T", "/PID", String(proc.pid)]);
  } catch {}
});

const raw = (_body: string) => ({
  authorization: `Bearer ${TOK}`,
  "content-type": "application/x-ndjson",
  "x-user-id": "fu",
});

describe("会话 JSONL：校验", () => {
  test("合法文件 → valid=true，统计正确", async () => {
    const r = await fetch(`${BASE}/api/sessions/validate`, {
      method: "POST",
      headers: raw(""),
      body: makeSessionJsonl("imp-valid-0001"),
    });
    expect(r.status).toBe(200);
    const b = (await r.json()) as any;
    expect(b.valid).toBeTrue();
    expect(b.stats.entries).toBe(3);
    expect(b.stats.version).toBe(3);
    expect(b.stats.sessionId).toBe("imp-valid-0001");
  });

  test("非法：空文件 / 坏 JSON / 非 session header / 重复 id / 环 / 不安全 id", async () => {
    const post = (body: string) => fetch(`${BASE}/api/sessions/validate`, { method: "POST", headers: raw(""), body });
    expect((await post("")).status).toBe(400);
    let b = (await (await post("{not json")).json()) as any;
    expect(b.valid).toBeFalse();
    expect(b.errors[0]).toContain("invalid JSON");
    b = (await (await post(JSON.stringify({ type: "message", id: "x" }))).json()) as any;
    expect(b.valid).toBeFalse();
    expect(b.errors.join()).toContain("type=session");
    b = (await (await post(makeSessionJsonl("imp-dup-0001", { dupId: true }))).json()) as any;
    expect(b.valid).toBeFalse();
    expect(b.errors.join()).toContain("duplicate entry id");
    b = (await (await post(makeSessionJsonl("imp-cycle-0001", { cycle: true }))).json()) as any;
    expect(b.valid).toBeFalse();
    expect(b.errors.join()).toContain("cycle");
    b = (await (await post(makeSessionJsonl("../../evil"))).json()) as any;
    expect(b.valid).toBeFalse();
    expect(b.errors.join()).toContain("unsafe characters");
  });
});

describe("会话 JSONL：导入 + 原始下载", () => {
  test("导入 → 201；重复导入 409；GET session-file 下载原文", async () => {
    const jsonl = makeSessionJsonl("imp-ok-000001");
    const imp = await fetch(`${BASE}/api/sessions/import`, { method: "POST", headers: raw(""), body: jsonl });
    expect(imp.status).toBe(201);
    const body = (await imp.json()) as any;
    expect(body.id).toBe("imp-ok-000001");
    expect(body.entries).toBeGreaterThanOrEqual(3); // 无模型环境会补一条 model_change
    if (body.injectedModel) expect(body.entries).toBe(4);
    expect(body.next).toContain("/bootstrap");
    // 无可用模型时导入的会话 revive 会返回 409 MODEL_UNAVAILABLE（明确错误，非 500）
    const entriesProbe = await fetch(`${BASE}/api/sessions/imp-ok-000001/entries`, { headers: h("fu") });
    expect([200, 409]).toContain(entriesProbe.status);
    if (entriesProbe.status === 409) {
      expect(((await entriesProbe.json()) as any).error.code).toBe("MODEL_UNAVAILABLE");
    }
    // 会话已可查询（列表可见）
    const list = (await (await fetch(`${BASE}/api/sessions?per_page=100`, { headers: h("fu") })).json()) as any;
    expect(list.sessions.some((s: any) => s.id === "imp-ok-000001")).toBeTrue();
    // 重复导入
    expect((await fetch(`${BASE}/api/sessions/import`, { method: "POST", headers: raw(""), body: jsonl })).status).toBe(
      409,
    );
    // 原始下载
    const dl = await fetch(`${BASE}/api/sessions/imp-ok-000001/session-file`, { headers: h("fu") });
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type") ?? "").toContain("ndjson");
    const text = await dl.text();
    expect(text).toContain('"type":"session"');
    expect(text).toContain("imp-ok-000001");
  });

  test("导入的非法文件不落库", async () => {
    const bad = await fetch(`${BASE}/api/sessions/import`, {
      method: "POST",
      headers: raw(""),
      body: makeSessionJsonl("imp-bad-000001", { cycle: true }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error.code).toBe("INVALID_SESSION_FILE");
    const list = (await (await fetch(`${BASE}/api/sessions?per_page=100`, { headers: h("fu") })).json()) as any;
    expect(list.sessions.some((s: any) => s.id === "imp-bad-000001")).toBeFalse();
  });

  test("跨用户下载 → 404；无文件的空会话 → 409", async () => {
    expect((await fetch(`${BASE}/api/sessions/imp-ok-000001/session-file`, { headers: h("other") })).status).toBe(404);
    expect([404, 409]).toContain(
      (await fetch(`${BASE}/api/sessions/${sid}/session-file`, { headers: h("fu") })).status,
    );
  });
});

describe.skipIf(!liveOk)("条目：类型过滤 / 分页 / 标签", () => {
  test("entries ?type= 过滤 + offset/limit", async () => {
    const b = (await (
      await fetch(`${BASE}/api/sessions/imp-ok-000001/entries?type=message&limit=2`, { headers: h("fu") })
    ).json()) as any;
    expect(b.entries.every((e: any) => e.type === "message")).toBeTrue();
    expect(b.entries.length).toBeLessThanOrEqual(2);
    expect(typeof b.total).toBe("number");
    const none = (await (
      await fetch(`${BASE}/api/sessions/imp-ok-000001/entries?type=no_such_type`, { headers: h("fu") })
    ).json()) as any;
    expect(none.entries).toEqual([]);
  });

  test("标签：PUT 打标 → GET 可见；非法 body 400；未知 entry 404；DELETE 移除", async () => {
    const put = (body: unknown) =>
      fetch(`${BASE}/api/sessions/imp-ok-000001/entries/e1/label`, {
        method: "PUT",
        headers: h("fu"),
        body: JSON.stringify(body),
      });
    expect((await put({ label: "重要节点" })).status).toBe(200);
    let list = (await (await fetch(`${BASE}/api/sessions/imp-ok-000001/entries`, { headers: h("fu") })).json()) as any;
    const e1 = list.entries.find((e: any) => e.id === "e1");
    expect(e1.label).toBe("重要节点");
    expect((await put({ label: "" })).status).toBe(400);
    expect(
      (
        await fetch(`${BASE}/api/sessions/imp-ok-000001/entries/nope/label`, {
          method: "PUT",
          headers: h("fu"),
          body: '{"label":"x"}',
        })
      ).status,
    ).toBe(404);
    expect(
      (await fetch(`${BASE}/api/sessions/imp-ok-000001/entries/e1/label`, { method: "DELETE", headers: h("fu") }))
        .status,
    ).toBe(200);
    list = (await (await fetch(`${BASE}/api/sessions/imp-ok-000001/entries`, { headers: h("fu") })).json()) as any;
    expect(list.entries.find((e: any) => e.id === "e1").label ?? null).toBeNull();
  });
});

describe.skipIf(!liveOk)("工具能力发现", () => {
  test("tools/info：描述/参数名/来源/active 标志", async () => {
    const b = (await (await fetch(`${BASE}/api/sessions/${sid}/tools/info`, { headers: h("fu") })).json()) as any;
    expect(Array.isArray(b.tools)).toBeTrue();
    expect(Array.isArray(b.all)).toBeTrue();
    expect(Array.isArray(b.active)).toBeTrue();
    const bash = b.tools.find((t: any) => t.name === "bash");
    if (bash) {
      expect(typeof bash.description).toBe("string");
      expect(Array.isArray(bash.parameterNames)).toBeTrue();
      expect(typeof bash.active).toBe("boolean");
    }
    // 每项都有基本形状
    for (const t of b.tools.slice(0, 5)) {
      expect(typeof t.name).toBe("string");
      expect(typeof t.description).toBe("string");
    }
  });

  test("跨用户/未知会话 404", async () => {
    expect((await fetch(`${BASE}/api/sessions/${sid}/tools/info`, { headers: h("other") })).status).toBe(404);
    expect((await fetch(`${BASE}/api/sessions/no-such/tools/info`, { headers: h("fu") })).status).toBe(404);
  });
});
