/**
 * 集成端 HTTP 工具（DESIGN §24）e2e：业务端点注册为 agent 工具 → 模型真实调用。
 * 覆盖：双作用域 CRUD 校验、模型调用触发回调（args 透传）、结果回填、作用域隔离。
 * 凭据缺失时跳过模型部分。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 8891;
const TOOL_PORT = 8892;
const BASE = `http://127.0.0.1:${PORT}`;
const TOK = "httptool-token";
const h = (uid: string) => ({ authorization: `Bearer ${TOK}`, "content-type": "application/json", "x-user-id": uid });
const TOOL_URL = `http://127.0.0.1:${TOOL_PORT}/tool`;

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
const dataRoot = mkdtempSync(path.join(tmpdir(), "omp-httptool-"));
let proc: Bun.Subprocess | null = null;
let toolSrv: ReturnType<typeof Bun.serve> | null = null;
const calls: Array<{ body: any; sig: string; tool: string }> = [];

beforeAll(async () => {
  toolSrv = Bun.serve({
    port: TOOL_PORT,
    async fetch(req) {
      const body = await req.json().catch(() => ({}));
      calls.push({ body, sig: req.headers.get("x-omp-signature") ?? "", tool: req.headers.get("x-omp-tool") ?? "" });
      // 业务实现：查询订单状态
      const orderId = body?.args?.orderId ?? "unknown";
      return Response.json({ text: `订单 ${orderId} 状态：已发货（来自业务系统）` });
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
  if (run) {
    await fetch(`${BASE}/api/me/models/config`, {
      method: "PUT",
      headers: h("toolu"),
      body: "providers:\n  minimax:\n    baseUrl: https://api.minimax.cn/v1\n    api: openai-completions\n    models:\n      - id: MiniMax-M3.1-Flash\n        name: MiniMax M3.1 Flash\n",
    });
    await fetch(`${BASE}/api/me/models/credentials`, {
      method: "POST",
      headers: h("toolu"),
      body: JSON.stringify({ provider: "minimax", apiKey: key }),
    });
  }
}, 30_000);

afterAll(() => {
  try {
    toolSrv?.stop();
  } catch {}
  if (!proc) return;
  try {
    proc.kill();
  } catch {}
  try {
    Bun.spawnSync(["taskkill", "/F", "/T", "/PID", String(proc.pid)]);
  } catch {}
});

const REG_BODY = {
  description: "查询订单状态（业务系统）。参数 orderId 为订单号。",
  parameters: {
    type: "object",
    properties: { orderId: { type: "string", description: "订单号" } },
    required: ["orderId"],
  },
  url: TOOL_URL,
  label: "订单查询",
  timeoutMs: 10_000,
};

describe("HTTP 工具：双作用域（用户级 + 会话级）", () => {
  test("用户级注册 → 会话级同名覆盖；会话只看自己的 + 用户级", async () => {
    const created = await (
      await fetch(`${BASE}/api/sessions`, { method: "POST", headers: h("toolu"), body: "{}" })
    ).json();
    const sid = created.id;
    // 用户级
    await fetch(`${BASE}/api/me/tools/http/scope_tool`, {
      method: "PUT",
      headers: h("toolu"),
      body: JSON.stringify({ ...REG_BODY, description: "用户级版本", url: TOOL_URL }),
    });
    let list = (await (await fetch(`${BASE}/api/sessions/${sid}/tools/http`, { headers: h("toolu") })).json()) as any;
    expect(list.tools.some((t: any) => t.name === "scope_tool")).toBeFalse(); // 会话清单只列会话级
    expect(list.userLevel.some((t: any) => t.name === "scope_tool")).toBeTrue();
    // 会话级同名
    const put = await fetch(`${BASE}/api/sessions/${sid}/tools/http/scope_tool`, {
      method: "PUT",
      headers: h("toolu"),
      body: JSON.stringify({ ...REG_BODY, description: "会话级版本" }),
    });
    expect(put.status).toBe(201);
    list = (await (await fetch(`${BASE}/api/sessions/${sid}/tools/http`, { headers: h("toolu") })).json()) as any;
    expect(list.tools.some((t: any) => t.name === "scope_tool" && t.description === "会话级版本")).toBeTrue();
    // 会话级删除只影响会话级，用户级仍在
    expect(
      (await fetch(`${BASE}/api/sessions/${sid}/tools/http/scope_tool`, { method: "DELETE", headers: h("toolu") }))
        .status,
    ).toBe(200);
    const userList = (await (await fetch(`${BASE}/api/me/tools/http`, { headers: h("toolu") })).json()) as any;
    expect(userList.tools.some((t: any) => t.name === "scope_tool")).toBeTrue();
    await fetch(`${BASE}/api/me/tools/http/scope_tool`, { method: "DELETE", headers: h("toolu") });
  });

  test("会话级：跨用户 404；未知会话 404", async () => {
    const created = await (
      await fetch(`${BASE}/api/sessions`, { method: "POST", headers: h("toolu"), body: "{}" })
    ).json();
    const sid = created.id;
    expect((await fetch(`${BASE}/api/sessions/${sid}/tools/http`, { headers: h("other") })).status).toBe(404);
    expect((await fetch(`${BASE}/api/sessions/no-such/tools/http`, { headers: h("toolu") })).status).toBe(404);
  });
});

describe("HTTP 工具：CRUD 与校验", () => {
  test("注册 → 列表 → 删除；secret 仅首次返回", async () => {
    const put = await fetch(`${BASE}/api/me/tools/http/order_status`, {
      method: "PUT",
      headers: h("toolu"),
      body: JSON.stringify(REG_BODY),
    });
    expect(put.status).toBe(201);
    const created = (await put.json()) as any;
    expect(created.ok).toBeTrue();
    expect(created.secret.startsWith("whsec_")).toBeTrue();
    const list = (await (await fetch(`${BASE}/api/me/tools/http`, { headers: h("toolu") })).json()) as any;
    expect(list.tools.some((t: any) => t.name === "order_status")).toBeTrue();
    expect(list.tools.every((t: any) => t.secret === undefined)).toBeTrue();
    // 更新不重置 secret（响应里 secret 为 undefined）
    const put2 = await fetch(`${BASE}/api/me/tools/http/order_status`, {
      method: "PUT",
      headers: h("toolu"),
      body: JSON.stringify({ ...REG_BODY, description: "更新后的描述" }),
    });
    expect(put2.status).toBe(201);
    expect(((await put2.json()) as any).secret).toBeUndefined();
    // 删除
    expect(
      (await fetch(`${BASE}/api/me/tools/http/order_status`, { method: "DELETE", headers: h("toolu") })).status,
    ).toBe(200);
    expect(
      (await fetch(`${BASE}/api/me/tools/http/order_status`, { method: "DELETE", headers: h("toolu") })).status,
    ).toBe(404);
  });

  test("非法名/内置名冲突/缺参数/非法 URL → 400", async () => {
    const put = (name: string, body: unknown) =>
      fetch(`${BASE}/api/me/tools/http/${name}`, { method: "PUT", headers: h("toolu"), body: JSON.stringify(body) });
    expect((await put("Bad-Name", REG_BODY)).status).toBe(400);
    expect((await put("bash", REG_BODY)).status).toBe(400); // 内置工具冲突
    expect((await put("order_status", { ...REG_BODY, parameters: undefined })).status).toBe(400);
    expect((await put("order_status", { ...REG_BODY, url: "ftp://x" })).status).toBe(400);
    expect((await put("order_status", { ...REG_BODY, description: "" })).status).toBe(400);
  });

  test("跨用户隔离：他人看不到/删不掉", async () => {
    await fetch(`${BASE}/api/me/tools/http/order_status`, {
      method: "PUT",
      headers: h("toolu"),
      body: JSON.stringify(REG_BODY),
    });
    const other = (await (await fetch(`${BASE}/api/me/tools/http`, { headers: h("other") })).json()) as any;
    expect(other.tools.some((t: any) => t.name === "order_status")).toBeFalse();
    expect(
      (await fetch(`${BASE}/api/me/tools/http/order_status`, { method: "DELETE", headers: h("other") })).status,
    ).toBe(404);
  });
});

describe.skipIf(!run)("HTTP 工具：模型真实调用", () => {
  test("注册后新建会话 → 模型调用 order_status → 业务端点收到 args 并回填结果", async () => {
    const put = await fetch(`${BASE}/api/me/tools/http/order_status`, {
      method: "PUT",
      headers: h("toolu"),
      body: JSON.stringify(REG_BODY),
    });
    expect(put.status).toBe(201);

    const created = await (
      await fetch(`${BASE}/api/sessions`, {
        method: "POST",
        headers: h("toolu"),
        body: JSON.stringify({ title: "http-tool", model: { provider: "minimax", modelId: "MiniMax-M3.1-Flash" } }),
      })
    ).json();
    const sid = created.id;

    const pr = await fetch(`${BASE}/api/sessions/${sid}/prompt`, {
      method: "POST",
      headers: h("toolu"),
      body: JSON.stringify({
        text: "Call the order_status tool with orderId=A-1001, then report its result verbatim.",
        wait: true,
        waitTimeoutMs: 180_000,
      }),
    });
    expect(pr.status).toBe(202);

    // 业务端点被调用，args 与签名齐备
    expect(calls.length).toBeGreaterThan(0);
    const call = calls.find((x) => x.body?.args?.orderId === "A-1001");
    expect(call).toBeTruthy();
    expect(call!.tool).toBe("order_status");
    expect(call!.sig).toHaveLength(64);
    expect(call!.body.name).toBe("order_status");

    // 结果回填到事件流（tool.completed 含业务文案）
    const replay = (await (
      await fetch(`${BASE}/api/sessions/${sid}/events/replay?since=0&limit=500`, { headers: h("toolu") })
    ).json()) as any;
    const hit = (replay.events as any[]).some(
      (e) => e.type === "tool.completed" && JSON.stringify(e.result ?? {}).includes("订单 A-1001 状态：已发货"),
    );
    expect(hit).toBeTrue();

    // 清理
    await fetch(`${BASE}/api/me/tools/http/order_status`, { method: "DELETE", headers: h("toolu") });
  }, 300_000);
});
