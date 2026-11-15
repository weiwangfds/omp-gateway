/**
 * 真实模型 e2e（MiniMax）：prompt→SSE 流式→切模型→并发两会话。
 * 凭据来自本机 ZCode 配置（临时测试用，测试后应轮换）；无凭据时整组跳过。
 * 消耗极小（≤4 次 max_tokens 有限的小请求）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 8792;
const BASE = `http://127.0.0.1:${PORT}`;
const TOK = "e2e-token";
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

const dataRoot = mkdtempSync(path.join(tmpdir(), "omp-gw-e2e-"));
let proc: Bun.Subprocess | null = null;
const key = readMiniMaxKey();
const runE2E = key !== null;
/** 已产生真实 turn 的会话（供用量断言）。 */
const usedSessions: string[] = [];

beforeAll(async () => {
  if (!runE2E) return;
  mkdirSync(path.join(dataRoot, "users", "e2e-user", "agent"), { recursive: true });
  proc = Bun.spawn([process.execPath, "run", "src/index.ts"], {
    cwd: path.resolve(import.meta.dir, ".."),
    // maxGlobal=1：并发双 prompt 变为排队串行——同时验证全局 streaming 上限 + 排队（M2）
    env: {
      ...process.env,
      GATEWAY_PORT: String(PORT),
      GATEWAY_DATA_ROOT: dataRoot,
      GATEWAY_SERVICE_TOKENS: TOK,
      GATEWAY_MAX_GLOBAL_STREAMING: "1",
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
  // Python 视角全流程：配置经 API 写入（不再直写文件），凭据经 credentials 注入
  const cfg = await fetch(`${BASE}/api/me/models/config`, {
    method: "PUT",
    headers: h("e2e-user"),
    body: [
      "providers:",
      "  minimax:",
      "    baseUrl: https://api.minimax.cn/v1",
      "    api: openai-completions",
      "    models:",
      "      - id: MiniMax-M3.1-Flash",
      "        name: MiniMax M3.1 Flash",
      "      - id: MiniMax-M3",
      "        name: MiniMax M3",
    ].join("\n"),
  });
  if (cfg.status !== 200) throw new Error(`models config PUT failed: ${cfg.status}`);
  const cred = await fetch(`${BASE}/api/me/models/credentials`, {
    method: "POST",
    headers: h("e2e-user"),
    body: JSON.stringify({ provider: "minimax", apiKey: key }),
  });
  if (cred.status !== 200) throw new Error(`credentials POST failed: ${cred.status}`);
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

/** 后台 SSE 收集器：持续收集直到 stop。 */
function startCollector(uid: string, sid: string, extraHeaders: Record<string, string> = {}) {
  const frames: Array<{ event: string; data: any }> = [];
  const ac = new AbortController();
  const done = (async () => {
    try {
      const res = await fetch(`${BASE}/api/sessions/${sid}/events`, {
        headers: { ...h(uid), ...extraHeaders },
        signal: ac.signal,
      });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done: d, value } = await reader.read();
        if (d) break;
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
  return { frames, stop: () => ac.abort(), done };
}

const waitFor = async (cond: () => boolean, ms: number, step = 300) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return await cond();
};

const create = async (body: Record<string, unknown>) => {
  const r = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: h("e2e-user"), body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

describe.skipIf(!runE2E)("e2e: MiniMax real model", () => {
  test("prompt → SSE text.delta 流式 → message.completed(usage) → turn.completed(usage)", async () => {
    const created = await create({
      title: "e2e-stream",
      model: { provider: "minimax", modelId: "MiniMax-M3.1-Flash" },
    });
    expect(created.status).toBe(201);
    expect(created.body.warnings).toEqual([]);
    const sid = created.body.id as string;

    const col = startCollector("e2e-user", sid);
    await new Promise((r) => setTimeout(r, 500)); // 先订阅后 prompt（契约时序）
    const pr = await fetch(`${BASE}/api/sessions/${sid}/prompt`, {
      method: "POST",
      headers: h("e2e-user"),
      body: '{"text":"Reply with exactly this token and nothing else: OK-M1-E2E"}',
    });
    expect(pr.status).toBe(202);

    const ok = await waitFor(() => col.frames.some((f) => f.event === "turn.completed" && f.data.isTerminal), 90_000);
    col.stop();
    expect(ok).toBeTrue();

    const deltas = col.frames
      .filter((f) => f.event === "text.delta")
      .map((f) => f.data.delta as string)
      .join("");
    expect(deltas).toContain("OK-M1-E2E");

    const msgEnd = col.frames.find((f) => f.event === "message.completed" && f.data.role === "assistant");
    expect(msgEnd).toBeTruthy();
    expect(msgEnd!.data.provider).toBe("minimax");
    expect(msgEnd!.data.modelId).toBe("MiniMax-M3.1-Flash");
    expect(msgEnd!.data.usage.input).toBeGreaterThan(0);

    const turn = col.frames.find((f) => f.event === "turn.completed")!;
    expect(turn.data.isTerminal).toBe(true);
    expect(turn.data.usage?.input).toBeGreaterThan(0); // M1.1：turn_end usage 充盈

    // 状态迁移帧齐备：streaming 开、终态关
    expect(col.frames.some((f) => f.event === "session.status" && f.data.status === "streaming")).toBeTrue();
    usedSessions.push(sid);
  }, 120_000);

  test("会话内切模型：setModel → model.changed（从 session.model 补齐）→ 新模型可用", async () => {
    const created = await create({
      title: "e2e-switch",
      model: { provider: "minimax", modelId: "MiniMax-M3.1-Flash" },
    });
    const sid = created.body.id as string;
    const col = startCollector("e2e-user", sid);
    await new Promise((r) => setTimeout(r, 500));

    const sw = await fetch(`${BASE}/api/sessions/${sid}/model`, {
      method: "POST",
      headers: h("e2e-user"),
      body: '{"provider":"minimax","modelId":"MiniMax-M3"}',
    });
    expect(sw.status).toBe(200);
    await waitFor(() => col.frames.some((f) => f.event === "model.changed"), 15_000);
    col.stop();
    const changed = col.frames.find((f) => f.event === "model.changed")!;
    expect(changed.data).toEqual({
      type: "model.changed",
      provider: "minimax",
      modelId: "MiniMax-M3",
      seq: expect.any(Number),
      ts: expect.any(Number),
    });

    // 不存在的模型 → 404
    const bad = await fetch(`${BASE}/api/sessions/${sid}/model`, {
      method: "POST",
      headers: h("e2e-user"),
      body: '{"provider":"minimax","modelId":"Not-Exist"}',
    });
    expect(bad.status).toBe(404);
  }, 60_000);

  test("全局并发=1：同用户两会话 prompt 排队串行执行，流式窗口不重叠", async () => {
    const s1 = (await create({ title: "conc-1", model: { provider: "minimax", modelId: "MiniMax-M3.1-Flash" } })).body
      .id as string;
    const s2 = (await create({ title: "conc-2", model: { provider: "minimax", modelId: "MiniMax-M3.1-Flash" } })).body
      .id as string;
    const c1 = startCollector("e2e-user", s1);
    const c2 = startCollector("e2e-user", s2);
    await new Promise((r) => setTimeout(r, 500));

    const [p1, p2] = await Promise.all([
      fetch(`${BASE}/api/sessions/${s1}/prompt`, {
        method: "POST",
        headers: h("e2e-user"),
        body: '{"text":"Reply with exactly: CONC-A-OK"}',
      }),
      fetch(`${BASE}/api/sessions/${s2}/prompt`, {
        method: "POST",
        headers: h("e2e-user"),
        body: '{"text":"Reply with exactly: CONC-B-OK"}',
      }),
    ]);
    expect(p1.status).toBe(202);
    expect(p2.status).toBe(202);

    const done = await waitFor(
      () =>
        c1.frames.some((f) => f.event === "turn.completed" && f.data.isTerminal) &&
        c2.frames.some((f) => f.event === "turn.completed" && f.data.isTerminal),
      120_000,
    );
    c1.stop();
    c2.stop();
    expect(done).toBeTrue();
    expect(
      c1.frames
        .filter((f) => f.event === "text.delta")
        .map((f) => f.data.delta)
        .join(""),
    ).toContain("CONC-A-OK");
    expect(
      c2.frames
        .filter((f) => f.event === "text.delta")
        .map((f) => f.data.delta)
        .join(""),
    ).toContain("CONC-B-OK");

    // M2 核心断言：全局上限=1 ⇒ 两个会话的流式窗口不重叠（排队生效）
    const windowOf = (frames: typeof c1.frames) => {
      const start = frames.find((f) => f.event === "session.status" && f.data.status === "streaming")?.data.ts;
      const end = frames.find((f) => f.event === "turn.completed" && f.data.isTerminal)?.data.ts;
      return { start: start as number, end: end as number };
    };
    const w1 = windowOf(c1.frames);
    const w2 = windowOf(c2.frames);
    expect(w1.start).toBeTruthy();
    expect(w2.start).toBeTruthy();
    const overlap = Math.max(w1.start, w2.start) < Math.min(w1.end, w2.end);
    expect(overlap).toBeFalse();
    // 第二个 prompt 虽被排队，HTTP 层仍是 202 admission（排队而非拒绝）
    usedSessions.push(s1, s2);
  }, 150_000);

  test("用量统计落库与聚合：session 汇总 / me 分桶 / metrics 计数器", async () => {
    expect(usedSessions.length).toBeGreaterThanOrEqual(3);
    const sid = usedSessions[0];
    const su = await (await fetch(`${BASE}/api/sessions/${sid}/usage`, { headers: h("e2e-user") })).json();
    expect(su.summary.turns).toBeGreaterThanOrEqual(1);
    expect(su.summary.inputTokens).toBeGreaterThan(0);
    expect(su.summary.outputTokens).toBeGreaterThan(0);
    expect(su.summary.costUsd).toBeGreaterThan(0);
    expect(su.turns.length).toBeGreaterThanOrEqual(1);
    expect(su.turns[0].model_provider).toBe("minimax");
    expect(su.turns[0].input_tokens).toBeGreaterThan(0);

    const me = await (await fetch(`${BASE}/api/me/usage?group=model`, { headers: h("e2e-user") })).json();
    expect(me.totals.turns).toBeGreaterThanOrEqual(3);
    expect(me.totals.inputTokens).toBeGreaterThan(0);
    const minimaxBucket = me.buckets.find((b: any) => b.key?.startsWith("minimax/"));
    expect(minimaxBucket).toBeTruthy();

    const meDay = await (await fetch(`${BASE}/api/me/usage?group=day`, { headers: h("e2e-user") })).json();
    expect(meDay.buckets[0].key).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const internal = await (
      await fetch(`${BASE}/internal/users/e2e-user/usage?group=day`, { headers: h("admin") })
    ).json();
    expect(internal.buckets.length).toBeGreaterThanOrEqual(1);

    const metrics = await (await fetch(`${BASE}/metrics`)).text();
    const input = Number(metrics.match(/omp_gateway_usage_input_tokens_total (\d+)/)![1]);
    expect(input).toBeGreaterThan(0);
    expect(metrics).toMatch(/omp_gateway_usage_cost_usd_total 0\.0/);
  }, 30_000);

  test("workspace 文件树与读写在真实会话上可用（含 .omp 网关合成文件可见）", async () => {
    const sid = usedSessions[0];
    const tree = await (await fetch(`${BASE}/api/sessions/${sid}/tree`, { headers: h("e2e-user") })).json();
    expect(tree.entries.some((e: any) => e.name === ".omp")).toBeTrue();
    const mcp = await (
      await fetch(`${BASE}/api/sessions/${sid}/file?path=.omp/mcp.json`, { headers: h("e2e-user") })
    ).json();
    expect(JSON.parse(mcp.content)._managedBy).toBe("omp-gateway");
  }, 30_000);

  test("M4 快照全链路（真实 JSONL）：手动快照 → fork 恢复继承历史 → rollback 换文件 + pre_restore", async () => {
    const sid = usedSessions[0];

    // 1. 手动快照：真实 transcript → entry_count > 0
    const snap = await (
      await fetch(`${BASE}/api/sessions/${sid}/snapshots`, {
        method: "POST",
        headers: h("e2e-user"),
        body: '{"name":"m4-check"}',
      })
    ).json();
    expect(snap.entry_count).toBeGreaterThan(0);
    expect(snap.file_path).toContain("snapshots");

    // 2. 列表/单查
    const list = await (await fetch(`${BASE}/api/sessions/${sid}/snapshots`, { headers: h("e2e-user") })).json();
    expect(list.snapshots.some((s: any) => s.id === snap.id)).toBeTrue();
    expect(
      (await (await fetch(`${BASE}/api/sessions/${sid}/snapshots/${snap.id}`, { headers: h("e2e-user") })).json()).id,
    ).toBe(snap.id);

    // 3. restore fork：新会话继承全部历史 + 自己的 workspace
    const fk = await (
      await fetch(`${BASE}/api/sessions/${sid}/snapshots/${snap.id}/restore`, {
        method: "POST",
        headers: h("e2e-user"),
        body: '{"mode":"fork"}',
      })
    ).json();
    expect(fk.mode).toBe("fork");
    expect(fk.parentId).toBe(sid);
    const forkMsgs = await (await fetch(`${BASE}/api/sessions/${fk.id}/messages`, { headers: h("e2e-user") })).json();
    const srcMsgs = await (await fetch(`${BASE}/api/sessions/${sid}/messages`, { headers: h("e2e-user") })).json();
    expect(forkMsgs.total).toBe(srcMsgs.total);

    // 4. restore rollback：同 sid 换文件 + 自动 pre_restore 快照
    const beforeFile = (await (await fetch(`${BASE}/api/sessions/${sid}`, { headers: h("e2e-user") })).json())
      .session_file;
    const rb = await (
      await fetch(`${BASE}/api/sessions/${sid}/snapshots/${snap.id}/restore`, {
        method: "POST",
        headers: h("e2e-user"),
        body: '{"mode":"rollback"}',
      })
    ).json();
    expect(rb.mode).toBe("rollback");
    expect(rb.preRestoreSnapshotId).toBeTruthy();
    const after = await (await fetch(`${BASE}/api/sessions/${sid}`, { headers: h("e2e-user") })).json();
    expect(after.session_file).not.toBe(beforeFile); // 已换到快照内容的新文件
    const rbList = await (await fetch(`${BASE}/api/sessions/${sid}/snapshots`, { headers: h("e2e-user") })).json();
    expect(rbList.snapshots.some((s: any) => s.trigger === "pre_restore")).toBeTrue();
    // 回滚后的会话仍可读历史（快照点内容）
    const rbMsgs = await (await fetch(`${BASE}/api/sessions/${sid}/messages`, { headers: h("e2e-user") })).json();
    expect(rbMsgs.total).toBeGreaterThan(0);

    // 5. 删除快照
    const del = await fetch(`${BASE}/api/sessions/${sid}/snapshots/${snap.id}`, {
      method: "DELETE",
      headers: h("e2e-user"),
    });
    expect(del.status).toBe(200);
    expect((await fetch(`${BASE}/api/sessions/${sid}/snapshots/${snap.id}`, { headers: h("e2e-user") })).status).toBe(
      404,
    );
  }, 60_000);

  test("SDK 桥（真实模型）：state 含模型与消息数、thinking 往返、messages 历史、fork 继承对话", async () => {
    const sid = usedSessions[0];

    // state：模型/思考等级/工具/队列
    const st = await (await fetch(`${BASE}/api/sessions/${sid}/state`, { headers: h("e2e-user") })).json();
    expect(st.model).toEqual({ provider: "minimax", modelId: expect.any(String) });
    expect(typeof st.thinkingLevel).toBe("string");
    expect(st.messageCount).toBeGreaterThan(0);
    expect(st.tools.all).toContain("bash");

    // thinking：GET → PUT low → GET 确认
    const t0 = await (await fetch(`${BASE}/api/sessions/${sid}/thinking`, { headers: h("e2e-user") })).json();
    expect(t0.available.length).toBeGreaterThan(0); // M3.1 为 reasoning 模型
    const put = await fetch(`${BASE}/api/sessions/${sid}/thinking`, {
      method: "PUT",
      headers: h("e2e-user"),
      body: '{"level":"low"}',
    });
    expect(put.status).toBe(200);
    expect(
      (await (await fetch(`${BASE}/api/sessions/${sid}/thinking`, { headers: h("e2e-user") })).json()).current,
    ).toBe("low");

    // messages：用户消息与助手回复都在
    const msgs = await (await fetch(`${BASE}/api/sessions/${sid}/messages`, { headers: h("e2e-user") })).json();
    expect(msgs.total).toBeGreaterThan(0);
    const roles = msgs.messages.map((m: any) => m.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");

    // fork：新会话继承对话历史（真实内容分叉），且有自己的 workspace（拷贝源）
    const fk = await fetch(`${BASE}/api/sessions/${sid}/fork`, {
      method: "POST",
      headers: h("e2e-user"),
      body: '{"title":"e2e-fork"}',
    });
    expect(fk.status).toBe(201);
    const { id: forkSid, parentId, workspaceId } = await fk.json();
    expect(parentId).toBe(sid);
    expect(workspaceId).toBe(forkSid);
    const forkMsgs = await (await fetch(`${BASE}/api/sessions/${forkSid}/messages`, { headers: h("e2e-user") })).json();
    expect(forkMsgs.total).toBe(msgs.total); // 分叉点 = 当前全部历史
    const detail = await (await fetch(`${BASE}/api/sessions/${forkSid}`, { headers: h("e2e-user") })).json();
    expect(detail.parent_id).toBe(sid);
    // workspace 拷贝：.omp 合成文件随源 workspace 复制
    const forkMcp = await (
      await fetch(`${BASE}/api/sessions/${forkSid}/file?path=.omp/mcp.json`, { headers: h("e2e-user") })
    ).json();
    expect(JSON.parse(forkMcp.content)._managedBy).toBe("omp-gateway");
  }, 60_000);
});
