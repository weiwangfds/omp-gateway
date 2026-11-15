/**
 * 集成端钩子 e2e（真实模型）：tool_call decide 钩子拦截 bash。
 * 验证：钩子收到回调 → 返回 {block:true} → 工具被拒（目标输出不出现）。
 * 凭据缺失时跳过。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 8881;
const HOOK_PORT = 8882;
const BASE = `http://127.0.0.1:${PORT}`;
const TOK = "hook-e2e-token";
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

const key = readMiniMaxKey();
const run = key !== null;
const dataRoot = mkdtempSync(path.join(tmpdir(), "omp-hook-e2e-"));
let proc: Bun.Subprocess | null = null;
let hookSrv: ReturnType<typeof Bun.serve> | null = null;
const HOOK_URL = `http://127.0.0.1:${HOOK_PORT}/hook`;
const received: Array<{ event: string; body: any }> = [];
/** tool_call 决策：默认 block 含 "SHOULD-NOT-RUN" 的 bash 命令 */
let decide: (body: any) => unknown = (body) =>
  body?.toolName === "bash" && JSON.stringify(body.input ?? {}).includes("SHOULD-NOT-RUN")
    ? { block: true, reason: "blocked by business hook: forbidden command" }
    : {};

beforeAll(async () => {
  if (!run) return;
  hookSrv = Bun.serve({
    port: HOOK_PORT,
    async fetch(req) {
      const body = await req.json().catch(() => ({}));
      received.push({ event: req.headers.get("x-omp-hook-event") ?? "", body });
      return Response.json(decide(body));
    },
  });
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
  await fetch(`${BASE}/api/me/models/config`, {
    method: "PUT",
    headers: h("hooker"),
    body: "providers:\n  minimax:\n    baseUrl: https://api.minimax.cn/v1\n    api: openai-completions\n    models:\n      - id: MiniMax-M3.1-Flash\n        name: MiniMax M3.1 Flash\n",
  });
  await fetch(`${BASE}/api/me/models/credentials`, {
    method: "POST",
    headers: h("hooker"),
    body: JSON.stringify({ provider: "minimax", apiKey: key }),
  });
}, 30_000);

afterAll(() => {
  try {
    hookSrv?.stop();
  } catch {}
  if (!proc) return;
  try {
    proc.kill();
  } catch {}
  try {
    Bun.spawnSync(["taskkill", "/F", "/T", "/PID", String(proc.pid)]);
  } catch {}
});

describe.skipIf(!run)("集成端钩子 e2e（真实模型）", () => {
  test("tool_call decide 钩子 → 拦截 bash（目标输出不出现）", async () => {
    const created = await (
      await fetch(`${BASE}/api/sessions`, {
        method: "POST",
        headers: h("hooker"),
        body: JSON.stringify({ title: "hook-block", model: { provider: "minimax", modelId: "MiniMax-M3.1-Flash" } }),
      })
    ).json();
    const sid = created.id;
    const reg = await fetch(`${BASE}/api/sessions/${sid}/hooks`, {
      method: "POST",
      headers: h("hooker"),
      body: JSON.stringify({
        event: "tool_call",
        mode: "decide",
        url: HOOK_URL,
        matcher: { tool: "bash" },
        timeoutMs: 5000,
        onTimeout: "allow",
      }),
    });
    expect(reg.status).toBe(201);

    const pr = await fetch(`${BASE}/api/sessions/${sid}/prompt`, {
      method: "POST",
      headers: h("hooker"),
      body: JSON.stringify({
        text: "Use bash to run exactly: echo SHOULD-NOT-RUN. If blocked, reply with just BLOCKED and do not retry.",
        wait: true,
        waitTimeoutMs: 120_000,
      }),
    });
    expect(pr.status).toBe(202);

    // 钩子必须收到 tool_call（matcher=bash）
    const asked = received.filter((r) => r.event === "tool_call");
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.some((r) => r.body.toolName === "bash")).toBeTrue();

    // 被拦截：回放里不应出现工具执行的 SHOULD-NOT-RUN 输出
    const replay = (await (
      await fetch(`${BASE}/api/sessions/${sid}/events/replay?since=0&limit=500`, { headers: h("hooker") })
    ).json()) as any;
    const leaked = (replay.events as any[]).some(
      (e) => e.type === "tool.completed" && JSON.stringify(e.result ?? {}).includes("SHOULD-NOT-RUN"),
    );
    expect(leaked).toBeFalse();
  }, 300_000);

  test("input decide 钩子 → 改写用户输入", async () => {
    const created = await (
      await fetch(`${BASE}/api/sessions`, {
        method: "POST",
        headers: h("hooker"),
        body: JSON.stringify({ title: "hook-rewrite", model: { provider: "minimax", modelId: "MiniMax-M3.1-Flash" } }),
      })
    ).json();
    const sid = created.id;
    decide = () => ({ text: "Reply with exactly: REWRITTEN" });
    const reg = await fetch(`${BASE}/api/sessions/${sid}/hooks`, {
      method: "POST",
      headers: h("hooker"),
      body: JSON.stringify({ event: "input", mode: "decide", url: HOOK_URL, timeoutMs: 5000 }),
    });
    expect(reg.status).toBe(201);
    await fetch(`${BASE}/api/sessions/${sid}/prompt`, {
      method: "POST",
      headers: h("hooker"),
      body: JSON.stringify({ text: "IGNORE THIS", wait: true, waitTimeoutMs: 120_000 }),
    });
    const messages = (await (
      await fetch(`${BASE}/api/sessions/${sid}/messages`, { headers: h("hooker") })
    ).json()) as any;
    const userTexts = (messages.messages ?? [])
      .filter((m: any) => m.role === "user")
      .map((m: any) =>
        (m.content ?? [])
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join(""),
      );
    expect(userTexts.some((t: string) => t.includes("REWRITTEN"))).toBeTrue();
    expect(userTexts.some((t: string) => t.includes("IGNORE THIS"))).toBeFalse();
  }, 300_000);
});
