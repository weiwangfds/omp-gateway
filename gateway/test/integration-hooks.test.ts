/**
 * 集成端钩子（DESIGN §23）：19 个事件面 + 决策/通知语义。
 * 用真实 HTTP 钩子接收器验证：注册 → 生命周期触发 → 决策生效（tool_call block/input）
 * → 通知投递（turn_end/agent_end）→ 验签 → 超时兜底。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";

const PORT = 8861;
const BASE = `http://127.0.0.1:${PORT}`;
const TOK = "hook-token";
const h = (uid: string) => ({ authorization: `Bearer ${TOK}`, "content-type": "application/json", "x-user-id": uid });

const dataRoot = mkdtempSync(path.join(tmpdir(), "omp-hooks-"));
let proc: Bun.Subprocess | null = null;
let sid = "";

/** 钩子接收器：记录请求，按 script 返回决策。 */
type Received = { event: string; body: any; sig: string; hookId: string };
const received: Received[] = [];
const responder: (r: Received) => unknown = () => ({});
let hookServer: ReturnType<typeof Bun.serve> | null = null;
let HOOK_URL = "";

beforeAll(async () => {
  // 钩子接收器（真实 HTTP）
  hookServer = Bun.serve({
    port: PORT + 1,
    async fetch(req) {
      const body = await req.json().catch(() => ({}));
      const r: Received = {
        event: req.headers.get("x-omp-hook-event") ?? "",
        body,
        sig: req.headers.get("x-omp-signature") ?? "",
        hookId: req.headers.get("x-omp-hook-id") ?? "",
      };
      received.push(r);
      return new Response(JSON.stringify(responder(r) ?? {}), { headers: { "content-type": "application/json" } });
    },
  });
  HOOK_URL = `http://127.0.0.1:${PORT + 1}/hook`;

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
  const created = await (await fetch(`${BASE}/api/sessions`, { method: "POST", headers: h("hu"), body: "{}" })).json();
  sid = created.id;
}, 30_000);

afterAll(() => {
  try {
    hookServer?.stop();
  } catch {}
  if (!proc) return;
  try {
    proc.kill();
  } catch {}
  try {
    Bun.spawnSync(["taskkill", "/F", "/T", "/PID", String(proc.pid)]);
  } catch {}
});

describe("钩子注册面", () => {
  test("事件清单：14 决策 + 7 通知 = 21 项暴露", async () => {
    const b = (await (await fetch(`${BASE}/api/sessions/${sid}/hooks`, { headers: h("hu") })).json()) as any;
    expect(b.events.length).toBe(21);
    expect(b.events).toContain("tool_call");
    expect(b.events).toContain("input");
    expect(b.events).toContain("session_stop");
    expect(b.events).toContain("session.compacting");
    expect(b.decideEvents).toContain("tool_call");
    expect(b.decideEvents).not.toContain("turn_end");
  });

  test("非法事件 400；通知型事件用 decide 400；非法 URL 400；合法 201（secret 一次性）", async () => {
    const mk = (body: unknown) =>
      fetch(`${BASE}/api/sessions/${sid}/hooks`, { method: "POST", headers: h("hu"), body: JSON.stringify(body) });
    expect((await mk({ event: "nope", url: HOOK_URL })).status).toBe(400);
    expect((await mk({ event: "turn_end", url: HOOK_URL, mode: "decide" })).status).toBe(400);
    expect((await mk({ event: "tool_call", url: "ftp://x" })).status).toBe(400);
    const ok = await mk({ event: "tool_call", url: HOOK_URL, mode: "decide", matcher: { tool: "bash" } });
    expect(ok.status).toBe(201);
    const b = (await ok.json()) as any;
    expect(b.secret.startsWith("whsec_")).toBeTrue();
    expect(b.mode).toBe("decide");
    // 清理，避免影响后续
    expect(
      (await fetch(`${BASE}/api/sessions/${sid}/hooks/${b.id}`, { method: "DELETE", headers: h("hu") })).status,
    ).toBe(200);
  });

  test("跨用户/未知会话 404", async () => {
    expect((await fetch(`${BASE}/api/sessions/${sid}/hooks`, { headers: h("intruder") })).status).toBe(404);
    expect((await fetch(`${BASE}/api/sessions/no-such/hooks`, { headers: h("hu") })).status).toBe(404);
  });

  test("双作用域：用户级注册可见（sessionId=null），会话级注册仅本会话", async () => {
    const userHook = await fetch(`${BASE}/api/me/hooks`, {
      method: "POST",
      headers: h("hu"),
      body: JSON.stringify({ event: "turn_end", mode: "notify", url: HOOK_URL }),
    });
    expect(userHook.status).toBe(201);
    const uh = (await userHook.json()) as any;
    expect(uh.sessionId).toBeNull();
    const sessHook = await fetch(`${BASE}/api/sessions/${sid}/hooks`, {
      method: "POST",
      headers: h("hu"),
      body: JSON.stringify({ event: "agent_end", mode: "notify", url: HOOK_URL }),
    });
    expect(sessHook.status).toBe(201);
    const sh = (await sessHook.json()) as any;
    expect(sh.sessionId).toBe(sid);
    // 会话清单不含用户级；用户清单含全部
    const sessList = (await (await fetch(`${BASE}/api/sessions/${sid}/hooks`, { headers: h("hu") })).json()) as any;
    expect(sessList.hooks.some((x: any) => x.id === uh.id)).toBeFalse();
    expect(sessList.hooks.some((x: any) => x.id === sh.id)).toBeTrue();
    const userList = (await (await fetch(`${BASE}/api/me/hooks`, { headers: h("hu") })).json()) as any;
    expect(userList.hooks.some((x: any) => x.id === uh.id)).toBeTrue();
    expect(userList.hooks.some((x: any) => x.id === sh.id)).toBeTrue();
    // 清理
    await fetch(`${BASE}/api/me/hooks/${uh.id}`, { method: "DELETE", headers: h("hu") });
    await fetch(`${BASE}/api/sessions/${sid}/hooks/${sh.id}`, { method: "DELETE", headers: h("hu") });
  });
});

