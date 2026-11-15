/**
 * 编码任务 e2e：让 agent 通过网关真实写代码——
 * 工具调用（write）→ 文件落盘 → git 提交 → 快照/分叉继承代码 → 用量累计。
 * 凭据来自本机 ZCode 配置（无则跳过）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 8793;
const BASE = `http://127.0.0.1:${PORT}`;
const TOK = "code-token";
const H = { authorization: `Bearer ${TOK}`, "content-type": "application/json" };
const h = (uid: string) => ({ ...H, "x-user-id": uid });

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

const dataRoot = mkdtempSync(path.join(tmpdir(), "omp-gw-code-"));
let proc: Bun.Subprocess | null = null;
const key = readMiniMaxKey();
const run = key !== null;
let sid = "";

beforeAll(async () => {
  if (!run) return;
  mkdirSync(path.join(dataRoot, "users", "coder", "agent"), { recursive: true });
  proc = Bun.spawn([process.execPath, "run", "src/index.ts"], {
    cwd: path.resolve(import.meta.dir, ".."),
    env: {
      ...process.env,
      GATEWAY_PORT: String(PORT),
      GATEWAY_DATA_ROOT: dataRoot,
      GATEWAY_SERVICE_TOKENS: TOK,
      GATEWAY_MAX_GLOBAL_STREAMING: "2",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  const cfg = await fetch(`${BASE}/api/me/models/config`, {
    method: "PUT",
    headers: h("coder"),
    body: "providers:\n  minimax:\n    baseUrl: https://api.minimax.cn/v1\n    api: openai-completions\n    models:\n      - id: MiniMax-M3.1-Flash\n        name: MiniMax M3.1 Flash\n",
  });
  if (cfg.status !== 200) throw new Error("config PUT failed");
  await fetch(`${BASE}/api/me/models/credentials`, {
    method: "POST",
    headers: h("coder"),
    body: JSON.stringify({ provider: "minimax", apiKey: key }),
  });
}, 30_000);

afterAll(() => {
  if (!proc) return;
  try {
    proc.kill();
  } catch {}
  try {
    Bun.spawnSync(["taskkill", "/F", "/T", "/PID", String(proc.pid)]);
  } catch {}
});

function startCollector(uid: string, sessionId: string) {
  const frames: Array<{ event: string; data: any }> = [];
  const ac = new AbortController();
  void (async () => {
    try {
      const res = await fetch(`${BASE}/api/sessions/${sessionId}/events`, { headers: h(uid), signal: ac.signal });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        for (let idx = buf.indexOf("\n\n"); idx >= 0; idx = buf.indexOf("\n\n")) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev = frame.match(/^event: (.+)$/m)?.[1];
          const data = frame.match(/^data: (.+)$/m)?.[1];
          if (ev && data) {
            try {
              frames.push({ event: ev, data: JSON.parse(data) });
            } catch {}
          }
        }
      }
    } catch {}
  })();
  return { frames, stop: () => ac.abort() };
}

const waitFor = async (cond: () => boolean, ms: number, step = 500) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return await cond();
};

describe.skipIf(!run)("编码任务 e2e（真实模型 + 工具执行）", () => {
  test("agent 写代码 → 文件落盘 → git 提交 → 快照分叉继承代码", async () => {
    // 1. 建会话
    const created = await (
      await fetch(`${BASE}/api/sessions`, {
        method: "POST",
        headers: h("coder"),
        body: JSON.stringify({ title: "coding-task", model: { provider: "minimax", modelId: "MiniMax-M3.1-Flash" } }),
      })
    ).json();
    sid = created.id;

    // 2. 先订阅后 prompt（契约时序）
    const col = startCollector("coder", sid);
    await new Promise((r) => setTimeout(r, 500));
    const pr = await fetch(`${BASE}/api/sessions/${sid}/prompt`, {
      method: "POST",
      headers: h("coder"),
      body: JSON.stringify({
        text:
          "Use the write tool to create a file named hello.py with exactly this content:\n" +
          "def add(a, b):\n    return a + b\n\n" +
          "print(add(2, 3))\n" +
          "Do not run it. After writing, reply with just: DONE",
      }),
    });
    expect(pr.status).toBe(202);

    // 3. 等 turn 终态（推理模型 + 工具调用，放宽到 3 分钟）
    const done = await waitFor(
      () => col.frames.some((f) => f.event === "turn.completed" && f.data.isTerminal),
      180_000,
    );
    expect(done).toBeTrue();
    col.stop();

    // 4. 工具确实执行了（write）
    const toolStarts = col.frames.filter((f) => f.event === "tool.started");
    expect(toolStarts.length).toBeGreaterThan(0);
    expect(toolStarts.some((f) => ["write", "edit", "bash"].includes(f.data.name))).toBeTrue();
    expect(col.frames.filter((f) => f.event === "tool.completed").length).toBe(toolStarts.length);

    // 5. 文件真实落盘（经网关文件 API 读回）
    const file = await (await fetch(`${BASE}/api/sessions/${sid}/file?path=hello.py`, { headers: h("coder") })).json();
    expect(file.encoding).toBe("utf8");
    expect(file.content).toContain("def add");

    // 6. git：init → status 可见 → 网关提交 → 干净
    const wsDir = path.join(dataRoot, "users", "coder", "workspaces", sid);
    Bun.spawnSync(["git", "init", "-q"], { cwd: wsDir });
    Bun.spawnSync(["git", "config", "user.email", "e2e@local"], { cwd: wsDir });
    Bun.spawnSync(["git", "config", "user.name", "e2e"], { cwd: wsDir });
    const st1 = await (await fetch(`${BASE}/api/sessions/${sid}/git/status`, { headers: h("coder") })).json();
    expect(st1.entries.some((e: any) => e.path.includes("hello.py"))).toBeTrue();
    const commit = await fetch(`${BASE}/api/sessions/${sid}/git/commit`, {
      method: "POST",
      headers: h("coder"),
      body: '{"message":"agent wrote hello.py","add":"all"}',
    });
    expect(commit.status).toBe(200);
    const st2 = await (await fetch(`${BASE}/api/sessions/${sid}/git/status`, { headers: h("coder") })).json();
    expect(st2.entries).toHaveLength(0);

    // 7. 快照（代码入库）→ fork 恢复 → 分叉会话的 workspace 里有同一份代码
    const snap = await (
      await fetch(`${BASE}/api/sessions/${sid}/snapshots`, {
        method: "POST",
        headers: h("coder"),
        body: '{"name":"with-code"}',
      })
    ).json();
    expect(snap.entry_count).toBeGreaterThan(0);
    const fork = await (
      await fetch(`${BASE}/api/sessions/${sid}/snapshots/${snap.id}/restore`, {
        method: "POST",
        headers: h("coder"),
        body: '{"mode":"fork"}',
      })
    ).json();
    expect(fork.parentId).toBe(sid);
    const forkFile = await (
      await fetch(`${BASE}/api/sessions/${fork.id}/file?path=hello.py`, { headers: h("coder") })
    ).json();
    expect(forkFile.content).toContain("def add");

    // 8. 用量已累计（真实 turn）
    const usage = await (await fetch(`${BASE}/api/sessions/${sid}/usage`, { headers: h("coder") })).json();
    expect(usage.summary.turns).toBeGreaterThanOrEqual(1);
    expect(usage.summary.outputTokens).toBeGreaterThan(0);
    expect(usage.summary.costUsd).toBeGreaterThan(0);
  }, 240_000);
});
