/**
 * M7-M10 端点与机制测试（DESIGN §20）：
 * - M7 审批策略（mode+policies+grants+审计三事件）
 * - M8 Agent Hub 收尾（未知 agent 的 chat/kill/revive 一致 404、mcp/reload）
 * - M9 tool.started args 增补
 * - M10 sqlite 备份 + webhook 白名单
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { normalizeOmpEvent } from "../src/core/events.ts";
import { SessionCtx } from "../src/core/session-registry.ts";
import { backupToFile } from "../src/core/tenant-store.ts";
import { isWebhookUrlAllowed } from "../src/core/webhooks.ts";
import { config } from "../src/config.ts";

// ---- M9：tool.started args 增补（additive）----
test("M9: normalizeOmpEvent tool_execution_start 携带 args", () => {
  const ev = normalizeOmpEvent({
    type: "tool_execution_start",
    toolCallId: "c1",
    toolName: "bash",
    args: { command: "echo hi" },
  } as never);
  expect(ev.type).toBe("tool.started");
  expect((ev as any).callId).toBe("c1");
  expect((ev as any).name).toBe("bash");
  expect((ev as any).args).toEqual({ command: "echo hi" });
});

// ---- M10：sqlite 备份（VACUUM INTO 快照可查询）----
test("M10: backupToFile 产出一致性快照", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "omp-bak-"));
  const dest = path.join(dir, "snap.db");
  await backupToFile(dest);
  const { Database } = await import("bun:sqlite");
  const db = new Database(dest, { readonly: true });
  const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
  db.close();
  expect(tables.some((t) => t.name === "tenants")).toBeTrue();
});

// ---- M10：webhook 白名单 helper（空名单=放行；非法 URL 拒绝仅在非空名单下可达）----
test("M10: 空白名单默认放行（内网语义）", () => {
  expect(config.webhookHostAllowlist.length).toBe(0); // 测试环境未设置
  expect(isWebhookUrlAllowed("https://anywhere.example.com/hook")).toBeTrue();
});

// ---- M7：审批审计三事件（requested/timeout 直接驱动 SessionCtx）----
test("M7: requestApproval 超时 → 审计 requested+timeout", async () => {
  const fakeSession = { beginDispose() {}, dispose: async () => {} } as never;
  const ctx = new SessionCtx("sid-m7-audit", "m7-audit-user", "/tmp/does-not-matter", fakeSession);
  const d = await ctx.requestApproval("bash", { full: "Allow tool: bash" }, 1_100);
  expect(d.approved).toBeFalse();
  expect(d.reason).toContain("timeout");
  const { queryAudit } = await import("../src/core/tenant-store.ts");
  const requested = queryAudit({ user: "m7-audit-user", action: "approval.requested" });
  expect(requested.total).toBeGreaterThanOrEqual(1);
  const timedOut = queryAudit({ user: "m7-audit-user", action: "approval.timeout" });
  expect(timedOut.total).toBe(1);
  expect(JSON.stringify(timedOut.rows[0]?.detail_json)).toContain("bash");
});

// ---- 集成面：M7 approval 策略/grants + M8 agents/mcp（同一服务器）----
const PORT = 8821;
const BASE = `http://127.0.0.1:${PORT}`;
const TOK = "m789-token";
const h = (uid: string) => ({ authorization: `Bearer ${TOK}`, "content-type": "application/json", "x-user-id": uid });

const dataRoot = mkdtempSync(path.join(tmpdir(), "omp-m789-"));
let proc: Bun.Subprocess | null = null;

beforeAll(async () => {
  mkdirSync(path.join(dataRoot, "users", "m7u", "agent"), { recursive: true });
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

describe("M7：审批策略面", () => {
  test("默认：yolo + 空 policies", async () => {
    const g = await (await fetch(`${BASE}/api/me/approval`, { headers: h("m7u") })).json();
    expect(g.mode).toBe("yolo");
    expect(g.enabled).toBeFalse();
    expect(g.policies).toEqual({});
  });

  test("PUT mode=write → enabled=true；policies 往返", async () => {
    let r = await fetch(`${BASE}/api/me/approval`, { method: "PUT", headers: h("m7u"), body: '{"mode":"write"}' });
    expect(r.status).toBe(200);
    let g = await (await fetch(`${BASE}/api/me/approval`, { headers: h("m7u") })).json();
    expect(g.mode).toBe("write");
    expect(g.enabled).toBeTrue();
    r = await fetch(`${BASE}/api/me/approval`, {
      method: "PUT",
      headers: h("m7u"),
      body: '{"policies":{"bash":"prompt","read":"allow"}}',
    });
    expect(r.status).toBe(200);
    g = await (await fetch(`${BASE}/api/me/approval`, { headers: h("m7u") })).json();
    expect(g.policies).toEqual({ bash: "prompt", read: "allow" });
  });

  test("非法 mode / 非法 policy 值 / 非法键 → 400", async () => {
    expect(
      (await fetch(`${BASE}/api/me/approval`, { method: "PUT", headers: h("m7u"), body: '{"mode":"bogus"}' })).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${BASE}/api/me/approval`, {
          method: "PUT",
          headers: h("m7u"),
          body: '{"policies":{"bash":"maybe"}}',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${BASE}/api/me/approval`, {
          method: "PUT",
          headers: h("m7u"),
          body: '{"policies":{"bad key!":"allow"}}',
        })
      ).status,
    ).toBe(400);
    expect(
      (await fetch(`${BASE}/api/me/approval`, { method: "PUT", headers: h("m7u"), body: '{"policies":[]}' })).status,
    ).toBe(400);
  });

  test("向后兼容：enabled=false → yolo", async () => {
    const r = await fetch(`${BASE}/api/me/approval`, { method: "PUT", headers: h("m7u"), body: '{"enabled":false}' });
    expect(r.status).toBe(200);
    const g = await (await fetch(`${BASE}/api/me/approval`, { headers: h("m7u") })).json();
    expect(g.mode).toBe("yolo");
    expect(g.enabled).toBeFalse();
  });

  test("grants：空清单 → 无库 DELETE 404 → 种库可见 → 清空", async () => {
    let g = await (await fetch(`${BASE}/api/me/approval/grants`, { headers: h("m7u") })).json();
    expect(g.grants).toEqual([]);
    const del0 = await fetch(`${BASE}/api/me/approval/grants`, { method: "DELETE", headers: h("m7u") });
    expect(del0.status).toBe(404);
    // 种库（SDK grants 表结构：key/tool/approved_at）
    const { Database } = await import("bun:sqlite");
    const dbFile = path.join(dataRoot, "users", "m7u", "agent", "approval-cache.db");
    const db = new Database(dbFile);
    db.exec("CREATE TABLE IF NOT EXISTS grants (key TEXT PRIMARY KEY, tool TEXT NOT NULL, approved_at TEXT NOT NULL)");
    db.run("INSERT INTO grants (key, tool, approved_at) VALUES (?, ?, ?)", ["k1", "read", "2026-11-15T00:00:00Z"]);
    db.close();
    g = await (await fetch(`${BASE}/api/me/approval/grants`, { headers: h("m7u") })).json();
    expect(g.grants.length).toBe(1);
    expect(g.grants[0].tool).toBe("read");
    const del = await fetch(`${BASE}/api/me/approval/grants`, { method: "DELETE", headers: h("m7u") });
    expect(del.status).toBe(200);
    expect(((await del.json()) as any).removed).toBe(1);
    g = await (await fetch(`${BASE}/api/me/approval/grants`, { headers: h("m7u") })).json();
    expect(g.grants).toEqual([]);
  });
});

describe("M8：Agent Hub 收尾 + MCP reload", () => {
  test("未知 agent：chat/kill/revive 一致 404", async () => {
    const created = await (
      await fetch(`${BASE}/api/sessions`, { method: "POST", headers: h("m8u"), body: "{}" })
    ).json();
    const sid = created.id;
    for (const route of ["chat", "kill", "revive"]) {
      const r = await fetch(`${BASE}/api/sessions/${sid}/agents/no-agent/${route}`, {
        method: "POST",
        headers: h("m8u"),
        body: route === "chat" ? '{"text":"x"}' : undefined,
      });
      expect(r.status).toBe(404);
    }
  });

  test("revive 对未注册 agent → 404 NOT_FOUND（非 live 且无 transcript 也不复活）", async () => {
    const created = await (
      await fetch(`${BASE}/api/sessions`, { method: "POST", headers: h("m8u"), body: "{}" })
    ).json();
    const sid = created.id;
    // 无真实子代理：直接断言 revive 对任意未注册 agent 404；有 ref 无 sessionFile 的形状由 SDK 管理，
    // 这里覆盖 revive 的 404 通道（真实复活链路由 e2e-sdk-capabilities 的 task 子代理覆盖）。
    const r = await fetch(`${BASE}/api/sessions/${sid}/agents/whatever/revive`, { method: "POST", headers: h("m8u") });
    expect(r.status).toBe(404);
  });

  test("mcp/reload：不 live → 404；enableMcp=false → 409 MCP_DISABLED", async () => {
    expect((await fetch(`${BASE}/api/sessions/no-such/mcp/reload`, { method: "POST", headers: h("m8u") })).status).toBe(
      404,
    );
    const created = await (
      await fetch(`${BASE}/api/sessions`, { method: "POST", headers: h("m8u"), body: '{"enableMcp":false}' })
    ).json();
    const r = await fetch(`${BASE}/api/sessions/${created.id}/mcp/reload`, { method: "POST", headers: h("m8u") });
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).error.code).toBe("MCP_DISABLED");
  });

  test("mcp/reload：默认会话 → 200（无服务器时 lists 为空）", async () => {
    const created = await (
      await fetch(`${BASE}/api/sessions`, { method: "POST", headers: h("m8u"), body: "{}" })
    ).json();
    const r = await fetch(`${BASE}/api/sessions/${created.id}/mcp/reload`, { method: "POST", headers: h("m8u") });
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.ok).toBeTrue();
    expect(Array.isArray(body.connectedServers)).toBeTrue();
    expect(Array.isArray(body.tools)).toBeTrue();
  });
});

// ---- M10：webhook 白名单（独立服务器，注册期 403）----
describe("M10：webhook 白名单", () => {
  const PORT2 = 8822;
  const BASE2 = `http://127.0.0.1:${PORT2}`;
  const h2 = { authorization: "Bearer wl-token", "content-type": "application/json", "x-user-id": "wlu" };
  const dataRoot2 = mkdtempSync(path.join(tmpdir(), "omp-wl-"));
  let proc2: Bun.Subprocess | null = null;

  beforeAll(async () => {
    proc2 = Bun.spawn([process.execPath, "run", "src/index.ts"], {
      cwd: path.resolve(import.meta.dir, ".."),
      env: {
        ...process.env,
        GATEWAY_PORT: String(PORT2),
        GATEWAY_DATA_ROOT: dataRoot2,
        GATEWAY_SERVICE_TOKENS: "wl-token",
        GATEWAY_WEBHOOK_HOSTS_ALLOWLIST: "hooks.example.com",
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`${BASE2}/healthz`)).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 300));
    }
  }, 25_000);

  afterAll(() => {
    if (!proc2) return;
    try {
      proc2.kill();
    } catch {}
    try {
      Bun.spawnSync(["taskkill", "/F", "/T", "/PID", String(proc2.pid)]);
    } catch {}
  });

  test("非白名单 host 注册 → 403；白名单内 → 201", async () => {
    const bad = await fetch(`${BASE2}/internal/users/wlu/webhooks`, {
      method: "POST",
      headers: h2,
      body: '{"url":"https://evil.example.net/hook"}',
    });
    expect(bad.status).toBe(403);
    const good = await fetch(`${BASE2}/internal/users/wlu/webhooks`, {
      method: "POST",
      headers: h2,
      body: '{"url":"https://hooks.example.com/hook"}',
    });
    expect(good.status).toBe(201);
  });
});

// 防止未使用导入告警（seed 写文件路径引用）
void writeFileSync;