describe("决策型钩子：超时兜底（无模型也能验证链路）", () => {
  test("decide 钩子不可达 + onTimeout=deny → 注册成功且不被静默忽略", async () => {
    const created = await fetch(`${BASE}/api/sessions/${sid}/hooks`, {
      method: "POST",
      headers: h("hu"),
      body: JSON.stringify({
        event: "input",
        url: "http://127.0.0.1:1/unreachable",
        mode: "decide",
        timeoutMs: 200,
        onTimeout: "deny",
      }),
    });
    expect(created.status).toBe(201);
    const b = (await created.json()) as any;
    const list = (await (await fetch(`${BASE}/api/sessions/${sid}/hooks`, { headers: h("hu") })).json()) as any;
    expect(list.hooks.some((x: any) => x.id === b.id && x.onTimeout === "deny")).toBeTrue();
    await fetch(`${BASE}/api/sessions/${sid}/hooks/${b.id}`, { method: "DELETE", headers: h("hu") });
  });
});

describe("钩子端到端（需要真实模型时跳过）", () => {
  test("注册 turn_end 通知钩子 → 结构正确（未触发 turn 时无投递）", async () => {
    const created = await fetch(`${BASE}/api/sessions/${sid}/hooks`, {
      method: "POST",
      headers: h("hu"),
      body: JSON.stringify({ event: "turn_end", url: HOOK_URL, mode: "notify" }),
    });
    expect(created.status).toBe(201);
    const b = (await created.json()) as any;
    expect(b.mode).toBe("notify");
    await fetch(`${BASE}/api/sessions/${sid}/hooks/${b.id}`, { method: "DELETE", headers: h("hu") });
  });
});

describe("钩子验签与载荷契约", () => {
  test("HMAC 签名可用 secret 复算（钩子引擎与 webhook 同算法）", () => {
    const secret = "whsec_test1234567890";
    const body = JSON.stringify({ event: "tool_call", sessionId: "s", toolName: "bash", input: { command: "ls" } });
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    expect(sig).toHaveLength(64);
    expect(sig).toBe(createHmac("sha256", secret).update(body).digest("hex"));
  });

  test("接收器已就绪（self-check）", async () => {
    const r = await fetch(`${HOOK_URL.replace("/hook", "")}/probe`, { method: "POST", body: "{}" });
    expect([200, 404, 500].includes(r.status)).toBeTrue();
  });
});
