/**
 * SDK 能力实测（真实会话逐项驱动）：自定义 skill 发现 → task 子代理（名册/事件/transcript/chat/kill）
 * → entries（真实 entryId）→ fork{entryId} 条目级分叉 → 真实 compact → handoff → export/dump。
 * 凭据来自本机 ZCode 配置（无则跳过）。~6 次模型调用。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 8795;
const BASE = `http://127.0.0.1:${PORT}`;
const TOK = "sdkcap-token";
const UID = "sdkcap-user";
const H = { authorization: `Bearer ${TOK}`, "content-type": "application/json" };
const h = () => ({ ...H, "x-user-id": UID });

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

const dataRoot = mkdtempSync(path.join(tmpdir(), "omp-gw-sdkcap-"));
let proc: Bun.Subprocess | null = null;
const key = readMiniMaxKey();
const run = key !== null;
let sid = "";

beforeAll(async () => {
  if (!run) return;
  // 自定义 skill：用户级 agentDir/skills/greeting/SKILL.md（native provider，需 description）
  const skillDir = path.join(dataRoot, "users", UID, "agent", "skills", "greeting");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: greeting\ndescription: Replies with a friendly greeting when the user asks for one\n---\n\nSay hello warmly.\n",
  );
  proc = Bun.spawn([process.execPath, "run", "src/index.ts"], {
    cwd: path.resolve(import.meta.dir, ".."),
    env: { ...process.env, GATEWAY_PORT: String(PORT), GATEWAY_DATA_ROOT: dataRoot, GATEWAY_SERVICE_TOKENS: TOK },
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
  await fetch(`${BASE}/api/me/models/config`, {
    method: "PUT",
    headers: h(),
    body: "providers:\n  minimax:\n    baseUrl: https://api.minimax.cn/v1\n    api: openai-completions\n    models:\n      - id: MiniMax-M3.1-Flash\n        name: MiniMax M3.1 Flash\n",
  });
  await fetch(`${BASE}/api/me/models/credentials`, {
    method: "POST",
    headers: h(),
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

function startCollector(sessionId: string) {
  const frames: Array<{ event: string; data: any }> = [];
  const ac = new AbortController();
  void (async () => {
    try {
      const res = await fetch(`${BASE}/api/sessions/${sessionId}/events`, { headers: h(), signal: ac.signal });
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

const _promptAndWait = async (text: string, ms = 180_000) => {
  const col = startCollector(sid);
  await new Promise((r) => setTimeout(r, 500));
  const pr = await fetch(`${BASE}/api/sessions/${sid}/prompt`, {
    method: "POST",
    headers: h(),
    body: JSON.stringify({ text }),
  });
  expect(pr.status).toBe(202);
  const done = await waitFor(() => col.frames.some((f) => f.event === "turn.completed" && f.data.isTerminal), ms);
  col.stop();
  expect(done).toBeTrue();
  return col.frames;
};

describe.skipIf(!run)("SDK 能力实测（真实会话）", () => {
  test("① 建会话 + 自定义 skill 出现在发现列表", async () => {
    const r = await (
      await fetch(`${BASE}/api/sessions`, {
        method: "POST",
        headers: h(),
        body: JSON.stringify({ title: "sdkcap", model: { provider: "minimax", modelId: "MiniMax-M3.1-Flash" } }),
      })
    ).json();
    sid = r.id;
    const skills = await (await fetch(`${BASE}/api/sessions/${sid}/skills`, { headers: h() })).json();
    const names = (skills.skills ?? []).map((s: any) => s.name);
    if (!names.includes("greeting")) console.error("DIAG① skills:", JSON.stringify(skills).slice(0, 600));
    expect(names).toContain("greeting");
  }, 60_000);

  test("② task 子代理：spawn（模型行为相关，条件断言）→ 名册不含 Main → hub 端点结构", async () => {
    const col = startCollector(sid);
    await new Promise((r) => setTimeout(r, 500));
    const pr = await fetch(`${BASE}/api/sessions/${sid}/prompt`, {
      method: "POST",
      headers: h(),
      body: JSON.stringify({
        text: "You must call the task tool now to launch a subagent with the prompt 'Reply with the single word PONG'. Wait for its result, then reply with just: SPAWNED",
      }),
    });
    expect(pr.status).toBe(202);
    // 子代理是否真的被派生取决于模型的工具调用行为——90s 内未出现则跳过 hub 深断言（记 warn）
    // 注意：子代理完成即注销（瞬态），必须在轮询时当场捕获
    let captured: any = null;
    const spawned = await waitFor(async () => {
      const roster = await (await fetch(`${BASE}/api/sessions/${sid}/agents`, { headers: h() })).json();
      if (roster.agents.length > 0) {
        captured = roster.agents[0];
        return true;
      }
      return false;
    }, 90_000);
    // 名册永不泄漏主代理（MAIN_AGENT_ID 过滤）
    const roster = await (await fetch(`${BASE}/api/sessions/${sid}/agents`, { headers: h() })).json();
    expect(roster.agents.every((a: any) => a.id !== "Main")).toBeTrue();
    if (spawned && captured) {
      expect(captured.id).toBeTruthy();
      expect(col.frames.some((f) => f.event === "agents.changed")).toBeTrue();
      // transcript：子代理可能在断言间隙完成注销 → 404 亦为合法瞬态
      const tr = await fetch(`${BASE}/api/sessions/${sid}/agents/${captured.id}/transcript`, { headers: h() });
      expect([200, 404]).toContain(tr.status);
      const chat = await fetch(`${BASE}/api/sessions/${sid}/agents/${captured.id}/chat`, {
        method: "POST",
        headers: h(),
        body: '{"text":"Reply with the single word PONG2"}',
      });
      expect([202, 404, 409]).toContain(chat.status);
      const kill = await (
        await fetch(`${BASE}/api/sessions/${sid}/agents/${captured.id}/kill`, { method: "POST", headers: h() })
      ).json();
      expect([200, 404]).toContain(kill.status);
    } else {
      console.warn("② model did not spawn a subagent (tool-choice behavior) — hub deep assertions skipped");
      await fetch(`${BASE}/api/sessions/${sid}/abort`, { method: "POST", headers: h() });
    }
    // 主 turn 收尾（终态或非终态均可——清场）
    await waitFor(() => col.frames.some((f) => f.event === "turn.completed"), 180_000);
    if (!col.frames.some((f) => f.event === "turn.completed" && f.data.isTerminal)) {
      await fetch(`${BASE}/api/sessions/${sid}/abort`, { method: "POST", headers: h() });
      await waitFor(() => col.frames.some((f) => f.event === "turn.completed"), 60_000);
    }
    col.stop();
  }, 420_000);

  test("③ entries：真实 entryId → fork{entryId} 条目级分叉（历史为前缀）", async () => {
    const entries = await (await fetch(`${BASE}/api/sessions/${sid}/entries`, { headers: h() })).json();
    expect(entries.total).toBeGreaterThan(0);
    const userEntry = entries.entries.find((e: any) => e.type === "message" && e.role === "user");
    expect(userEntry).toBeTruthy();
    expect(userEntry.preview).toBeTruthy();
    const srcMsgs = await (await fetch(`${BASE}/api/sessions/${sid}/messages`, { headers: h() })).json();
    const fk = await (
      await fetch(`${BASE}/api/sessions/${sid}/fork`, {
        method: "POST",
        headers: h(),
        body: JSON.stringify({ entryId: userEntry.id, title: "entry-fork" }),
      })
    ).json();
    expect(fk.parentId).toBe(sid);
    const forkMsgs = await (await fetch(`${BASE}/api/sessions/${fk.id}/messages`, { headers: h() })).json();
    expect(forkMsgs.total).toBeLessThanOrEqual(srcMsgs.total); // 前缀分叉
    expect(forkMsgs.total).toBeGreaterThan(0);
  }, 60_000);

  test("④ handoff：真实语义边界（小会话 → 409，与 compact 同族）", async () => {
    // handoff 需要足够上下文；小会话的真实边界 = 409 HANDOFF_FAILED（SDK 文案提 compaction）
    // （真实 handoff 需实质上下文，成本不适合 CI——端点与 SDK 错误路径已实证）
    const ho = await await fetch(`${BASE}/api/sessions/${sid}/handoff`, { method: "POST", headers: h(), body: "{}" });
    const body = await ho.json();
    if (body.result) {
      expect(body.result).toBeTruthy();
    } else {
      expect(body.error.code).toBe("HANDOFF_FAILED");
      expect(body.error.message).toMatch(/Nothing to hand off|already compacted|too small/i);
    }
  }, 120_000);

  test("⑤ compact：真实语义边界（小会话 → 409 Nothing to compact）", async () => {
    // 手动压缩需要足够上下文；探针级会话的真实边界 = 409 + "Nothing to compact"
    // （真实压缩需 100k+ token 上下文，成本不适合 CI——端点与 SDK 错误路径已实证）
    const cp = await await fetch(`${BASE}/api/sessions/${sid}/compact`, { method: "POST", headers: h(), body: "{}" });
    const body = await cp.json();
    if (body.result) {
      expect(body.result).toBeTruthy(); // 若上下文够大则真实压缩
    } else {
      expect(body.error.code).toBe("COMPACT_FAILED");
      expect(body.error.message).toMatch(/Nothing to compact|too small/i);
    }
  }, 120_000);

  test("⑥ export/dump：真实内容产物（viewer 壳 + base64 内嵌会话数据）", async () => {
    const ex = await (await fetch(`${BASE}/api/sessions/${sid}/export`, { method: "POST", headers: h() })).json();
    expect(ex.bytes).toBeGreaterThan(0);
    const html = await (
      await fetch(`${BASE}/api/sessions/${sid}/file?path=${encodeURIComponent(ex.path)}`, { headers: h() })
    ).json();
    // HTML 是 viewer 壳，会话数据 base64 内嵌在 <script id="session-data">——解码验证
    const m = html.content.match(/id="session-data"[^>]*>([A-Za-z0-9+/=]+)/);
    expect(m).toBeTruthy();
    const decoded = Buffer.from(m![1], "base64").toString("utf8");
    expect(decoded).toContain("sdkcap-user"); // cwd/路径入导出数据
    const dump = await (await fetch(`${BASE}/api/sessions/${sid}/dump`, { headers: h() })).json();
    expect(dump.text.length).toBeGreaterThan(0);
  }, 60_000);
});
