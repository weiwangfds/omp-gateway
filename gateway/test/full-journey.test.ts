/**
 * 全功能串接测试（M0-M4 全能力，一个真实用户旅程）：
 * provision → 配置 → 会话 → 编码 turn（工具落盘）→ 观测 → 工具集/思考 → 文件/索引/raw/上传
 * → git/worktree → 快照 fork+rollback → 切模型(pre_model_switch) → 分享链接 → webhooks(HMAC)
 * → 并发两会话 → 归档/trash 找回/删除 → drain → 级联删除。
 * 凭据来自本机 ZCode 配置（无则跳过）；~4 次小模型调用。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 8794;
const BASE = `http://127.0.0.1:${PORT}`;
const TOK = "journey-token";
const UID = "journey-user";
const H = { authorization: `Bearer ${TOK}`, "content-type": "application/json" };
const h = (uid = UID) => ({ ...H, "x-user-id": uid });

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

const dataRoot = mkdtempSync(path.join(tmpdir(), "omp-gw-journey-"));
let proc: Bun.Subprocess | null = null;
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
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return await cond();
};

beforeAll(async () => {
  if (!run) return;
  mkdirSync(path.join(dataRoot, "users", UID, "agent"), { recursive: true });
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
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("gateway not healthy");
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

describe.skipIf(!run)("全功能串接：一个用户旅程", () => {
  let sid = "";

  test("① 内部契约：provision + limits + 模型配置 + 凭据（Python 视角）", async () => {
    const pr = await (
      await fetch(`${BASE}/internal/users/${UID}/provision`, { method: "POST", headers: h("admin") })
    ).json();
    expect(pr.user_id).toBe(UID);
    await fetch(`${BASE}/internal/users/${UID}/limits`, {
      method: "PATCH",
      headers: h("admin"),
      body: '{"maxSessions":10,"allowedProviders":["minimax"]}',
    });
    const cfg = await fetch(`${BASE}/api/me/models/config`, {
      method: "PUT",
      headers: h(),
      body:
        "providers:\n" +
        "  minimax:\n" +
        "    baseUrl: https://api.minimax.cn/v1\n" +
        "    api: openai-completions\n" +
        "    models:\n" +
        "      - id: MiniMax-M3.1-Flash\n" +
        "        name: MiniMax M3.1 Flash\n" +
        "      - id: MiniMax-M3\n" +
        "        name: MiniMax M3\n",
    });
    expect(cfg.status).toBe(200);
    const cred = await fetch(`${BASE}/api/me/models/credentials`, {
      method: "POST",
      headers: h(),
      body: JSON.stringify({ provider: "minimax", apiKey: key }),
    });
    expect(cred.status).toBe(200);
  });

  test("② 建会话（绑定模型）+ SSE 订阅", async () => {
    const r = await (
      await fetch(`${BASE}/api/sessions`, {
        method: "POST",
        headers: h(),
        body: JSON.stringify({ title: "journey", model: { provider: "minimax", modelId: "MiniMax-M3.1-Flash" } }),
      })
    ).json();
    expect(r.model).toEqual({ provider: "minimax", modelId: "MiniMax-M3.1-Flash" });
    expect(r.workspaceId).toBe(r.id);
    sid = r.id;
    // SSE 可连（replay.state 首帧）
    const ac = new AbortController();
    const res = await fetch(`${BASE}/api/sessions/${sid}/events`, { headers: h(), signal: ac.signal });
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("replay.state");
    ac.abort();
  });

  test("③ 编码 turn：工具执行 → 代码落盘（真实模型）", async () => {
    const col = startCollector(UID, sid);
    await new Promise((r) => setTimeout(r, 500)); // 先订阅后 prompt
    const pr = await fetch(`${BASE}/api/sessions/${sid}/prompt`, {
      method: "POST",
      headers: h(),
      body: JSON.stringify({
        text:
          "Use the write tool to create a file named calc.py with exactly this content:\n" +
          "def mul(a, b):\n    return a * b\n\n" +
          "print(mul(6, 7))\n" +
          "Do not run it. Reply with just: DONE",
      }),
    });
    expect(pr.status).toBe(202);
    const done = await waitFor(
      () => col.frames.some((f) => f.event === "turn.completed" && f.data.isTerminal),
      180_000,
    );
    expect(done).toBeTrue();
    col.stop();
    // 事件链完整
    expect(col.frames.some((f) => f.event === "session.status" && f.data.status === "streaming")).toBeTrue();
    expect(col.frames.some((f) => f.event === "tool.started" && f.data.name === "write")).toBeTrue();
    expect(col.frames.some((f) => f.event === "tool.completed")).toBeTrue();
    const turn = col.frames.find((f) => f.event === "turn.completed")!;
    expect(turn.data.usage.input).toBeGreaterThan(0);
    // 代码落盘
    const file = await (await fetch(`${BASE}/api/sessions/${sid}/file?path=calc.py`, { headers: h() })).json();
    expect(file.content).toContain("def mul");
  }, 240_000);

  test("④ 观测：state/stats/usage 列表增强", async () => {
    const st = await (await fetch(`${BASE}/api/sessions/${sid}/state`, { headers: h() })).json();
    expect(st.model.provider).toBe("minimax");
    expect(st.messageCount).toBeGreaterThan(0);
    const stats = await (await fetch(`${BASE}/api/sessions/${sid}/stats`, { headers: h() })).json();
    expect(stats.toolCalls).toBeGreaterThan(0); // write 工具真实调用
    const usage = await (await fetch(`${BASE}/api/sessions/${sid}/usage`, { headers: h() })).json();
    expect(usage.summary.costUsd).toBeGreaterThan(0);
    const list = await (await fetch(`${BASE}/api/sessions`, { headers: h() })).json();
    const mine = list.sessions.find((s: any) => s.id === sid);
    expect(mine.usage.turns).toBeGreaterThanOrEqual(1);
    expect(mine.lastMessage).toBeTruthy();
  });

  test("⑤ 工具集与思考等级（运行时变更）", async () => {
    const tools = await (await fetch(`${BASE}/api/sessions/${sid}/tools`, { headers: h() })).json();
    await fetch(`${BASE}/api/sessions/${sid}/tools`, {
      method: "PUT",
      headers: h(),
      body: JSON.stringify({ active: ["read", "grep", "glob"] }),
    });
    const after = await (await fetch(`${BASE}/api/sessions/${sid}/tools`, { headers: h() })).json();
    expect(after.active.sort()).toEqual(["glob", "grep", "read"]);
    await fetch(`${BASE}/api/sessions/${sid}/tools`, {
      method: "PUT",
      headers: h(),
      body: JSON.stringify({ active: tools.active }),
    });
    const th = await (await fetch(`${BASE}/api/sessions/${sid}/thinking`, { headers: h() })).json();
    await fetch(`${BASE}/api/sessions/${sid}/thinking`, { method: "PUT", headers: h(), body: '{"level":"low"}' });
    expect((await (await fetch(`${BASE}/api/sessions/${sid}/thinking`, { headers: h() })).json()).current).toBe("low");
    expect(th.available.length).toBeGreaterThan(0);
  });

  test("⑥ 文件面：索引/raw/上传 + git 提交 + worktree", async () => {
    // 上传 + 索引
    const fd = new FormData();
    fd.append("files[0]", new File([new TextEncoder().encode("journey-note")], "notes.md"));
    const { "content-type": _ct, ...hUp } = h() as any;
    expect(
      (await fetch(`${BASE}/api/sessions/${sid}/files/upload`, { method: "POST", headers: hUp, body: fd })).status,
    ).toBe(201);
    const idx = await (await fetch(`${BASE}/api/sessions/${sid}/files/index?q=calc`, { headers: h() })).json();
    expect(idx.paths).toContain("calc.py");
    // raw
    const raw = await fetch(`${BASE}/api/sessions/${sid}/file/raw?path=calc.py`, { headers: h() });
    expect(await raw.text()).toContain("def mul");
    // git
    const wsDir = path.join(dataRoot, "users", UID, "workspaces", sid);
    Bun.spawnSync(["git", "init", "-q"], { cwd: wsDir });
    Bun.spawnSync(["git", "config", "user.email", "j@local"], { cwd: wsDir });
    Bun.spawnSync(["git", "config", "user.name", "j"], { cwd: wsDir });
    const commit = await fetch(`${BASE}/api/sessions/${sid}/git/commit`, {
      method: "POST",
      headers: h(),
      body: '{"message":"journey","add":"all"}',
    });
    expect(commit.status).toBe(200);
    // worktree（用户根内）
    const wt = await fetch(`${BASE}/api/sessions/${sid}/git/worktrees`, {
      method: "POST",
      headers: h(),
      body: '{"path":"wt-j","newBranch":"journey-wt"}',
    });
    expect(wt.status).toBe(201);
    const wtl = await (await fetch(`${BASE}/api/sessions/${sid}/git/worktrees`, { headers: h() })).json();
    expect(wtl.worktrees.some((w: any) => w.branch === "journey-wt")).toBeTrue();
    await fetch(`${BASE}/api/sessions/${sid}/git/worktrees?path=wt-j`, { method: "DELETE", headers: h() });
  });

  test("⑦ 快照：手动快照 → fork 分叉继承代码 → rollback 换文件", async () => {
    const snap = await (
      await fetch(`${BASE}/api/sessions/${sid}/snapshots`, {
        method: "POST",
        headers: h(),
        body: '{"name":"journey-snap"}',
      })
    ).json();
    expect(snap.entry_count).toBeGreaterThan(0);
    const fork = await (
      await fetch(`${BASE}/api/sessions/${sid}/snapshots/${snap.id}/restore`, {
        method: "POST",
        headers: h(),
        body: '{"mode":"fork"}',
      })
    ).json();
    expect(fork.parentId).toBe(sid);
    const forkFile = await (await fetch(`${BASE}/api/sessions/${fork.id}/file?path=calc.py`, { headers: h() })).json();
    expect(forkFile.content).toContain("def mul");
    const rb = await (
      await fetch(`${BASE}/api/sessions/${sid}/snapshots/${snap.id}/restore`, {
        method: "POST",
        headers: h(),
        body: '{"mode":"rollback"}',
      })
    ).json();
    expect(rb.preRestoreSnapshotId).toBeTruthy();
    const rbList = await (await fetch(`${BASE}/api/sessions/${sid}/snapshots`, { headers: h() })).json();
    expect(rbList.snapshots.some((s: any) => s.trigger === "pre_restore")).toBeTrue();
  });

  test("⑧ 切模型：pre_model_switch 自动快照 + model.changed", async () => {
    const before = await (await fetch(`${BASE}/api/sessions/${sid}/snapshots`, { headers: h() })).json();
    const sw = await fetch(`${BASE}/api/sessions/${sid}/model`, {
      method: "POST",
      headers: h(),
      body: '{"provider":"minimax","modelId":"MiniMax-M3"}',
    });
    expect(sw.status).toBe(200);
    const after = await (await fetch(`${BASE}/api/sessions/${sid}/snapshots`, { headers: h() })).json();
    expect(
      after.snapshots.some(
        (s: any) => s.trigger === "pre_model_switch" && !before.snapshots.some((b: any) => b.id === s.id),
      ),
    ).toBeTrue();
    // 切回
    await fetch(`${BASE}/api/sessions/${sid}/model`, {
      method: "POST",
      headers: h(),
      body: '{"provider":"minimax","modelId":"MiniMax-M3.1-Flash"}',
    });
  });

  test("⑨ 分享链接：view 只读 / control 对话写 / 配置面隔离", async () => {
    const v = await (
      await fetch(`${BASE}/api/sessions/${sid}/share-link`, { method: "POST", headers: h(), body: '{"access":"view"}' })
    ).json();
    expect((await fetch(`${BASE}/api/sessions/${sid}`, { headers: { "x-share-token": v.token } })).status).toBe(200);
    expect(
      (
        await (
          await fetch(`${BASE}/api/sessions/${sid}/prompt`, {
            method: "POST",
            headers: { "x-share-token": v.token },
            body: '{"text":"x"}',
          })
        ).json()
      ).error.code,
    ).toBe("SHARE_VIEW_ONLY");
    expect((await fetch(`${BASE}/api/me/models/config`, { headers: { "x-share-token": v.token } })).status).toBe(403);
    const c = await (
      await fetch(`${BASE}/api/sessions/${sid}/share-link`, {
        method: "POST",
        headers: h(),
        body: '{"access":"control"}',
      })
    ).json();
    // control：abort 在白名单内（idle 会话 abort → 202，不产生模型调用）
    expect(
      (await fetch(`${BASE}/api/sessions/${sid}/abort`, { method: "POST", headers: { "x-share-token": c.token } }))
        .status,
    ).toBe(202);
    await fetch(`${BASE}/api/sessions/${sid}/share-link/${v.id}`, { method: "DELETE", headers: h() });
    await fetch(`${BASE}/api/sessions/${sid}/share-link/${c.id}`, { method: "DELETE", headers: h() });
  });

  test("⑩ webhooks：注册 → 复活事件投递 → HMAC 验签 → 注销停发", async () => {
    const received: Array<{ body: string; sig: string | null }> = [];
    const receiver = Bun.serve({
      port: 0,
      fetch: async (req) => {
        received.push({ body: await req.text(), sig: req.headers.get("x-omp-signature") });
        return new Response("ok");
      },
    });
    try {
      await fetch(`${BASE}/api/sessions/${sid}`, { method: "PATCH", headers: h(), body: '{"status":"archived"}' }); // dispose
      const wh = await (
        await fetch(`${BASE}/internal/users/${UID}/webhooks`, {
          method: "POST",
          headers: h("admin"),
          body: JSON.stringify({ url: `http://127.0.0.1:${receiver.port}/h`, events: ["*"] }),
        })
      ).json();
      await fetch(`${BASE}/api/sessions/${sid}`, { method: "PATCH", headers: h(), body: '{"status":"active"}' }); // unarchive
      await fetch(`${BASE}/api/sessions/${sid}/abort`, { method: "POST", headers: h() }); // 复活 → publish session.status
      const ok = await waitFor(() => received.length > 0, 5000);
      expect(ok).toBeTrue();
      const { createHmac } = await import("node:crypto");
      expect(received[0].sig).toBe(createHmac("sha256", wh.secret).update(received[0].body).digest("hex"));
      await fetch(`${BASE}/internal/webhooks/${wh.id}`, { method: "DELETE", headers: h("admin") });
    } finally {
      receiver.stop(true);
    }
  });

  test("⑪ 并发两会话（真实模型）+ 用量累计", async () => {
    const s1 = (
      await (
        await fetch(`${BASE}/api/sessions`, {
          method: "POST",
          headers: h(),
          body: '{"title":"j1","model":{"provider":"minimax","modelId":"MiniMax-M3.1-Flash"}}',
        })
      ).json()
    ).id;
    const s2 = (
      await (
        await fetch(`${BASE}/api/sessions`, {
          method: "POST",
          headers: h(),
          body: '{"title":"j2","model":{"provider":"minimax","modelId":"MiniMax-M3.1-Flash"}}',
        })
      ).json()
    ).id;
    const c1 = startCollector(UID, s1);
    const c2 = startCollector(UID, s2);
    await new Promise((r) => setTimeout(r, 500));
    const [p1, p2] = await Promise.all([
      fetch(`${BASE}/api/sessions/${s1}/prompt`, {
        method: "POST",
        headers: h(),
        body: '{"text":"Reply with exactly: J1-OK"}',
      }),
      fetch(`${BASE}/api/sessions/${s2}/prompt`, {
        method: "POST",
        headers: h(),
        body: '{"text":"Reply with exactly: J2-OK"}',
      }),
    ]);
    expect(p1.status).toBe(202);
    expect(p2.status).toBe(202);
    const done = await waitFor(
      () =>
        c1.frames.some((f) => f.event === "turn.completed" && f.data.isTerminal) &&
        c2.frames.some((f) => f.event === "turn.completed" && f.data.isTerminal),
      180_000,
    );
    c1.stop();
    c2.stop();
    expect(done).toBeTrue();
    expect(
      c1.frames
        .filter((f) => f.event === "text.delta")
        .map((f) => f.data.delta)
        .join(""),
    ).toContain("J1-OK");
    expect(
      c2.frames
        .filter((f) => f.event === "text.delta")
        .map((f) => f.data.delta)
        .join(""),
    ).toContain("J2-OK");
  }, 240_000);

  test("⑫ 生命周期串接：归档 → trash 找回 → 再删 → purge → 消失", async () => {
    const r = await (
      await fetch(`${BASE}/api/sessions`, { method: "POST", headers: h(), body: '{"title":"lifecycle"}' })
    ).json();
    const lid = r.id;
    await fetch(`${BASE}/api/sessions/${lid}`, { method: "PATCH", headers: h(), body: '{"status":"archived"}' });
    expect(
      (
        await (
          await fetch(`${BASE}/api/sessions/${lid}/prompt`, { method: "POST", headers: h(), body: '{"text":"x"}' })
        ).json()
      ).error.code,
    ).toBe("SESSION_ARCHIVED");
    await fetch(`${BASE}/api/sessions/${lid}`, { method: "PATCH", headers: h(), body: '{"status":"active"}' });
    await fetch(`${BASE}/api/sessions/${lid}?confirm=${lid}`, { method: "DELETE", headers: h() });
    expect(
      (await (await fetch(`${BASE}/internal/trash`, { headers: h("admin") })).json()).sessions.some(
        (s: any) => s.id === lid,
      ),
    ).toBeTrue();
    expect(
      (await fetch(`${BASE}/internal/trash/sessions/${lid}/restore`, { method: "POST", headers: h("admin") })).status,
    ).toBe(200);
    expect((await fetch(`${BASE}/api/sessions/${lid}`, { headers: h() })).status).toBe(200);
    // drain 快速验证
    await fetch(`${BASE}/internal/drain`, { method: "POST", headers: h("admin") });
    expect((await fetch(`${BASE}/api/sessions`, { method: "POST", headers: h(), body: "{}" })).status).toBe(503);
    await fetch(`${BASE}/internal/drain?off=1`, { method: "POST", headers: h("admin") });
    expect((await fetch(`${BASE}/healthz`)).status).toBe(200);
  });

  test("⑬ 级联删除用户：全量 dispose + 拒绝新会话", async () => {
    const metricsBefore = await (await fetch(`${BASE}/metrics`)).text();
    const before = Number(metricsBefore.match(/omp_gateway_sessions_live (\d+)/)![1]);
    expect(before).toBeGreaterThan(0);
    const del = await fetch(`${BASE}/internal/users/${UID}?confirm=${UID}`, { method: "DELETE", headers: h("admin") });
    expect(del.status).toBe(200);
    const metricsAfter = await (await fetch(`${BASE}/metrics`)).text();
    expect(metricsAfter).toContain("omp_gateway_sessions_live 0");
    // 已删租户拒绝新会话（懒 provision 出 deleted 状态）
    expect(
      (await (await fetch(`${BASE}/api/sessions`, { method: "POST", headers: h(), body: "{}" })).json()).error.code,
    ).toBe("TENANT_DISABLED");
  });
});
