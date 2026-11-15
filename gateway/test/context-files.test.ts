/**
 * 上下文文件（DESIGN §26，对齐 docs/context-files）：
 * - 用户级 AGENTS/RULES/APPEND_SYSTEM/SYSTEM 管理（agentDir）
 * - 会话实际加载来源（systemPromptSources）
 * - 创建期 systemPrompt 完整替换 + appendSystemPrompt + contextFiles/noContextFiles
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 8931;
const BASE = `http://127.0.0.1:${PORT}`;
const TOK = "ctxfiles-token";
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
const dataRoot = mkdtempSync(path.join(tmpdir(), "omp-ctxfiles-"));
let proc: Bun.Subprocess | null = null;
let sid = "";

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
      headers: h("cu"),
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
      headers: h("cu"),
      body: JSON.stringify({ provider: "minimax", apiKey: mmKey }),
    });
  }
  const created = await (await fetch(`${BASE}/api/sessions`, { method: "POST", headers: h("cu"), body: "{}" })).json();
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

describe("用户级上下文文件", () => {
  test("支持清单 + 初始为空", async () => {
    const b = (await (await fetch(`${BASE}/api/me/context-files`, { headers: h("cu") })).json()) as any;
    expect(b.supported).toEqual(["AGENTS.md", "RULES.md", "APPEND_SYSTEM.md", "SYSTEM.md"]);
    expect(b.files).toEqual([]);
  });

  test("PUT → 列表/GET 往返 → DELETE；非法名 400；超限 413", async () => {
    const put = (name: string, body: string) =>
      fetch(`${BASE}/api/me/context-files/${name}`, {
        method: "PUT",
        headers: { ...h("cu"), "content-type": "text/markdown" },
        body,
      });
    expect((await put("AGENTS.md", "# 公司规范\n\n所有回答必须中文。")).status).toBe(201);
    const list = (await (await fetch(`${BASE}/api/me/context-files`, { headers: h("cu") })).json()) as any;
    expect(list.files.some((f: any) => f.name === "AGENTS.md")).toBeTrue();
    const raw = await (await fetch(`${BASE}/api/me/context-files/AGENTS.md`, { headers: h("cu") })).text();
    expect(raw).toContain("公司规范");
    expect((await put("bad.md", "x")).status).toBe(400);
    expect((await put("RULES.md", "x".repeat(256 * 1024 + 1))).status).toBe(413);
    expect((await fetch(`${BASE}/api/me/context-files/AGENTS.md`, { method: "DELETE", headers: h("cu") })).status).toBe(
      200,
    );
    expect((await fetch(`${BASE}/api/me/context-files/AGENTS.md`, { headers: h("cu") })).status).toBe(404);
  });

  test("跨用户隔离：他人看不到", async () => {
    await fetch(`${BASE}/api/me/context-files/AGENTS.md`, {
      method: "PUT",
      headers: { ...h("cu"), "content-type": "text/markdown" },
      body: "private",
    });
    const other = (await (await fetch(`${BASE}/api/me/context-files`, { headers: h("other") })).json()) as any;
    expect(other.files).toEqual([]);
    await fetch(`${BASE}/api/me/context-files/AGENTS.md`, { method: "DELETE", headers: h("cu") });
  });
});

describe("创建期提示词注入选项", () => {
  test("systemPrompt 超限 → 413；合法 → 201", async () => {
    const big = await fetch(`${BASE}/api/sessions`, {
      method: "POST",
      headers: h("cu"),
      body: JSON.stringify({ systemPrompt: "x".repeat(256 * 1024 + 1) }),
    });
    expect(big.status).toBe(413);
    const ok = await fetch(`${BASE}/api/sessions`, {
      method: "POST",
      headers: h("cu"),
      body: JSON.stringify({ title: "sys", systemPrompt: "You are a strict assistant. Answer in JSON only." }),
    });
    expect(ok.status).toBe(201);
  });

  test("appendSystemPrompt + contextFiles + noContextFiles 组合 → 201", async () => {
    const r = await fetch(`${BASE}/api/sessions`, {
      method: "POST",
      headers: h("cu"),
      body: JSON.stringify({
        appendSystemPrompt: "公司规范：回答需引用条款号。",
        contextFiles: [{ path: "kb/a.md", content: "# KB\n规则 A" }],
        noContextFiles: true,
      }),
    });
    expect(r.status).toBe(201);
  });
});

describe.skipIf(!liveOk)("会话级上下文来源", () => {
  test("context-files：返回 instructionFiles/skills/blocks 结构", async () => {
    // 先写用户级 AGENTS.md（新会话应发现）
    await fetch(`${BASE}/api/me/context-files/AGENTS.md`, {
      method: "PUT",
      headers: { ...h("cu"), "content-type": "text/markdown" },
      body: "# 用户级规范\n\n回答必须简洁。",
    });
    const created = await (
      await fetch(`${BASE}/api/sessions`, {
        method: "POST",
        headers: h("cu"),
        body: JSON.stringify({ title: "ctx-source", model: { provider: "minimax", modelId: "MiniMax-M3.1-Flash" } }),
      })
    ).json();
    const b = (await (
      await fetch(`${BASE}/api/sessions/${created.id}/context-files`, { headers: h("cu") })
    ).json()) as any;
    expect(Array.isArray(b.files)).toBeTrue();
    expect(Array.isArray(b.skills)).toBeTrue();
    expect(typeof b.promptBlocks).toBe("number");
    // 用户级 AGENTS.md 应被扫到，并给出 applied 判定
    const agents = b.files.find((f: any) => f.scope === "user" && f.name === "AGENTS.md");
    expect(agents).toBeTruthy();
    expect(typeof agents.applied).toBe("boolean");
    expect(agents.applied).toBeTrue(); // 内容应已进入系统提示词
    await fetch(`${BASE}/api/me/context-files/AGENTS.md`, { method: "DELETE", headers: h("cu") });
  });

  test("跨用户/未知会话 404", async () => {
    expect((await fetch(`${BASE}/api/sessions/${sid}/context-files`, { headers: h("other") })).status).toBe(404);
    expect((await fetch(`${BASE}/api/sessions/no-such/context-files`, { headers: h("cu") })).status).toBe(404);
  });
});
