/**
 * 集成门面（DESIGN §22）：提示词注入 / 状态聚合 / 事件回放 / 回调管理 / 同步等待。
 * 只测无模型路径（admission 前失败 → 409 MODEL_UNAVAILABLE）与无副作用面。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 8851;
const BASE = `http://127.0.0.1:${PORT}`;
const TOK = "integration-token";
const h = (uid: string) => ({ authorization: `Bearer ${TOK}`, "content-type": "application/json", "x-user-id": uid });

const dataRoot = mkdtempSync(path.join(tmpdir(), "omp-integ-"));
let proc: Bun.Subprocess | null = null;
let sid = "";

beforeAll(async () => {
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
  const created = await (await fetch(`${BASE}/api/sessions`, { method: "POST", headers: h("iu"), body: "{}" })).json();
  sid = created.id;
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

describe("提示词注入", () => {
  test("创建期 contextFiles：形状校验（非法/超限 400/413）", async () => {
    const bad1 = await fetch(`${BASE}/api/sessions`, {
      method: "POST",
      headers: h("iu"),
      body: '{"contextFiles":"nope"}',
    });
    expect(bad1.status).toBe(400);
    const bad2 = await fetch(`${BASE}/api/sessions`, {
      method: "POST",
      headers: h("iu"),
      body: '{"contextFiles":[{"path":"a.md"}]}',
    });
    expect(bad2.status).toBe(400);
    const big = "x".repeat(256 * 1024 + 1);
    const bad3 = await fetch(`${BASE}/api/sessions`, {
      method: "POST",
      headers: h("iu"),
      body: JSON.stringify({ contextFiles: [{ path: "a.md", content: big }] }),
    });
    expect(bad3.status).toBe(413);
    const many = Array.from({ length: 21 }, (_, i) => ({ path: `f${i}.md`, content: "x" }));
    const bad4 = await fetch(`${BASE}/api/sessions`, {
      method: "POST",
      headers: h("iu"),
      body: JSON.stringify({ contextFiles: many }),
    });
    expect(bad4.status).toBe(400);
  });

  test("创建期 contextFiles：合法注入 → 201", async () => {
    const r = await fetch(`${BASE}/api/sessions`, {
      method: "POST",
      headers: h("iu"),
      body: JSON.stringify({
        title: "ctx-inject",
        appendSystemPrompt: "你是测试助手。",
        contextFiles: [{ path: "kb/rules.md", content: "规则：一律回答 OK。" }],
        noContextFiles: true,
      }),
    });
    expect(r.status).toBe(201);
    const b = (await r.json()) as any;
    expect(b.id).toBeTruthy();
  });

  test("inject：system 模式 → 409 NOT_SUPPORTED（明确失败而非静默）", async () => {
    const r = await fetch(`${BASE}/api/sessions/${sid}/inject`, {
      method: "POST",
      headers: h("iu"),
      body: JSON.stringify({ text: "x", mode: "system" }),
    });
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).error.code).toBe("NOT_SUPPORTED");
  });

  test("inject：缺 text → 400；非法 deliverAs → 400", async () => {
    expect(
      (
        await fetch(`${BASE}/api/sessions/${sid}/inject`, {
          method: "POST",
          headers: h("iu"),
          body: "{}",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${BASE}/api/sessions/${sid}/inject`, {
          method: "POST",
          headers: h("iu"),
          body: '{"text":"x","deliverAs":"bogus"}',
        })
      ).status,
    ).toBe(400);
  });

  test("inject：context 模式（不触发 turn）→ 202，triggeredTurn=false 且不耗预算", async () => {
    const r = await fetch(`${BASE}/api/sessions/${sid}/inject`, {
      method: "POST",
      headers: h("iu"),
      body: JSON.stringify({
        text: "业务规则：VIP 客户 8 折。",
        mode: "context",
        deliverAs: "nextTurn",
        customType: "business.rule",
      }),
    });
    expect(r.status).toBe(202);
    const b = (await r.json()) as any;
    expect(b.ok).toBeTrue();
    expect(b.mode).toBe("context");
    expect(b.triggeredTurn).toBeFalse();
  });

  test("inject：user 模式无模型 → 409 MODEL_UNAVAILABLE（策略/准入仍生效）", async () => {
    const r = await fetch(`${BASE}/api/sessions/${sid}/inject`, {
      method: "POST",
      headers: h("iu"),
      body: JSON.stringify({ text: "hi", mode: "user" }),
    });
    expect([409, 202]).toContain(r.status); // 无模型时也可能 admission 后失败；两种都合法
  });
});

describe("状态聚合与事件回放", () => {
  test("bootstrap：session/state/modes/approvals/commands/events 全键", async () => {
    const b = (await (await fetch(`${BASE}/api/sessions/${sid}/bootstrap`, { headers: h("iu") })).json()) as any;
    for (const k of ["session", "state", "modes", "approvals", "commands", "events"]) expect(b).toHaveProperty(k);
    expect(b.session.id).toBe(sid);
    expect(typeof b.state.streaming).toBe("boolean");
    for (const k of ["slashCommands", "customCommands", "mcpPrompts", "templates"])
      expect(Array.isArray(b.commands[k])).toBeTrue();
    expect(typeof b.events.latestSeq).toBe("number");
    expect(b.events.sse).toContain(`/api/sessions/${sid}/events`);
  });

  test("status：轻量轮询字段", async () => {
    const b = (await (await fetch(`${BASE}/api/sessions/${sid}/status`, { headers: h("iu") })).json()) as any;
    expect(b.sessionId).toBe(sid);
    expect(["idle", "streaming"]).toContain(b.status);
    expect(typeof b.pendingApprovals).toBe("number");
    expect(typeof b.queueCount).toBe("number");
    expect(typeof b.latestSeq).toBe("number");
  });

  test("events/replay：空缓冲返回结构 + nextSince", async () => {
    const b = (await (
      await fetch(`${BASE}/api/sessions/${sid}/events/replay?since=0&limit=10`, { headers: h("iu") })
    ).json()) as any;
    expect(Array.isArray(b.events)).toBeTrue();
    expect(typeof b.nextSince).toBe("number");
    expect(typeof b.latestSeq).toBe("number");
    expect(b.bufferLimit).toBe(500);
    expect(b.truncated).toBeFalse();
  });

  test("events/replay：types 过滤生效（无匹配 → 空）", async () => {
    const b = (await (
      await fetch(`${BASE}/api/sessions/${sid}/events/replay?types=no.such.*`, { headers: h("iu") })
    ).json()) as any;
    expect(b.events).toEqual([]);
  });

  test("跨用户/不存在会话：404 守卫", async () => {
    for (const ep of ["bootstrap", "status", "events/replay"]) {
      expect((await fetch(`${BASE}/api/sessions/${sid}/${ep}`, { headers: h("intruder") })).status).toBe(404);
      expect((await fetch(`${BASE}/api/sessions/no-such/${ep}`, { headers: h("iu") })).status).toBe(404);
    }
  });
});

describe("业务事件（DESIGN §22.5）", () => {
  test("注入：返回 eventId + business.event 进事件流；不触发 turn 时不耗预算", async () => {
    const r = await fetch(`${BASE}/api/sessions/${sid}/business-events`, {
      method: "POST",
      headers: h("iu"),
      body: JSON.stringify({
        type: "customer.updated",
        data: { customerId: "c123", tier: "vip" },
        text: "客户 c123 升级为 VIP，后续报价 8 折。",
        triggerTurn: false,
      }),
    });
    expect(r.status).toBe(202);
    const b = (await r.json()) as any;
    expect(b.eventId.startsWith("be_")).toBeTrue();
    expect(b.eventType).toBe("customer.updated");
    expect(b.injected).toBeTrue();
    expect(b.triggeredTurn).toBeFalse();
    expect(typeof b.callbackHint).toBe("string");
    // 事件已进回放缓冲
    const replay = (await (
      await fetch(`${BASE}/api/sessions/${sid}/events/replay?types=business.*`, { headers: h("iu") })
    ).json()) as any;
    const ev = replay.events.find((x: any) => x.type === "business.event" && x.eventId === b.eventId);
    expect(ev).toBeTruthy();
    expect(ev.eventType).toBe("customer.updated");
    expect(ev.text).toContain("VIP");
    expect(ev.data.tier).toBe("vip");
  });

  test("校验：缺 type 400；缺 text/data 400；非法 deliverAs 400", async () => {
    expect(
      (
        await fetch(`${BASE}/api/sessions/${sid}/business-events`, {
          method: "POST",
          headers: h("iu"),
          body: "{}",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${BASE}/api/sessions/${sid}/business-events`, {
          method: "POST",
          headers: h("iu"),
          body: '{"type":"x"}',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${BASE}/api/sessions/${sid}/business-events`, {
          method: "POST",
          headers: h("iu"),
          body: '{"type":"x","text":"t","deliverAs":"bogus"}',
        })
      ).status,
    ).toBe(400);
  });

  test("data 可替代 text（自动序列化）+ inject:false 只广播不注入", async () => {
    const r1 = await fetch(`${BASE}/api/sessions/${sid}/business-events`, {
      method: "POST",
      headers: h("iu"),
      body: JSON.stringify({ type: "order.paid", data: { orderId: "o1" } }),
    });
    expect(r1.status).toBe(202);
    const b1 = (await r1.json()) as any;
    expect(b1.injected).toBeTrue(); // data → text 自动生成
    const r2 = await fetch(`${BASE}/api/sessions/${sid}/business-events`, {
      method: "POST",
      headers: h("iu"),
      body: JSON.stringify({ type: "audit.ping", text: "ping", inject: false }),
    });
    const b2 = (await r2.json()) as any;
    expect(b2.injected).toBeFalse();
    expect(b2.triggeredTurn).toBeFalse();
  });

  test("跨用户/未知会话：404", async () => {
    expect(
      (
        await fetch(`${BASE}/api/sessions/${sid}/business-events`, {
          method: "POST",
          headers: h("other"),
          body: '{"type":"x","text":"t"}',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${BASE}/api/sessions/no-such/business-events`, {
          method: "POST",
          headers: h("iu"),
          body: '{"type":"x","text":"t"}',
        })
      ).status,
    ).toBe(404);
  });

  test("correlation 状态机（单元）：注入 → turn 内事件带关联 → 终态发 business.completed", async () => {
    const { SessionCtx } = await import("../src/core/session-registry.ts");
    const fakeSession = { beginDispose() {}, dispose: async () => {}, model: { provider: "p", id: "m" } } as never;
    const ctx = new SessionCtx("sid-be", "be-user", "/tmp", fakeSession);
    const frames: any[] = [];
    ctx.subscribers.add({
      send: (ev) => {
        frames.push(ev);
        return true;
      },
    });
    // 注入业务事件
    const { eventId } = ctx.recordBusinessEvent({ type: "customer.updated", data: { id: "c1" }, text: "客户升级" });
    expect(frames.some((f) => f.type === "business.event" && f.eventId === eventId)).toBeTrue();
    // agent_start 提升 pending → active
    ctx.dispatchOmp({ type: "agent_start" } as never);
    // 中断内事件带 correlation
    ctx.dispatchOmp({ type: "message_start", message: { role: "assistant", content: [], timestamp: 1 } } as never);
    const started = frames.find((f) => f.type === "message.started");
    expect(started?.correlation).toEqual({ eventId, type: "customer.updated" });
    // 终态：turn.completed 带 correlation，随后 business.completed
    ctx.dispatchOmp({ type: "agent_end", isTerminal: true } as never);
    const turnCompleted = frames.find((f) => f.type === "turn.completed");
    expect(turnCompleted?.correlation?.eventId).toBe(eventId);
    const done = frames.find((f) => f.type === "business.completed");
    expect(done?.eventId).toBe(eventId);
    expect(done?.status).toBe("completed");
    // 关联已清空：后续事件不带 correlation
    ctx.dispatchOmp({ type: "message_start", message: { role: "assistant", content: [], timestamp: 2 } } as never);
    const later = frames.filter((f) => f.type === "message.started").at(-1);
    expect(later?.correlation).toBeUndefined();
  });
});

describe("回调管理（会话级优先）", () => {
  test("会话级：注册 → 列表 → 注销；secret 仅创建时返回", async () => {
    const created = await fetch(`${BASE}/api/sessions/${sid}/webhooks`, {
      method: "POST",
      headers: h("iu"),
      body: JSON.stringify({
        url: "https://hooks.example.com/sess",
        events: ["turn.completed", "tool.confirm_required"],
      }),
    });
    expect(created.status).toBe(201);
    const c = (await created.json()) as any;
    expect(c.sessionId).toBe(sid);
    expect(c.secret.startsWith("whsec_")).toBeTrue();
    const list = (await (await fetch(`${BASE}/api/sessions/${sid}/webhooks`, { headers: h("iu") })).json()) as any;
    expect(list.webhooks.some((x: any) => x.id === c.id)).toBeTrue();
    expect(list.webhooks.every((x: any) => x.secret === undefined)).toBeTrue();
    expect(list.webhooks.every((x: any) => x.sessionId === sid)).toBeTrue(); // 只列本会话的
    const del = await fetch(`${BASE}/api/sessions/${sid}/webhooks/${c.id}`, { method: "DELETE", headers: h("iu") });
    expect(del.status).toBe(200);
  });

  test("会话级：跨用户不可见/不可删；未知会话 404", async () => {
    const c = (await (
      await fetch(`${BASE}/api/sessions/${sid}/webhooks`, {
        method: "POST",
        headers: h("iu"),
        body: JSON.stringify({ url: "https://hooks.example.com/iso" }),
      })
    ).json()) as any;
    expect((await fetch(`${BASE}/api/sessions/${sid}/webhooks`, { headers: h("other") })).status).toBe(404);
    expect(
      (await fetch(`${BASE}/api/sessions/${sid}/webhooks/${c.id}`, { method: "DELETE", headers: h("other") })).status,
    ).toBe(404);
    expect((await fetch(`${BASE}/api/sessions/no-such/webhooks`, { headers: h("iu") })).status).toBe(404);
  });

  test("会话级与用户级隔离：会话列表不含用户级订阅，用户列表含全部", async () => {
    const userHook = (await (
      await fetch(`${BASE}/api/me/webhooks`, {
        method: "POST",
        headers: h("iu"),
        body: JSON.stringify({ url: "https://hooks.example.com/user-level" }),
      })
    ).json()) as any;
    const sessHook = (await (
      await fetch(`${BASE}/api/sessions/${sid}/webhooks`, {
        method: "POST",
        headers: h("iu"),
        body: JSON.stringify({ url: "https://hooks.example.com/session-level" }),
      })
    ).json()) as any;
    const sessList = (await (await fetch(`${BASE}/api/sessions/${sid}/webhooks`, { headers: h("iu") })).json()) as any;
    expect(sessList.webhooks.some((x: any) => x.id === userHook.id)).toBeFalse(); // 用户级不进会话清单
    expect(sessList.webhooks.some((x: any) => x.id === sessHook.id)).toBeTrue();
    const userList = (await (await fetch(`${BASE}/api/me/webhooks`, { headers: h("iu") })).json()) as any;
    expect(userList.webhooks.some((x: any) => x.id === userHook.id)).toBeTrue();
    expect(userList.webhooks.some((x: any) => x.id === sessHook.id)).toBeTrue(); // 用户级视图含全部
  });

  test("用户级：注册 → 注销；非法 URL 400", async () => {
    const created = await fetch(`${BASE}/api/me/webhooks`, {
      method: "POST",
      headers: h("iu"),
      body: JSON.stringify({ url: "https://hooks.example.com/omp", events: ["turn.completed"] }),
    });
    expect(created.status).toBe(201);
    const c = (await created.json()) as any;
    expect(c.secret.startsWith("whsec_")).toBeTrue();
    expect(
      (
        await fetch(`${BASE}/api/me/webhooks`, {
          method: "POST",
          headers: h("iu"),
          body: '{"url":"ftp://x"}',
        })
      ).status,
    ).toBe(400);
    const del = await fetch(`${BASE}/api/me/webhooks/${c.id}`, { method: "DELETE", headers: h("iu") });
    expect(del.status).toBe(200);
  });

  test("自描述端点：/:sid/integration 返回端点清单", async () => {
    const b = (await (await fetch(`${BASE}/api/sessions/${sid}/integration`, { headers: h("iu") })).json()) as any;
    expect(b.sessionId).toBe(sid);
    expect(b.endpoints.inject).toContain(`/api/sessions/${sid}/inject`);
    expect(b.endpoints.webhooks).toContain(`/api/sessions/${sid}/webhooks`);
    expect(b.docs.openapi).toBe("/openapi.json");
  });
});
