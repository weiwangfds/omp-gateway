/**
 * 审批流 e2e（M6，真实模型）：bash 工具调用 → tool.confirm_required（SSE）
 * → POST /approvals/:id 放行（工具真实执行）或拒绝（被 block，模型收到拒绝理由）。
 * 凭据来自本机 ZCode 配置（无则跳过）。~4 次模型调用。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const TOK = "approval-token";
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

const dataRoot = mkdtempSync(path.join(tmpdir(), "omp-gw-appr-"));
let proc: Bun.Subprocess | null = null;
const stderrTail: string[] = [];
const key = readMiniMaxKey();
const run = key !== null;

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
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return cond();
};

beforeAll(async () => {
  if (!run) return;
  mkdirSync(path.join(dataRoot, "users", "approver", "agent"), { recursive: true });
  proc = Bun.spawn([process.execPath, "run", "src/index.ts"], {
    cwd: path.resolve(import.meta.dir, ".."),
    env: { ...process.env, GATEWAY_PORT: String(PORT), GATEWAY_DATA_ROOT: dataRoot, GATEWAY_SERVICE_TOKENS: TOK },
    stdout: "pipe",
    stderr: "pipe",
  });
  void (async () => {
    try {
      const reader = proc!.stderr!.getReader();
      const dec = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        stderrTail.push(dec.decode(value, { stream: true }));
        if (stderrTail.length > 300) stderrTail.shift();
      }
    } catch {}
  })();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  await fetch(`${BASE}/api/me/models/config`, {
    method: "PUT",
    headers: h("approver"),
    body: "providers:\n  minimax:\n    baseUrl: https://api.minimax.cn/v1\n    api: openai-completions\n    models:\n      - id: MiniMax-M3.1-Flash\n        name: MiniMax M3.1 Flash\n",
  });
  await fetch(`${BASE}/api/me/models/credentials`, {
    method: "POST",
    headers: h("approver"),
    body: JSON.stringify({ provider: "minimax", apiKey: key }),
  });
  // 用户级审批开关（M6）：写入该用户 config 存储（tools.approvalMode=always-ask）
  await fetch(`${BASE}/api/me/approval`, { method: "PUT", headers: h("approver"), body: '{"enabled":true}' });
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

describe.skipIf(!run)("审批流 e2e（真实模型 + bash 工具）", () => {
  test("放行路径：confirm_required → approve → bash 真实执行（结果含标记）", async () => {
    const created = await (
      await fetch(`${BASE}/api/sessions`, {
        method: "POST",
        headers: h("approver"),
        body: JSON.stringify({ title: "appr-yes", model: { provider: "minimax", modelId: "MiniMax-M3.1-Flash" } }),
      })
    ).json();
    const sid = created.id;
    expect(created.warnings).toEqual([]);

    const col = startCollector("approver", sid);
    await new Promise((r) => setTimeout(r, 500));
    const pr = await fetch(`${BASE}/api/sessions/${sid}/prompt`, {
      method: "POST",
      headers: h("approver"),
      body: JSON.stringify({ text: "Use bash to run exactly this command: echo APPROVAL-OK. Nothing else." }),
    });
    expect(pr.status).toBe(202);

    // 等审批请求（SSE confirm_required）
    const asked = await waitFor(() => col.frames.some((f) => f.event === "tool.confirm_required"), 120_000);
    if (!asked) {
      console.error(
        "DIAG events:",
        col.frames
          .map((f) => `${f.event}:${JSON.stringify(f.data).slice(0, 120)}`)
          .join("\n")
          .slice(0, 2500),
      );
      console.error("DIAG stderr:", stderrTail.join("").slice(-2000));
    }
    expect(asked).toBeTrue();
    const req = col.frames.find((f) => f.event === "tool.confirm_required")!;
    // tool 字段=请求方 kind（SDK ExtensionApprovalPrompt 只有 full/compact 文本，无工具名字段）；
    // 真实工具名在审批 prompt 文本首部（SDK approvalHeader）
    expect(req.data.tool).toBe("tool-approval");
    expect(String(req.data.args?.full ?? "")).toContain("bash");
    // pending 清单可见
    const pending = await (await fetch(`${BASE}/api/sessions/${sid}/approvals`, { headers: h("approver") })).json();
    if (pending.approvals.length === 0) {
      console.error("DIAG1 pending:", JSON.stringify(pending).slice(0, 400));
      console.error(
        "DIAG1 confirm frames:",
        JSON.stringify(col.frames.filter((f) => f.event === "tool.confirm_required").map((f) => f.data)).slice(0, 800),
      );
      console.error("DIAG1 stderr:", stderrTail.join("").slice(-1200));
    }
    expect(pending.approvals.length).toBeGreaterThan(0);
    // 放行
    const approve = await fetch(`${BASE}/api/sessions/${sid}/approvals/${req.data.approvalId}`, {
      method: "POST",
      headers: h("approver"),
      body: '{"approve":true}',
    });
    expect(approve.status).toBe(200);

    const done = await waitFor(
      () => col.frames.some((f) => f.event === "turn.completed" && f.data.isTerminal),
      180_000,
    );
    expect(done).toBeTrue();
    const echoResult = col.frames.find(
      (f) => f.event === "tool.completed" && JSON.stringify(f.data.result ?? {}).includes("APPROVAL-OK"),
    );
    expect(echoResult).toBeTruthy(); // bash 真实执行
    col.stop();
  }, 300_000);

  test("拒绝路径：confirm_required → reject → 工具被 block（目标输出不出现）", async () => {
    const created = await (
      await fetch(`${BASE}/api/sessions`, {
        method: "POST",
        headers: h("approver"),
        body: JSON.stringify({ title: "appr-no", model: { provider: "minimax", modelId: "MiniMax-M3.1-Flash" } }),
      })
    ).json();
    const sid = created.id;
    const col = startCollector("approver", sid);
    await new Promise((r) => setTimeout(r, 500));
    const pr = await fetch(`${BASE}/api/sessions/${sid}/prompt`, {
      method: "POST",
      headers: h("approver"),
      body: JSON.stringify({
        text: "Use bash to run exactly this command: echo SHOULD-NOT-RUN. If it is blocked, reply with just: BLOCKED. Do not retry more than once.",
      }),
    });
    expect(pr.status).toBe(202);

    const asked = await waitFor(() => col.frames.some((f) => f.event === "tool.confirm_required"), 120_000);
    if (!asked) {
      console.error(
        "DIAG2 events:",
        col.frames
          .map((f) => `${f.event}:${JSON.stringify(f.data).slice(0, 120)}`)
          .join("\n")
          .slice(0, 2500),
      );
    }
    expect(asked).toBeTrue();
    const req = col.frames.find((f) => f.event === "tool.confirm_required")!;
    // 决定前先看 pending 清单（诊断 404 归因：not found vs not live）
    const pend = await (await fetch(`${BASE}/api/sessions/${sid}/approvals`, { headers: h("approver") })).json();
    console.error("DIAG2 pending:", JSON.stringify(pend).slice(0, 400));
    const rej = await fetch(`${BASE}/api/sessions/${sid}/approvals/${req.data.approvalId}`, {
      method: "POST",
      headers: h("approver"),
      body: '{"approve":false,"reason":"denied by policy"}',
    });
    if (rej.status !== 200) {
      console.error(
        "DIAG2 reject body:",
        JSON.stringify(await rej.json().catch(() => null)),
        "approvalId=",
        req.data.approvalId,
      );
    }
    expect(rej.status).toBe(200);

    const done = await waitFor(
      () => col.frames.some((f) => f.event === "turn.completed" && f.data.isTerminal),
      180_000,
    );
    expect(done).toBeTrue();
    // 被拒的工具调用不应产生 SHOULD-NOT-RUN 输出
    const leaked = col.frames.some(
      (f) => f.event === "tool.completed" && JSON.stringify(f.data.result ?? {}).includes("SHOULD-NOT-RUN"),
    );
    expect(leaked).toBeFalse();
    // 重复决定 → 404
    expect(
      (
        await fetch(`${BASE}/api/sessions/${sid}/approvals/${req.data.approvalId}`, {
          method: "POST",
          headers: h("approver"),
          body: '{"approve":true}',
        })
      ).status,
    ).toBe(404);
    col.stop();
  }, 300_000);
});
