/**
 * 集成测试：spawn 真实网关子进程（独立端口/独立数据根），HTTP 全链路验证。
 * 不依赖任何模型凭据——无模型路径的错误降级本身是测试点。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const TOK = "it-token";
const H = { authorization: `Bearer ${TOK}`, "content-type": "application/json" };
const h = (uid: string, extra: Record<string, string> = {}) => ({ ...H, "x-user-id": uid, ...extra });

const dataRoot = mkdtempSync(path.join(tmpdir(), "omp-gw-it-"));
let proc: Bun.Subprocess;

beforeAll(async () => {
  proc = Bun.spawn([process.execPath, "run", "src/index.ts"], {
    cwd: path.resolve(import.meta.dir, ".."),
    env: { ...process.env, GATEWAY_PORT: String(PORT), GATEWAY_DATA_ROOT: dataRoot, GATEWAY_SERVICE_TOKENS: TOK },
    stdout: "pipe",
    stderr: "pipe",
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("gateway did not become healthy in 20s");
}, 30_000);

afterAll(() => {
  try {
    proc.kill();
  } catch {}
  // Windows 兜底：按树强杀
  try {
    Bun.spawnSync(["taskkill", "/F", "/T", "/PID", String(proc.pid)]);
  } catch {}
});

const j = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => ({})) });

/** 收集 SSE 帧（event+data），deadline 后 abort。 */
async function collectSSE(
  url: string,
  headers: Record<string, string>,
  ms: number,
): Promise<Array<{ event: string; data: any }>> {
  const ac = new AbortController();
  const frames: Array<{ event: string; data: any }> = [];
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { headers, signal: ac.signal });
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
          } catch {
            frames.push({ event: ev, data });
          }
        }
      }
      if (frames.length) break; // 拿到首帧即返回（够断言）
    }
  } catch {
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  return frames;
}

describe("integration: gateway full endpoints", () => {
  test("healthz / readyz / metrics 基线", async () => {
    expect((await fetch(`${BASE}/healthz`)).status).toBe(200);
    const ready = await (await fetch(`${BASE}/readyz`)).json();
    expect(ready.ready).toBe(true);
    const metrics = await (await fetch(`${BASE}/metrics`)).text();
    expect(metrics).toContain("omp_gateway_sessions_live 0");
  });

  test("认证：缺 token / 错 token / 缺 X-User-Id → 401", async () => {
    expect((await fetch(`${BASE}/api/sessions`)).status).toBe(401);
    expect(
      (await fetch(`${BASE}/api/sessions`, { headers: { authorization: "Bearer nope", "x-user-id": "u1" } })).status,
    ).toBe(401);
    expect((await fetch(`${BASE}/api/sessions`, { headers: { authorization: `Bearer ${TOK}` } })).status).toBe(401);
  });

  test("X-Request-Id：缺失生成、传入回显", async () => {
    const r1 = await fetch(`${BASE}/healthz`);
    expect(r1.headers.get("x-request-id")).toBeTruthy();
    const r2 = await fetch(`${BASE}/healthz`, { headers: { "x-request-id": "req-abc-1" } });
    expect(r2.headers.get("x-request-id")).toBe("req-abc-1");
  });

  test("建会话（无模型）：目录骨架落位、DB 行、详情 live", async () => {
    const { status, body } = await j(
      await fetch(`${BASE}/api/sessions`, {
        method: "POST",
        headers: h("u1"),
        body: JSON.stringify({ title: "first" }),
      }),
    );
    expect(status).toBe(201);
    expect(body.workspaceId).toBe(body.id); // 会话:workspace = 1:1
    // 无模型配置：创建成功但带降级告警（模型在首条 prompt 前可经 /model 或凭据补齐）
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0]).toContain("No default model");
    const sid = body.id as string;
    const { stat } = await import("node:fs/promises");
    expect((await stat(path.join(dataRoot, "users", "u1", "agent"))).isDirectory()).toBeTrue();
    expect((await stat(path.join(dataRoot, "users", "u1", "sessions"))).isDirectory()).toBeTrue();
    expect(
      (await Bun.file(path.join(dataRoot, "users", "u1", "workspaces", sid, ".omp", "mcp.json")).json())._managedBy,
    ).toBe("omp-gateway");

    const list = await j(await fetch(`${BASE}/api/sessions`, { headers: h("u1") }));
    expect(list.body.sessions).toHaveLength(1);

    const detail = await j(await fetch(`${BASE}/api/sessions/${sid}`, { headers: h("u1") }));
    expect(detail.body.live.present).toBe(true);
    expect(detail.body.live.status).toBe("idle");
  });

  test("无模型路径：空文本 400、prompt 409 MODEL_UNAVAILABLE、steer 202（入队后异步失败）、abort 202", async () => {
    const sid = (await j(await fetch(`${BASE}/api/sessions`, { headers: h("u1") }))).body.sessions[0].id;
    expect(
      (
        await j(
          await fetch(`${BASE}/api/sessions/${sid}/prompt`, { method: "POST", headers: h("u1"), body: '{"text":""}' }),
        )
      ).status,
    ).toBe(400);
    const p = await j(
      await fetch(`${BASE}/api/sessions/${sid}/prompt`, { method: "POST", headers: h("u1"), body: '{"text":"hi"}' }),
    );
    expect(p.status).toBe(409);
    expect(p.body.error.code).toBe("MODEL_UNAVAILABLE");
    // steer 在 idle 会话不做同步模型校验（SDK 入队，错误经事件流浮现）
    const s = await j(
      await fetch(`${BASE}/api/sessions/${sid}/steer`, { method: "POST", headers: h("u1"), body: '{"text":"x"}' }),
    );
    expect(s.status).toBe(202);
    const a = await j(await fetch(`${BASE}/api/sessions/${sid}/abort`, { method: "POST", headers: h("u1") }));
    expect(a.status).toBe(202);
  });

  test("多租户隔离：u2 看不到 u1 的会话（404），列表为空", async () => {
    const sid = (await j(await fetch(`${BASE}/api/sessions`, { headers: h("u1") }))).body.sessions[0].id;
    expect((await fetch(`${BASE}/api/sessions/${sid}`, { headers: h("u2") })).status).toBe(404);
    expect((await j(await fetch(`${BASE}/api/sessions`, { headers: h("u2") }))).body.sessions).toHaveLength(0);
    const frames = await collectSSE(`${BASE}/api/sessions/${sid}/events`, h("u2"), 8000);
    expect(frames[0]?.event).toBe("error");
  });

  test("SSE：replay.state 首帧 + keep-alive + Last-Event-ID 重连", async () => {
    const sid = (await j(await fetch(`${BASE}/api/sessions`, { headers: h("u1") }))).body.sessions[0].id;
    const frames = await collectSSE(`${BASE}/api/sessions/${sid}/events`, h("u1"), 8000);
    const rs = frames.find((f) => f.event === "replay.state");
    expect(rs).toBeTruthy();
    expect(rs!.data.status).toBe("idle");
    expect(typeof rs!.data.lastEventId).toBe("number");
    // 重连：带 Last-Event-ID（游标之后无缓冲事件也不应报错，且首帧仍是 replay.state）
    const frames2 = await collectSSE(
      `${BASE}/api/sessions/${sid}/events`,
      { ...h("u1"), "last-event-id": String(rs!.data.lastEventId) },
      8000,
    );
    expect(frames2.find((f) => f.event === "replay.state")).toBeTruthy();
  });

  test("同用户双会话并发存在（私有 AgentRegistry）", async () => {
    const r1 = await j(await fetch(`${BASE}/api/sessions`, { method: "POST", headers: h("u1"), body: "{}" }));
    const r2 = await j(await fetch(`${BASE}/api/sessions`, { method: "POST", headers: h("u1"), body: "{}" }));
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    const d1 = await j(await fetch(`${BASE}/api/sessions/${r1.body.id}`, { headers: h("u1") }));
    const d2 = await j(await fetch(`${BASE}/api/sessions/${r2.body.id}`, { headers: h("u1") }));
    expect(d1.body.live.present).toBe(true);
    expect(d2.body.live.present).toBe(true);
  });

  test("归档→写操作 409→回active→复活后 prompt 409 MODEL_UNAVAILABLE", async () => {
    const sid = (await j(await fetch(`${BASE}/api/sessions`, { headers: h("u1") }))).body.sessions[0].id;
    const patch = await j(
      await fetch(`${BASE}/api/sessions/${sid}`, { method: "PATCH", headers: h("u1"), body: '{"status":"archived"}' }),
    );
    expect(patch.body.status).toBe("archived");
    const p1 = await j(
      await fetch(`${BASE}/api/sessions/${sid}/prompt`, { method: "POST", headers: h("u1"), body: '{"text":"x"}' }),
    );
    expect(p1.body.error.code).toBe("SESSION_ARCHIVED");
    await fetch(`${BASE}/api/sessions/${sid}`, { method: "PATCH", headers: h("u1"), body: '{"status":"active"}' });
    const d = await j(await fetch(`${BASE}/api/sessions/${sid}`, { headers: h("u1") }));
    expect(d.body.status).toBe("active");
    const p2 = await j(
      await fetch(`${BASE}/api/sessions/${sid}/prompt`, { method: "POST", headers: h("u1"), body: '{"text":"x"}' }),
    );
    // 复活成功（对象重建），仅因无模型而 409
    expect(p2.body.error.code).toBe("MODEL_UNAVAILABLE");
  });

  test("删除：无 confirm 400、带 confirm 200、此后 GET 404", async () => {
    const sid = (await j(await fetch(`${BASE}/api/sessions`, { headers: h("u1") }))).body.sessions[0].id;
    expect((await fetch(`${BASE}/api/sessions/${sid}?x=1`, { method: "DELETE", headers: h("u1") })).status).toBe(400);
    const del = await j(
      await fetch(`${BASE}/api/sessions/${sid}?confirm=${sid}`, { method: "DELETE", headers: h("u1") }),
    );
    expect(del.body.status).toBe("deleted");
    expect((await fetch(`${BASE}/api/sessions/${sid}`, { headers: h("u1") })).status).toBe(404);
  });

  test("internal：provision/summary/limits（maxSessions=1 → 409；allowlist → 403）/级联删除", async () => {
    const pr = await j(await fetch(`${BASE}/internal/users/u9/provision`, { method: "POST", headers: h("admin") }));
    expect(pr.status).toBe(201);
    expect(pr.body.limits.maxSessions).toBeGreaterThan(0);

    const sum = await j(await fetch(`${BASE}/internal/users/u9/summary`, { headers: h("admin") }));
    expect(sum.body.user_id).toBe("u9");

    await fetch(`${BASE}/internal/users/u9/limits`, {
      method: "PATCH",
      headers: h("admin"),
      body: '{"maxSessions":1}',
    });
    const s1 = await j(await fetch(`${BASE}/api/sessions`, { method: "POST", headers: h("u9"), body: "{}" }));
    expect(s1.status).toBe(201);
    const s2 = await j(await fetch(`${BASE}/api/sessions`, { method: "POST", headers: h("u9"), body: "{}" }));
    expect(s2.status).toBe(409);
    expect(s2.body.error.code).toBe("SESSION_LIMIT");

    await fetch(`${BASE}/internal/users/u9/limits`, {
      method: "PATCH",
      headers: h("admin"),
      body: '{"maxSessions":10,"allowedProviders":["minimax"]}',
    });
    const s3 = await j(
      await fetch(`${BASE}/api/sessions`, {
        method: "POST",
        headers: h("u9"),
        body: '{"model":{"provider":"openai","modelId":"gpt-x"}}',
      }),
    );
    expect(s3.status).toBe(403);
    expect(s3.body.error.code).toBe("PROVIDER_NOT_ALLOWED");

    const liveBefore = Number(
      (await (await fetch(`${BASE}/metrics`)).text()).match(/omp_gateway_sessions_live (\d+)/)![1],
    );
    const del = await j(await fetch(`${BASE}/internal/users/u9?confirm=u9`, { method: "DELETE", headers: h("admin") }));
    expect(del.body.status).toBe("deleted");
    const liveAfter = Number(
      (await (await fetch(`${BASE}/metrics`)).text()).match(/omp_gateway_sessions_live (\d+)/)![1],
    );
    expect(liveAfter).toBe(liveBefore - 1); // 仅 u9 的会话被级联 dispose，其他用户不受影响
  });

  test("drain：开启后建会话 503 + healthz 503，关闭恢复", async () => {
    await fetch(`${BASE}/internal/drain`, { method: "POST", headers: h("admin") });
    expect((await fetch(`${BASE}/healthz`)).status).toBe(503);
    expect(
      (await j(await fetch(`${BASE}/api/sessions`, { method: "POST", headers: h("u1"), body: "{}" }))).status,
    ).toBe(503);
    await fetch(`${BASE}/internal/drain?off=1`, { method: "POST", headers: h("admin") });
    expect((await fetch(`${BASE}/healthz`)).status).toBe(200);
    expect(
      (await j(await fetch(`${BASE}/api/sessions`, { method: "POST", headers: h("u1"), body: "{}" }))).status,
    ).toBe(201);
  });

  test("审计：变更动作落 audit_log", async () => {
    const db = new Database(path.join(dataRoot, "gateway.db"), { readonly: true });
    try {
      const n = (db.query("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n;
      expect(n).toBeGreaterThan(5);
      const rows = db.query("SELECT DISTINCT action FROM audit_log").all() as Array<{ action: string }>;
      const actions = new Set(rows.map((r) => r.action));
      expect(actions.has("session.create")).toBeTrue();
      expect(actions.has("session.delete")).toBeTrue();
      expect(actions.has("tenant.delete")).toBeTrue();
    } finally {
      db.close();
    }
  });
});

describe("integration: workspace 文件管理 + git + 用量端点", () => {
  const uid = "u1";
  let sid = "";

  beforeAll(async () => {
    // 复用（或新建）一个 active 会话的 workspace
    const list = await (await fetch(`${BASE}/api/sessions?status=active`, { headers: h(uid) })).json();
    if (list.sessions?.length) {
      sid = list.sessions[0].id;
    } else {
      const r = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: h(uid), body: "{}" });
      sid = (await r.json()).id;
    }
  });

  test("文件 PUT→tree→GET 往返；base64 二进制往返", async () => {
    const put = await fetch(`${BASE}/api/sessions/${sid}/file?path=docs/hello.md`, {
      method: "PUT",
      headers: h(uid),
      body: JSON.stringify({ content: "# hello gateway\n" }),
    });
    expect(put.status).toBe(200);
    expect(((await put.json()) as any).size).toBeGreaterThan(0);

    const tree = await (await fetch(`${BASE}/api/sessions/${sid}/tree?path=docs`, { headers: h(uid) })).json();
    expect(tree.entries.map((e: any) => e.name)).toContain("hello.md");

    const get = await (await fetch(`${BASE}/api/sessions/${sid}/file?path=docs/hello.md`, { headers: h(uid) })).json();
    expect(get.encoding).toBe("utf8");
    expect(get.content).toContain("hello gateway");

    const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]);
    await fetch(`${BASE}/api/sessions/${sid}/file?path=img/a.png`, {
      method: "PUT",
      headers: h(uid),
      body: JSON.stringify({ content: bin.toString("base64"), encoding: "base64" }),
    });
    const getBin = await (await fetch(`${BASE}/api/sessions/${sid}/file?path=img/a.png`, { headers: h(uid) })).json();
    expect(getBin.encoding).toBe("base64");
    expect(Buffer.from(getBin.content, "base64").includes(0)).toBeTrue();
  });

  test("路径攻击一律拒绝（../、绝对路径、编码绕过）", async () => {
    for (const p of ["../escape.txt", "a/../../escape.txt", "..%2fescape.txt"]) {
      const r = await fetch(`${BASE}/api/sessions/${sid}/file?path=${encodeURIComponent(p)}`, { headers: h(uid) });
      // 解码后仍是 ../ 逃逸 → 400 PATH_FORBIDDEN；或不存在文件 → 404（不在界内文件一律不给内容）
      expect([400, 404]).toContain(r.status);
    }
    if (process.platform === "win32") {
      const r = await fetch(`${BASE}/api/sessions/${sid}/file?path=${encodeURIComponent("C:\\Windows\\win.ini")}`, {
        headers: h(uid),
      });
      expect([400, 404]).toContain(r.status);
    }
    const putEscape = await fetch(`${BASE}/api/sessions/${sid}/file?path=${encodeURIComponent("../evil.txt")}`, {
      method: "PUT",
      headers: h(uid),
      body: JSON.stringify({ content: "x" }),
    });
    expect(putEscape.status).toBe(400);
  });

  test("mkdir/rename/delete 往返", async () => {
    await fetch(`${BASE}/api/sessions/${sid}/file/mkdir`, {
      method: "POST",
      headers: h(uid),
      body: '{"path":"tmp/renamed-dir"}',
    });
    await fetch(`${BASE}/api/sessions/${sid}/file?path=tmp/renamed-dir/f.txt`, {
      method: "PUT",
      headers: h(uid),
      body: '{"content":"1"}',
    });
    const ren = await fetch(`${BASE}/api/sessions/${sid}/file/rename`, {
      method: "POST",
      headers: h(uid),
      body: '{"from":"tmp/renamed-dir/f.txt","to":"tmp/renamed-dir/g.txt"}',
    });
    expect(ren.status).toBe(200);
    const del = await fetch(`${BASE}/api/sessions/${sid}/file?path=tmp`, { method: "DELETE", headers: h(uid) });
    expect(del.status).toBe(200);
    const gone = await fetch(`${BASE}/api/sessions/${sid}/file?path=tmp/renamed-dir/g.txt`, { headers: h(uid) });
    expect(gone.status).toBe(404);
  });

  test("归档会话：文件读放行、写 409", async () => {
    const r = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: h(uid), body: '{"title":"ws-arch"}' });
    const archSid = (await r.json()).id;
    await fetch(`${BASE}/api/sessions/${archSid}/file?path=x.txt`, {
      method: "PUT",
      headers: h(uid),
      body: '{"content":"v1"}',
    });
    await fetch(`${BASE}/api/sessions/${archSid}`, { method: "PATCH", headers: h(uid), body: '{"status":"archived"}' });
    expect((await fetch(`${BASE}/api/sessions/${archSid}/file?path=x.txt`, { headers: h(uid) })).status).toBe(200);
    expect(
      (
        await fetch(`${BASE}/api/sessions/${archSid}/file?path=y.txt`, {
          method: "PUT",
          headers: h(uid),
          body: '{"content":"v"}',
        })
      ).status,
    ).toBe(409);
  });

  test("git：init→status→commit→log→branches→diff", async () => {
    const wsDir = path.join(dataRoot, "users", uid, "workspaces", sid);
    const hasGit = Bun.which("git") !== null;
    if (!hasGit) return; // 无 git 环境跳过（CI 注意安装）
    Bun.spawnSync(["git", "init", "-q"], { cwd: wsDir });
    Bun.spawnSync(["git", "config", "user.email", "gw-test@local"], { cwd: wsDir });
    Bun.spawnSync(["git", "config", "user.name", "gw-test"], { cwd: wsDir });

    const status0 = await (await fetch(`${BASE}/api/sessions/${sid}/git/status`, { headers: h(uid) })).json();
    expect(status0.branch).toBeTruthy(); // 空仓库为 "No commits yet on <branch>"，也解析出分支名

    await fetch(`${BASE}/api/sessions/${sid}/file?path=code/main.py`, {
      method: "PUT",
      headers: h(uid),
      body: '{"content":"print(1)\\n"}',
    });
    const st1 = await (await fetch(`${BASE}/api/sessions/${sid}/git/status`, { headers: h(uid) })).json();
    expect(st1.entries.some((e: any) => e.path.includes("code/main.py"))).toBeTrue();

    const diff1 = await (await fetch(`${BASE}/api/sessions/${sid}/git/diff`, { headers: h(uid) })).json();
    expect(typeof diff1.diff).toBe("string"); // 未跟踪文件不在 diff 里，仅结构断言

    const c1 = await fetch(`${BASE}/api/sessions/${sid}/git/commit`, {
      method: "POST",
      headers: h(uid),
      body: '{"message":"init commit","add":"all"}',
    });
    expect(c1.status).toBe(200);
    const hash = ((await c1.json()) as any).hash;
    expect(hash).toBeTruthy();

    const st2 = await (await fetch(`${BASE}/api/sessions/${sid}/git/status`, { headers: h(uid) })).json();
    expect(st2.entries).toHaveLength(0);

    const log = await (await fetch(`${BASE}/api/sessions/${sid}/git/log`, { headers: h(uid) })).json();
    expect(log.commits[0].hash).toBe(hash);
    expect(log.commits[0].subject).toBe("init commit");

    const br = await (await fetch(`${BASE}/api/sessions/${sid}/git/branches`, { headers: h(uid) })).json();
    expect(br.branches.some((b: any) => b.current)).toBeTrue();

    await fetch(`${BASE}/api/sessions/${sid}/file?path=code/main.py`, {
      method: "PUT",
      headers: h(uid),
      body: '{"content":"print(2)\\n"}',
    });
    const diff2 = await (
      await fetch(`${BASE}/api/sessions/${sid}/git/diff?path=code/main.py`, { headers: h(uid) })
    ).json();
    expect(diff2.diff).toContain("print(2)");
    const diffStaged = await (await fetch(`${BASE}/api/sessions/${sid}/git/diff?staged=1`, { headers: h(uid) })).json();
    expect(typeof diffStaged.diff).toBe("string");

    const emptyCommit = await fetch(`${BASE}/api/sessions/${sid}/git/commit`, {
      method: "POST",
      headers: h(uid),
      body: '{"message":"nothing"}',
    });
    expect(emptyCommit.status).toBe(500); // GIT_FAILED（无暂存内容）
  });

  test("非 git 仓库的 workspace → 409 NOT_A_GIT_REPO", async () => {
    const r = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: h("u2-gitless"), body: "{}" });
    const freshSid = (await r.json()).id;
    const res = await (await fetch(`${BASE}/api/sessions/${freshSid}/git/status`, { headers: h("u2-gitless") })).json();
    expect(res.error.code).toBe("NOT_A_GIT_REPO");
  });

  test("用量端点结构（无模型会话为空聚合）+ metrics 计数器", async () => {
    const su = await (await fetch(`${BASE}/api/sessions/${sid}/usage`, { headers: h(uid) })).json();
    expect(su.summary.turns).toBe(0);
    expect(su.summary.inputTokens).toBe(0);
    expect(su.turns).toEqual([]);

    const me = await (await fetch(`${BASE}/api/me/usage?group=day`, { headers: h(uid) })).json();
    expect(me.group).toBe("day");
    expect(me.totals.turns).toBe(0);
    expect(me.buckets).toEqual([]);

    const bad = await fetch(`${BASE}/api/me/usage?group=bogus`, { headers: h(uid) });
    expect(bad.status).toBe(400);

    const internal = await (
      await fetch(`${BASE}/internal/users/${uid}/usage?group=model`, { headers: h("admin") })
    ).json();
    expect(internal.user_id).toBe(uid);
    expect(Array.isArray(internal.buckets)).toBeTrue();

    const metrics = await (await fetch(`${BASE}/metrics`)).text();
    expect(metrics).toContain("omp_gateway_usage_turns_total 0");
    expect(metrics).toContain("omp_gateway_usage_input_tokens_total 0");
  });

  test("SDK 桥：state 快照结构（无模型降级）", async () => {
    const st = await (await fetch(`${BASE}/api/sessions/${sid}/state`, { headers: h(uid) })).json();
    expect(st.sessionId).toBe(sid);
    expect(st.status).toBe("idle");
    expect(st.model).toBeNull(); // 该测试服务无模型配置
    expect(typeof st.thinkingLevel).toBe("string"); // omp 默认思考等级（非 null）
    expect(Array.isArray(st.availableThinkingLevels)).toBeTrue();
    expect(st.queue).toMatchObject({ steering: [], followUp: [] });
    expect(st.tools.all.length).toBeGreaterThan(5); // 内置工具
    expect(st.tools.active.length).toBeGreaterThan(0);
    expect(st.messageCount).toBe(0);
    expect(st.sessionFile).toBeTruthy();
  });

  test("SDK 桥：messages 空历史 + since 参数", async () => {
    const m = await (await fetch(`${BASE}/api/sessions/${sid}/messages`, { headers: h(uid) })).json();
    expect(m.total).toBe(0);
    expect(m.messages).toEqual([]);
  });

  test("SDK 桥：tools GET/PUT 往返（运行时工具集）", async () => {
    const before = await (await fetch(`${BASE}/api/sessions/${sid}/tools`, { headers: h(uid) })).json();
    expect(before.all).toContain("read");
    expect(before.all).toContain("bash");
    const subset = before.all.filter((t: string) => ["read", "grep", "glob"].includes(t));
    const put = await fetch(`${BASE}/api/sessions/${sid}/tools`, {
      method: "PUT",
      headers: h(uid),
      body: JSON.stringify({ active: subset }),
    });
    expect(put.status).toBe(200);
    const after = await (await fetch(`${BASE}/api/sessions/${sid}/tools`, { headers: h(uid) })).json();
    expect(after.active.sort()).toEqual(subset.sort());
    // 还原全量
    await fetch(`${BASE}/api/sessions/${sid}/tools`, {
      method: "PUT",
      headers: h(uid),
      body: JSON.stringify({ active: before.active }),
    });
  });

  test("SDK 桥：thinking GET/PUT 往返", async () => {
    const t = await (await fetch(`${BASE}/api/sessions/${sid}/thinking`, { headers: h(uid) })).json();
    expect(Array.isArray(t.available)).toBeTrue();
    const put = await fetch(`${BASE}/api/sessions/${sid}/thinking`, {
      method: "PUT",
      headers: h(uid),
      body: '{"level":"low"}',
    });
    expect(put.status).toBe(200);
    const after = await (await put.json()).current;
    expect(after).toBe("low");
  });

  test("文件索引/raw 流/上传（pi-web 对标）", async () => {
    // 索引：包含已写文件，q 过滤命中
    const idx = await (await fetch(`${BASE}/api/sessions/${sid}/files/index`, { headers: h(uid) })).json();
    expect(idx.paths.some((p: string) => p === "docs/hello.md")).toBeTrue();
    const q = await (await fetch(`${BASE}/api/sessions/${sid}/files/index?q=hello`, { headers: h(uid) })).json();
    expect(q.paths).toContain("docs/hello.md");
    expect(q.paths.every((p: string) => p.toLowerCase().includes("hello"))).toBeTrue();

    // raw：content-type + Range
    await fetch(`${BASE}/api/sessions/${sid}/file?path=assets/raw.txt`, {
      method: "PUT",
      headers: h(uid),
      body: '{"content":"0123456789ABCDEF"}',
    });
    const raw = await fetch(`${BASE}/api/sessions/${sid}/file/raw?path=assets/raw.txt`, { headers: h(uid) });
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toContain("text/plain");
    expect(await raw.text()).toBe("0123456789ABCDEF");
    const part = await fetch(`${BASE}/api/sessions/${sid}/file/raw?path=assets/raw.txt`, {
      headers: { ...h(uid), range: "bytes=0-3" },
    });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 0-3/16");
    expect(await part.text()).toBe("0123");

    // multipart 上传：FormData 直传 + 文件名穿越剥离
    const fd = new FormData();
    fd.append("files[0]", new File([new TextEncoder().encode("up1")], "a.txt"));
    fd.append("files[1]", new File([new TextEncoder().encode("up2")], "../evil.txt"));
    const { "content-type": _ct, ...hUpload } = h(uid) as any; // 让 fetch 自动设置 multipart 边界
    const up = await fetch(`${BASE}/api/sessions/${sid}/files/upload?path=uploads`, {
      method: "POST",
      headers: hUpload,
      body: fd,
    });
    if (up.status !== 201) console.error("UPLOAD FAIL:", JSON.stringify(await up.clone().json()));
    expect(up.status).toBe(201);
    const upBody = await up.json();
    expect(upBody.written).toHaveLength(2);
    // 安全性质：全部落在 uploads/ 目录内（穿越被剥离），且文件名被净化
    expect(upBody.written.every((f: any) => f.path.startsWith("uploads/"))).toBeTrue();
    expect(upBody.written.some((f: any) => f.name === "evil.txt")).toBeTrue();
  });

  test("git worktree：增/查/删 + 用户根守卫", async () => {
    const hasGit = Bun.which("git") !== null;
    if (!hasGit) return;
    // git 测试已在前序用例建仓；若无仓库则跳过
    const st = await (await fetch(`${BASE}/api/sessions/${sid}/git/status`, { headers: h(uid) })).json();
    if (!st.branch) return;

    const add = await fetch(`${BASE}/api/sessions/${sid}/git/worktrees`, {
      method: "POST",
      headers: h(uid),
      body: JSON.stringify({ path: "wt-feature", newBranch: "feature/wt" }),
    });
    expect(add.status).toBe(201);
    const list = await (await fetch(`${BASE}/api/sessions/${sid}/git/worktrees`, { headers: h(uid) })).json();
    expect(list.worktrees.some((w: any) => w.branch === "feature/wt")).toBeTrue();

    const esc = await fetch(`${BASE}/api/sessions/${sid}/git/worktrees`, {
      method: "POST",
      headers: h(uid),
      body: '{"path":"../../outside"}',
    });
    expect(esc.status).toBe(400);

    const del = await fetch(`${BASE}/api/sessions/${sid}/git/worktrees?path=wt-feature`, {
      method: "DELETE",
      headers: h(uid),
    });
    expect(del.status).toBe(200);
  });

  test("SDK 桥：export/dump/fresh + fork{entryId}/branch 错误面", async () => {
    // dump：结构（共享会话已有 custom message 入上下文）
    const dump = await (await fetch(`${BASE}/api/sessions/${sid}/dump`, { headers: h(uid) })).json();
    expect(typeof dump.text).toBe("string");

    // export：workspace/exports 落盘
    const ex = await fetch(`${BASE}/api/sessions/${sid}/export`, { method: "POST", headers: h(uid) });
    expect(ex.status).toBe(200);
    const exBody = await ex.json();
    expect(exBody.bytes).toBeGreaterThan(0);
    const exFile = await fetch(`${BASE}/api/sessions/${sid}/file?path=${encodeURIComponent(exBody.path)}`, {
      headers: h(uid),
    });
    expect(exFile.status).toBe(200);

    // fresh：idle 会话 → 200
    const fr = await fetch(`${BASE}/api/sessions/${sid}/fresh`, { method: "POST", headers: h(uid) });
    expect(fr.status).toBe(200);

    // fork/branch 的 entryId 错误面：无效 id → SDK 错误透传为 409
    const fkBad = await (
      await fetch(`${BASE}/api/sessions/${sid}/fork`, {
        method: "POST",
        headers: h(uid),
        body: '{"entryId":"no-such-entry"}',
      })
    ).json();
    expect(fkBad.error).toBeTruthy();
    const brNoArg = await fetch(`${BASE}/api/sessions/${sid}/branch`, { method: "POST", headers: h(uid), body: "{}" });
    expect(brNoArg.status).toBe(400);
    const brBad = await (
      await fetch(`${BASE}/api/sessions/${sid}/branch`, {
        method: "POST",
        headers: h(uid),
        body: '{"entryId":"no-such-entry"}',
      })
    ).json();
    expect(brBad.error).toBeTruthy();
  });

  test("幂等：Idempotency-Key 重放（建会话/快照）+ 作用域隔离", async () => {
    // 建会话：同 key 两次 → 同一 session id；第二次带重放标记
    const hdrs = { ...h("idem-user"), "idempotency-key": "key-123" };
    const r1 = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: hdrs, body: '{"title":"idem"}' });
    expect(r1.status).toBe(201);
    const b1 = await r1.json();
    const r2 = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: hdrs, body: '{"title":"idem"}' });
    const b2 = await r2.json();
    expect(b2.id).toBe(b1.id);
    expect(r2.headers.get("idempotency-replayed")).toBe("true");
    // 不同用户同 key → 不同会话（作用域隔离）
    const r3 = await fetch(`${BASE}/api/sessions`, {
      method: "POST",
      headers: { ...h("idem-other"), "idempotency-key": "key-123" },
      body: '{"title":"idem"}',
    });
    const b3 = await r3.json();
    expect(b3.id).not.toBe(b1.id);
    // 快照幂等（无 transcript → 409 不缓存，重试仍 409）
    const sk = await fetch(`${BASE}/api/sessions/${b1.id}/snapshots`, {
      method: "POST",
      headers: { ...h("idem-user"), "idempotency-key": "snap-1" },
      body: '{"name":"s"}',
    });
    expect(sk.status).toBe(409); // SNAPSHOT_EMPTY（零 turn 会话）
  });

  test("会话列表增强：usage/lastMessage/live 内联", async () => {
    const list = await (await fetch(`${BASE}/api/sessions?status=active`, { headers: h(uid) })).json();
    expect(list.sessions.length).toBeGreaterThan(0);
    const first = list.sessions[0];
    expect(first.usage).toMatchObject({ turns: 0, inputTokens: 0 });
    expect("lastMessage" in first).toBeTrue();
    expect("contextPercent" in first).toBeTrue();
    expect("live" in first).toBeTrue();
  });

  test("me/skills 与 me/plugins 清单端点", async () => {
    const skills = await (await fetch(`${BASE}/api/me/skills`, { headers: h("cfg-user") })).json();
    expect(skills).toBeTruthy();
    const plugins = await (await fetch(`${BASE}/api/me/plugins`, { headers: h("cfg-user") })).json();
    expect(Array.isArray(plugins.plugins)).toBeTrue();
  });

  test("me/projects：按仓库聚合会话", async () => {
    const r = await (await fetch(`${BASE}/api/me/projects`, { headers: h(uid) })).json();
    expect(Array.isArray(r.projects)).toBeTrue();
    expect(r.projects.length).toBeGreaterThan(0);
    expect(r.projects[0]).toMatchObject({
      key: expect.any(String),
      name: expect.any(String),
      sessions: expect.any(Number),
    });
  });

  test("git diff：--stat 与 base ref", async () => {
    const hasGit = Bun.which("git") !== null;
    if (!hasGit) return;
    const st = await (await fetch(`${BASE}/api/sessions/${sid}/git/status`, { headers: h(uid) })).json();
    if (!st.branch) return;
    await fetch(`${BASE}/api/sessions/${sid}/file?path=code/main.py`, {
      method: "PUT",
      headers: h(uid),
      body: '{"content":"print(3)\\n"}',
    });
    const stat = await (
      await fetch(`${BASE}/api/sessions/${sid}/git/diff?stat=1&path=code/main.py`, { headers: h(uid) })
    ).json();
    expect(stat.diff).toContain("|");
    const base = await (await fetch(`${BASE}/api/sessions/${sid}/git/diff?base=HEAD`, { headers: h(uid) })).json();
    expect(base.diff).toContain("print(3)");
    const badBase = await fetch(`${BASE}/api/sessions/${sid}/git/diff?base=--evil`, { headers: h(uid) });
    expect(badBase.status).toBe(500); // GIT_FAILED（base 校验拒绝）
  });

  test("分享链接：view 只读 / control 对话写 / 会话绑定 / 吊销 / internal 拒绝", async () => {
    // view token
    const vRes = await fetch(`${BASE}/api/sessions/${sid}/share-link`, {
      method: "POST",
      headers: h(uid),
      body: '{"access":"view"}',
    });
    expect(vRes.status).toBe(201);
    const view = await vRes.json();
    const hv = { "x-share-token": view.token };
    expect((await fetch(`${BASE}/api/sessions/${sid}`, { headers: hv })).status).toBe(200);
    expect((await fetch(`${BASE}/api/sessions/${sid}/state`, { headers: hv })).status).toBe(200);
    // view：写拒绝
    const vPrompt = await (
      await fetch(`${BASE}/api/sessions/${sid}/prompt`, { method: "POST", headers: hv, body: '{"text":"x"}' })
    ).json();
    expect(vPrompt.error.code).toBe("SHARE_VIEW_ONLY");
    // view：绑定会话之外 404；列表面 403
    expect((await fetch(`${BASE}/api/sessions`, { headers: hv })).status).toBe(403);
    const other = await (await fetch(`${BASE}/api/sessions`, { method: "POST", headers: h("u2"), body: "{}" })).json();
    expect((await fetch(`${BASE}/api/sessions/${other.id}`, { headers: hv })).status).toBe(404);
    // view：internal 面 403
    expect((await fetch(`${BASE}/internal/users/${uid}/usage`, { headers: hv })).status).toBe(403);
    // 🔒 view/control：用户级配置面（含明文 apiKey 的 models.yml）一律 403
    expect((await fetch(`${BASE}/api/me/models/config`, { headers: hv })).status).toBe(403);
    expect((await fetch(`${BASE}/api/me/mcp`, { headers: hv })).status).toBe(403);
    expect((await fetch(`${BASE}/api/me/usage?group=day`, { headers: hv })).status).toBe(403);
    expect((await fetch(`${BASE}/api/me/models/test`, { method: "POST", headers: hv, body: "{}" })).status).toBe(403);

    // control token：对话写放行（到达 handler，409=无模型）
    const cRes = await fetch(`${BASE}/api/sessions/${sid}/share-link`, {
      method: "POST",
      headers: h(uid),
      body: '{"access":"control"}',
    });
    const control = await cRes.json();
    const hc = { "x-share-token": control.token };
    const cPrompt = await (
      await fetch(`${BASE}/api/sessions/${sid}/prompt`, { method: "POST", headers: hc, body: '{"text":"hi"}' })
    ).json();
    expect(cPrompt.error.code).toBe("MODEL_UNAVAILABLE");
    // control：非对话写仍受限（如删除）
    expect((await fetch(`${BASE}/api/sessions/${sid}?confirm=${sid}`, { method: "DELETE", headers: hc })).status).toBe(
      403,
    );

    // 吊销后 token 失效
    await fetch(`${BASE}/api/sessions/${sid}/share-link/${view.id}`, { method: "DELETE", headers: h(uid) });
    expect((await fetch(`${BASE}/api/sessions/${sid}`, { headers: hv })).status).toBe(401);
    // 清理 control token
    await fetch(`${BASE}/api/sessions/${sid}/share-link/${control.id}`, { method: "DELETE", headers: h(uid) });
  });

  test("Agent Hub：名册/单查/transcript/chat 501", async () => {
    const roster = await (await fetch(`${BASE}/api/sessions/${sid}/agents`, { headers: h(uid) })).json();
    expect(roster.live).toBe(true);
    expect(Array.isArray(roster.agents)).toBeTrue();
    const missing = await (await fetch(`${BASE}/api/sessions/${sid}/agents/no-such-agent`, { headers: h(uid) })).json();
    expect(missing.error.code).toBe("NOT_FOUND");
    const tr = await (
      await fetch(`${BASE}/api/sessions/${sid}/agents/no-such-agent/transcript`, { headers: h(uid) })
    ).json();
    expect(tr.error.code).toBe("NOT_FOUND");
    const chat = await (
      await fetch(`${BASE}/api/sessions/${sid}/agents/a1/chat`, {
        method: "POST",
        headers: h(uid),
        body: '{"text":"x"}',
      })
    ).json();
    expect(chat.error.code).toBe("NOT_FOUND"); // 未知 agent（chat/kill 已实装，revive 仍 501）
  });

  test("webhooks：注册 → 事件真实投递（HMAC 签名）→ 注销", async () => {
    // 本地接收器
    const received: Array<{ body: string; sig: string | null }> = [];
    const receiver = Bun.serve({
      port: 0,
      fetch: async (req) => {
        received.push({ body: await req.text(), sig: req.headers.get("x-omp-signature") });
        return new Response("ok");
      },
    });
    try {
      // 造一个会触发 publish 的路径：archive（dispose）→ webhook 注册 → unarchive+prompt（复活 publish session.status idle）
      const r = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: h("hook-user"), body: "{}" });
      const hookSid = (await r.json()).id;
      await fetch(`${BASE}/api/sessions/${hookSid}`, {
        method: "PATCH",
        headers: h("hook-user"),
        body: '{"status":"archived"}',
      });

      const wh = await (
        await fetch(`${BASE}/internal/users/hook-user/webhooks`, {
          method: "POST",
          headers: h("admin"),
          body: JSON.stringify({ url: `http://127.0.0.1:${receiver.port}/hook`, events: ["*"] }),
        })
      ).json();
      expect(wh.secret).toBeTruthy();

      await fetch(`${BASE}/api/sessions/${hookSid}`, {
        method: "PATCH",
        headers: h("hook-user"),
        body: '{"status":"active"}',
      });
      await fetch(`${BASE}/api/sessions/${hookSid}/prompt`, {
        method: "POST",
        headers: h("hook-user"),
        body: '{"text":"x"}',
      }); // 复活 → publish

      const deadline = Date.now() + 5000;
      while (received.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      expect(received.length).toBeGreaterThan(0);
      const evt = JSON.parse(received[0].body);
      expect(evt.event.type).toBe("session.status");
      // HMAC 验签（secret 来自注册响应）
      const { createHmac } = await import("node:crypto");
      const expectSig = createHmac("sha256", wh.secret).update(received[0].body).digest("hex");
      expect(received[0].sig).toBe(expectSig);

      await fetch(`${BASE}/internal/webhooks/${wh.id}`, { method: "DELETE", headers: h("admin") });
      const before = received.length;
      await fetch(`${BASE}/api/sessions/${hookSid}/prompt`, {
        method: "POST",
        headers: h("hook-user"),
        body: '{"text":"x"}',
      });
      await new Promise((r) => setTimeout(r, 800));
      expect(received.length).toBe(before); // 注销后不再投递（缓存已失效）
    } finally {
      receiver.stop(true);
    }
  });

  test("models/test：未知模型 404", async () => {
    const r = await (
      await fetch(`${BASE}/api/me/models/test`, {
        method: "POST",
        headers: h("cfg-user"),
        body: '{"provider":"minimax","modelId":"Not-Exist"}',
      })
    ).json();
    expect(r.error.code).toBe("MODEL_NOT_FOUND");
  });

  test("M6 审批流：未启用策略 → 空清单；未知 approval 404", async () => {
    const r = await (await fetch(`${BASE}/api/sessions/${sid}/approvals`, { headers: h(uid) })).json();
    expect(r.live).toBe(true);
    expect(r.approvals).toEqual([]);
    expect(r.policy).toBeNull();
    const decide = await fetch(`${BASE}/api/sessions/${sid}/approvals/ap_unknown`, {
      method: "POST",
      headers: h(uid),
      body: '{"approve":true}',
    });
    expect(decide.status).toBe(404);
  });

  test("M3：异步任务端点 + restore-interrupted", async () => {
    const jobs = await (await fetch(`${BASE}/api/sessions/${sid}/jobs`, { headers: h(uid) })).json();
    expect(jobs.live).toBe(true);
    expect("tree" in jobs && "snapshot" in jobs).toBeTrue();
    const inspect = await (await fetch(`${BASE}/api/sessions/${sid}/jobs/no-such-job`, { headers: h(uid) })).json();
    expect(inspect.error.code).toBe("NOT_FOUND");
    const cancel = await (
      await fetch(`${BASE}/api/sessions/${sid}/jobs/no-such-job/cancel`, { method: "POST", headers: h(uid) })
    ).json();
    expect(cancel.cancelled).toBeFalse();
    const restore = await (
      await fetch(`${BASE}/api/sessions/${sid}/restore-interrupted`, { method: "POST", headers: h(uid) })
    ).json();
    expect("restored" in restore).toBeTrue();
  });

  test("M3：TrashPurger 物理清除（30d 回溯 + 直接执行）", async () => {
    // 建会话 → 写文件 → 删除（trash）→ 回溯 deleted_at → purgeOnce → 文件与行消失
    const r = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: h("purge-user"), body: "{}" });
    const { id: pid } = await r.json();
    await fetch(`${BASE}/api/sessions/${pid}/file?path=doomed.txt`, {
      method: "PUT",
      headers: h("purge-user"),
      body: '{"content":"x"}',
    });
    await fetch(`${BASE}/api/sessions/${pid}?confirm=${pid}`, { method: "DELETE", headers: h("purge-user") });
    const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
    const db = new Database(path.join(dataRoot, "gateway.db"));
    db.run("UPDATE sessions SET deleted_at = ? WHERE id = ?", [old, pid]);
    db.close();

    const { purgeOnce } = await import("../src/jobs/trash-purger.ts");
    const result = await purgeOnce(dataRoot);
    expect(result.sessions).toBeGreaterThanOrEqual(1);

    // 行已删 → 404（ownedSession 查无此行）；文件/目录已物理清除
    expect((await fetch(`${BASE}/api/sessions/${pid}`, { headers: h("purge-user") })).status).toBe(404);
    const { existsSync } = await import("node:fs");
    expect(existsSync(path.join(dataRoot, "users", "purge-user", "workspaces", pid))).toBeFalse();
    expect(existsSync(path.join(dataRoot, "users", "purge-user", "sessions"))).toBeTrue(); // 目录骨架保留
  });

  test("M3：trash 找回（会话 + 用户）", async () => {
    // 会话找回：删 → trash 列表可见 → restore → active 可用
    const r = await fetch(`${BASE}/api/sessions`, {
      method: "POST",
      headers: h("trash-user"),
      body: '{"title":"restore-me"}',
    });
    const { id: tid } = await r.json();
    await fetch(`${BASE}/api/sessions/${tid}?confirm=${tid}`, { method: "DELETE", headers: h("trash-user") });
    const trash = await (await fetch(`${BASE}/internal/trash`, { headers: h("admin") })).json();
    expect(trash.sessions.some((s: any) => s.id === tid)).toBeTrue();
    const restore = await fetch(`${BASE}/internal/trash/sessions/${tid}/restore`, {
      method: "POST",
      headers: h("admin"),
    });
    expect(restore.status).toBe(200);
    const detail = await (await fetch(`${BASE}/api/sessions/${tid}`, { headers: h("trash-user") })).json();
    expect(detail.status).toBe("active");
    expect(detail.deleted_at).toBeNull();
    // 再删 → purge 后找回失败（行已清）
    await fetch(`${BASE}/api/sessions/${tid}?confirm=${tid}`, { method: "DELETE", headers: h("trash-user") });
    const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
    const db = new Database(path.join(dataRoot, "gateway.db"));
    db.run("UPDATE sessions SET deleted_at = ? WHERE id = ?", [old, tid]);
    db.close();
    await (await import("../src/jobs/trash-purger.ts")).purgeOnce(dataRoot);
    const restoreGone = await fetch(`${BASE}/internal/trash/sessions/${tid}/restore`, {
      method: "POST",
      headers: h("admin"),
    });
    expect(restoreGone.status).toBe(404);

    // 用户找回
    await fetch(`${BASE}/internal/users/restore-user/provision`, { method: "POST", headers: h("admin") });
    await fetch(`${BASE}/internal/users/restore-user?confirm=restore-user`, { method: "DELETE", headers: h("admin") });
    const users = await (await fetch(`${BASE}/internal/trash`, { headers: h("admin") })).json();
    expect(users.users.some((u: any) => u.user_id === "restore-user")).toBeTrue();
    const uRestore = await fetch(`${BASE}/internal/trash/users/restore-user/restore`, {
      method: "POST",
      headers: h("admin"),
    });
    expect(uRestore.status).toBe(200);
    // 找回后可正常建会话
    expect(
      (await fetch(`${BASE}/api/sessions`, { method: "POST", headers: h("restore-user"), body: "{}" })).status,
    ).toBe(201);
  });

  test("M3：Agent Hub chat/kill 错误面（无子代理时）", async () => {
    const chat = await (
      await fetch(`${BASE}/api/sessions/${sid}/agents/no-agent/chat`, {
        method: "POST",
        headers: h(uid),
        body: '{"text":"x"}',
      })
    ).json();
    expect(chat.error.code).toBe("NOT_FOUND");
    const kill = await (
      await fetch(`${BASE}/api/sessions/${sid}/agents/no-agent/kill`, { method: "POST", headers: h(uid) })
    ).json();
    expect(kill.error.code).toBe("NOT_FOUND");
    const revive = await (
      await fetch(`${BASE}/api/sessions/${sid}/agents/no-agent/revive`, { method: "POST", headers: h(uid) })
    ).json();
    expect(revive.error.code).toBe("NOT_FOUND");
    const chatNoBody = await fetch(`${BASE}/api/sessions/${sid}/agents/whatever/chat`, {
      method: "POST",
      headers: h(uid),
      body: "{}",
    });
    expect(chatNoBody.status).toBe(400);
  });

  test("M4：零 turn 会话快照 → 409 SNAPSHOT_EMPTY；pre_delete 自动快照随 trash 找回可查", async () => {
    const r = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: h("snap-user"), body: "{}" });
    const { id: ssid } = await r.json();
    // 无 JSONL（零 turn）：手动快照 → 409 SNAPSHOT_EMPTY
    const empty = await (
      await fetch(`${BASE}/api/sessions/${ssid}/snapshots`, {
        method: "POST",
        headers: h("snap-user"),
        body: '{"name":"x"}',
      })
    ).json();
    expect(empty.error.code).toBe("SNAPSHOT_EMPTY");
    // 删除会话：pre_delete 快照也会因无文件跳过（不报错）
    const del = await fetch(`${BASE}/api/sessions/${ssid}?confirm=${ssid}`, {
      method: "DELETE",
      headers: h("snap-user"),
    });
    expect(del.status).toBe(200);
  });

  test("契约：/openapi.json 生成 + events schema 文件有效", async () => {
    const spec = await (await fetch(`${BASE}/openapi.json`)).json();
    expect(spec.openapi).toBe("3.1.0");
    const pathCount = Object.keys(spec.paths).length;
    expect(pathCount).toBeGreaterThan(40);
    expect(spec.paths["/api/sessions"]).toBeTruthy();
    expect(spec.paths["/internal/users/{uid}/provision"]).toBeTruthy();
    expect(spec.components.securitySchemes.shareToken.name).toBe("x-share-token");
    expect(spec["x-gateway-events"].types).toContain("turn.completed");

    const schema = JSON.parse(
      await Bun.file(path.join(import.meta.dir, "..", "..", "contracts", "gateway-events.v1.schema.json")).text(),
    );
    expect(schema.properties.type.enum).toContain("agents.changed");
  });

  test("配置资源：me/mcp 与 me/models/config 读写往返 + credentials 注入", async () => {
    const cp = await (
      await fetch(`${BASE}/api/sessions/${sid}/compact`, { method: "POST", headers: h(uid), body: "{}" })
    ).json();
    expect(cp.error).toBeTruthy();

    const fk = await fetch(`${BASE}/api/sessions/${sid}/fork`, {
      method: "POST",
      headers: h(uid),
      body: '{"title":"forked"}',
    });
    if (fk.status !== 201) console.error("FORK FAIL BODY:", JSON.stringify(await fk.clone().json()));
    expect(fk.status).toBe(201);
    const forkBody = await fk.json();
    expect(forkBody.parentId).toBe(sid);
    expect(forkBody.workspaceId).toBe(forkBody.id); // 分叉会话有自己的 workspace
    const detail = await (await fetch(`${BASE}/api/sessions/${forkBody.id}`, { headers: h(uid) })).json();
    expect(detail.parent_id).toBe(sid);
    expect(detail.live.present).toBe(true);
    // workspace 拷贝：源 workspace 里的文件在分叉 workspace 中存在
    const forkTree = await (
      await fetch(`${BASE}/api/sessions/${forkBody.id}/file?path=docs/hello.md`, { headers: h(uid) })
    ).json();
    expect(forkTree.encoding).toBe("utf8");
    // 归属：他人不可见
    expect((await fetch(`${BASE}/api/sessions/${forkBody.id}`, { headers: h("u2") })).status).toBe(404);
  });

  test("SDK 桥：follow-up 与 custom message 通道", async () => {
    const fu = await fetch(`${BASE}/api/sessions/${sid}/follow-up`, {
      method: "POST",
      headers: h(uid),
      body: '{"text":"later please"}',
    });
    expect(fu.status).toBe(202);
    const cm = await fetch(`${BASE}/api/sessions/${sid}/messages/custom`, {
      method: "POST",
      headers: h(uid),
      body: JSON.stringify({ payload: { customType: "note", content: "hello extension protocol" } }),
    });
    expect(cm.status).toBe(202);
    const badDeliver = await fetch(`${BASE}/api/sessions/${sid}/messages/custom`, {
      method: "POST",
      headers: h(uid),
      body: '{"payload":"x","deliverAs":"bogus"}',
    });
    expect(badDeliver.status).toBe(400);
  });

  test("SDK 桥：stats/mcp/lsp/skills/队列操作/reset/cycle", async () => {
    // stats：结构完整（计数受共享 describe 内此前用例影响，只断形状）
    const stats = await (await fetch(`${BASE}/api/sessions/${sid}/stats`, { headers: h(uid) })).json();
    expect(typeof stats.totalMessages).toBe("number");
    expect(stats.tokens).toMatchObject({ input: 0, output: 0, total: 0 });
    expect(stats.sessionFile).toBeTruthy();

    // mcp / lsp：会话级发现项
    const mcp = await (await fetch(`${BASE}/api/sessions/${sid}/mcp`, { headers: h(uid) })).json();
    expect(mcp.connectedServers).toEqual([]);
    expect(mcp.live).toBe(true);
    const lsp = await (await fetch(`${BASE}/api/sessions/${sid}/lsp`, { headers: h(uid) })).json();
    expect(Array.isArray(lsp.servers)).toBeTrue();

    // skills：结构存在（数量取决于 agentDir 内容，可为空）
    const skills = await (await fetch(`${BASE}/api/sessions/${sid}/skills`, { headers: h(uid) })).json();
    expect(skills).toBeTruthy();

    // 队列移除：空队列 → removed false
    const qr = await (
      await fetch(`${BASE}/api/sessions/${sid}/queue/remove`, {
        method: "POST",
        headers: h(uid),
        body: '{"text":"x","queue":"followUp"}',
      })
    ).json();
    expect(qr.removed).toBeFalse();
    const badQr = await fetch(`${BASE}/api/sessions/${sid}/queue/remove`, {
      method: "POST",
      headers: h(uid),
      body: '{"text":"x","queue":"bogus"}',
    });
    expect(badQr.status).toBe(400);

    // cycle：无 scopedModels → switched null；thinking cycle 幂等返回
    const cm = await (
      await fetch(`${BASE}/api/sessions/${sid}/cycle-model`, { method: "POST", headers: h(uid), body: "{}" })
    ).json();
    expect(cm.switched).toBeNull();
    expect(cm.model).toBeNull();
    const ct = await (
      await fetch(`${BASE}/api/sessions/${sid}/cycle-thinking`, { method: "POST", headers: h(uid), body: "{}" })
    ).json();
    expect("current" in ct).toBeTrue();

    // 会话名（SDK 层）
    const nm = await (
      await fetch(`${BASE}/api/sessions/${sid}/name`, {
        method: "POST",
        headers: h(uid),
        body: '{"name":"gw-session"}',
      })
    ).json();
    expect(nm.ok).toBeTrue();

    // handoff（无模型）→ 409 可读错误；reset → 200
    const ho = await (
      await fetch(`${BASE}/api/sessions/${sid}/handoff`, { method: "POST", headers: h(uid), body: "{}" })
    ).json();
    expect(ho.error).toBeTruthy();
    const rs = await fetch(`${BASE}/api/sessions/${sid}/reset`, { method: "POST", headers: h(uid) });
    expect(rs.status).toBe(200);
  });

  test("图片输入：非法形状 400、合法形状进入 SDK（无模型 → 409）", async () => {
    const bad = await fetch(`${BASE}/api/sessions/${sid}/prompt`, {
      method: "POST",
      headers: h(uid),
      body: JSON.stringify({ text: "look", images: [{ data: "not-base64!!", mimeType: "image/png" }] }),
    });
    expect(bad.status).toBe(400);
    const good = await fetch(`${BASE}/api/sessions/${sid}/prompt`, {
      method: "POST",
      headers: h(uid),
      body: JSON.stringify({
        text: "look",
        images: [{ data: Buffer.from("png").toString("base64"), mimeType: "image/png" }],
      }),
    });
    expect(good.status).toBe(409); // 通过校验，到达 SDK 后因无模型 409
    expect(((await good.json()) as any).error.code).toBe("MODEL_UNAVAILABLE");
  });

  test("创建选项：restrictTools/thinkingLevel/enableMcp=false 生效", async () => {
    const r = await fetch(`${BASE}/api/sessions`, {
      method: "POST",
      headers: h("opt-user"),
      body: JSON.stringify({
        restrictNote: 1,
        tools: ["read", "grep", "glob"],
        thinkingLevel: "low",
        enableMcp: false,
      }),
    });
    expect(r.status).toBe(201);
    const { id: osid } = await r.json();
    const st = await (await fetch(`${BASE}/api/sessions/${osid}/state`, { headers: h("opt-user") })).json();
    expect(st.thinkingLevel).toBe("low");
    expect(st.tools.active.sort()).toEqual(["glob", "grep", "read"]);
    const mcp = await (await fetch(`${BASE}/api/sessions/${osid}/mcp`, { headers: h("opt-user") })).json();
    expect(mcp.connectedServers).toEqual([]);

    // additionalDirectories 逃逸拒绝
    const esc = await fetch(`${BASE}/api/sessions`, {
      method: "POST",
      headers: h("opt-user"),
      body: JSON.stringify({ additionalDirectories: ["../../etc"] }),
    });
    expect(esc.status).toBe(400);
    // 用户根内合法
    const ok = await fetch(`${BASE}/api/sessions`, {
      method: "POST",
      headers: h("opt-user"),
      body: JSON.stringify({ additionalDirectories: ["workspaces"] }),
    });
    expect(ok.status).toBe(201);
  });

  test("配置资源：me/mcp 与 me/models/config 读写往返 + credentials 注入", async () => {
    const mcpGet = await (await fetch(`${BASE}/api/me/mcp`, { headers: h("cfg-user") })).json();
    expect(mcpGet.mcpServers).toEqual({});
    const mcpPut = await fetch(`${BASE}/api/me/mcp`, {
      method: "PUT",
      headers: h("cfg-user"),
      body: JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "uvx", args: ["mcp-server-fs"] } } }),
    });
    expect(mcpPut.status).toBe(200);
    const mcpGet2 = await (await fetch(`${BASE}/api/me/mcp`, { headers: h("cfg-user") })).json();
    expect(mcpGet2.mcpServers.fs.command).toBe("uvx");
    const mcpBad = await fetch(`${BASE}/api/me/mcp`, { method: "PUT", headers: h("cfg-user"), body: "{nope" });
    expect(mcpBad.status).toBe(400);

    const cfgPut = await fetch(`${BASE}/api/me/models/config`, {
      method: "PUT",
      headers: h("cfg-user"),
      body: "providers:\n  minimax:\n    baseUrl: https://api.minimax.cn/v1\n    api: openai-completions\n    models:\n      - id: MiniMax-M3.1-Flash\n",
    });
    expect(cfgPut.status).toBe(200);
    const cfgGet = await (await fetch(`${BASE}/api/me/models/config`, { headers: h("cfg-user") })).text();
    expect(cfgGet).toContain("minimax");

    const cred = await fetch(`${BASE}/api/me/models/credentials`, {
      method: "POST",
      headers: h("cfg-user"),
      body: '{"provider":"minimax","apiKey":"sk-test-merged"}',
    });
    expect(cred.status).toBe(200);
    const cfgGet2 = await (await fetch(`${BASE}/api/me/models/config`, { headers: h("cfg-user") })).text();
    expect(cfgGet2).toContain("apiKey: sk-test-merged");
    // models.yml 语法未被破坏（YAML 合并逻辑健全性）
    expect(cfgGet2).toContain("baseUrl: https://api.minimax.cn/v1");
  });
});
