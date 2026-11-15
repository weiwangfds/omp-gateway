/**
 * 网页控制台数据面（DESIGN §21）+ gateway-events v1.2 测试。
 * 覆盖：命令面板、模型选择器、todo、上下文、模式面板、细粒度中断、队列整清、
 * 标题生成、分叉树、/me/models 目录、v1.2 事件归一化矩阵。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { normalizeOmpEvent } from "../src/core/events.ts";

const PORT = 8831;
const BASE = `http://127.0.0.1:${PORT}`;
const TOK = "console-token";
const h = (uid: string) => ({ authorization: `Bearer ${TOK}`, "content-type": "application/json", "x-user-id": uid });

const dataRoot = mkdtempSync(path.join(tmpdir(), "omp-console-"));
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
  const created = await (await fetch(`${BASE}/api/sessions`, { method: "POST", headers: h("cu"), body: "{}" })).json();
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

// ---- CORS（浏览器直连集成面）----
describe("集成面：CORS 白名单", () => {
  const PORT3 = 8832;
  const BASE3 = `http://127.0.0.1:${PORT3}`;
  const dataRoot3 = mkdtempSync(path.join(tmpdir(), "omp-cors-"));
  let proc3: Bun.Subprocess | null = null;

  beforeAll(async () => {
    proc3 = Bun.spawn([process.execPath, "run", "src/index.ts"], {
      cwd: path.resolve(import.meta.dir, ".."),
      env: {
        ...process.env,
        GATEWAY_PORT: String(PORT3),
        GATEWAY_DATA_ROOT: dataRoot3,
        GATEWAY_SERVICE_TOKENS: "cors-token",
        GATEWAY_CORS_ORIGINS: "http://app.example.com",
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`${BASE3}/healthz`)).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 300));
    }
  }, 25_000);

  afterAll(() => {
    if (!proc3) return;
    try {
      proc3.kill();
    } catch {}
    try {
      Bun.spawnSync(["taskkill", "/F", "/T", "/PID", String(proc3.pid)]);
    } catch {}
  });

  test("预检：白名单 origin → 204 + CORS 头；非白名单 → 无 CORS 头", async () => {
    const ok = await fetch(`${BASE3}/api/sessions`, {
      method: "OPTIONS",
      headers: { origin: "http://app.example.com", "access-control-request-method": "GET" },
    });
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://app.example.com");
    expect(ok.headers.get("access-control-allow-headers") ?? "").toContain("x-user-id");
    const bad = await fetch(`${BASE3}/api/sessions`, {
      method: "OPTIONS",
      headers: { origin: "http://evil.example.net", "access-control-request-method": "GET" },
    });
    expect(bad.status).toBe(204);
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("普通请求：白名单 origin 回显 Allow-Origin（预检不经认证）", async () => {
    const r = await fetch(`${BASE3}/healthz`, { headers: { origin: "http://app.example.com" } });
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe("http://app.example.com");
  });
});

describe("控制台：只读面板", () => {
  test("commands：四类命令清单形状", async () => {
    const r = await fetch(`${BASE}/api/sessions/${sid}/commands`, { headers: h("cu") });
    expect(r.status).toBe(200);
    const b = (await r.json()) as any;
    for (const k of ["slashCommands", "customCommands", "mcpPrompts", "templates"]) {
      expect(Array.isArray(b[k])).toBeTrue();
    }
  });

  test("models：models 目录 + current/thinkingLevels", async () => {
    const b = (await (await fetch(`${BASE}/api/sessions/${sid}/models`, { headers: h("cu") })).json()) as any;
    expect(Array.isArray(b.models)).toBeTrue();
    expect(b).toHaveProperty("current");
    expect(Array.isArray(b.thinkingLevels)).toBeTrue();
    expect(Array.isArray(b.effortSelectors)).toBeTrue();
  });

  test("todos：phases 数组", async () => {
    const b = (await (await fetch(`${BASE}/api/sessions/${sid}/todos`, { headers: h("cu") })).json()) as any;
    expect(Array.isArray(b.phases)).toBeTrue();
  });

  test("context：usage/breakdown 键存在", async () => {
    const r = await fetch(`${BASE}/api/sessions/${sid}/context`, { headers: h("cu") });
    expect(r.status).toBe(200);
    const b = (await r.json()) as any;
    expect(b).toHaveProperty("usage");
    expect(b).toHaveProperty("breakdown");
  });

  test("modes：面板键全集 + 布尔量类型", async () => {
    const b = (await (await fetch(`${BASE}/api/sessions/${sid}/modes`, { headers: h("cu") })).json()) as any;
    for (const k of ["plan", "goal", "vibe", "prewalk", "checkpoint", "lastRewind", "usageLimit", "serviceTier"]) {
      expect(b).toHaveProperty(k);
    }
    expect(typeof b.isCompacting).toBe("boolean");
    expect(typeof b.isRetrying).toBe("boolean");
  });

  test("plan：state/referencePath", async () => {
    const b = (await (await fetch(`${BASE}/api/sessions/${sid}/plan`, { headers: h("cu") })).json()) as any;
    expect(b).toHaveProperty("state");
    expect(b).toHaveProperty("referencePath");
  });

  test("maintenance：自动压缩/重试/缓存状态", async () => {
    const b = (await (await fetch(`${BASE}/api/sessions/${sid}/maintenance`, { headers: h("cu") })).json()) as any;
    for (const k of ["autoCompaction", "autoRetry", "cacheWarming", "promptCache"]) expect(b).toHaveProperty(k);
  });

  test("session-tree：leafId + 树形结构（含系统条目）", async () => {
    const b = (await (await fetch(`${BASE}/api/sessions/${sid}/session-tree`, { headers: h("cu") })).json()) as any;
    expect(b).toHaveProperty("leafId");
    expect(Array.isArray(b.tree)).toBeTrue();
  });

  test("/api/me/models：目录清单 + providers 去重", async () => {
    const b = (await (await fetch(`${BASE}/api/me/models`, { headers: h("cu") })).json()) as any;
    expect(Array.isArray(b.models)).toBeTrue();
    expect(Array.isArray(b.providers)).toBeTrue();
    expect(b.total).toBe(b.models.length);
    // 元素形状（无模型配置时为空数组也算通过）
    for (const m of b.models.slice(0, 3)) {
      expect(typeof m.provider).toBe("string");
      expect(typeof m.modelId).toBe("string");
    }
  });

  test("skills：新增 promptSkills/warnings/settings 字段", async () => {
    const b = (await (await fetch(`${BASE}/api/sessions/${sid}/skills`, { headers: h("cu") })).json()) as any;
    expect(Array.isArray(b.skills)).toBeTrue();
    expect(typeof b.total).toBe("number");
    expect(Array.isArray(b.promptSkills)).toBeTrue();
    expect(Array.isArray(b.warnings)).toBeTrue();
  });
});

describe("控制台：写端点", () => {
  test("interrupt：非法 target 400；合法 target 200 且列出已中断通道", async () => {
    const bad = await fetch(`${BASE}/api/sessions/${sid}/interrupt`, {
      method: "POST",
      headers: h("cu"),
      body: '{"target":"nope"}',
    });
    expect(bad.status).toBe(400);
    const ok = await fetch(`${BASE}/api/sessions/${sid}/interrupt`, {
      method: "POST",
      headers: h("cu"),
      body: '{"target":"all"}',
    });
    expect(ok.status).toBe(200);
    const b = (await ok.json()) as any;
    expect(b.ok).toBeTrue();
    expect(Array.isArray(b.interrupted)).toBeTrue();
  });

  test("queue：DELETE 整清（空闲会话无队列 → 200 空队列）", async () => {
    const r = await fetch(`${BASE}/api/sessions/${sid}/queue`, { method: "DELETE", headers: h("cu") });
    expect(r.status).toBe(200);
    const b = (await r.json()) as any;
    expect(b.ok).toBeTrue();
    expect(b.queue.steering).toEqual([]);
    expect(b.queue.followUp).toEqual([]);
  });

  test("todos PUT：非法 body 400；合法 phases 200", async () => {
    const bad = await fetch(`${BASE}/api/sessions/${sid}/todos`, { method: "PUT", headers: h("cu"), body: "{}" });
    expect(bad.status).toBe(400);
    const ok = await fetch(`${BASE}/api/sessions/${sid}/todos`, {
      method: "PUT",
      headers: h("cu"),
      body: JSON.stringify({ phases: [{ name: "phase-1", tasks: [{ content: "do it", status: "pending" }] }] }),
    });
    expect(ok.status).toBe(200);
    const b = (await ok.json()) as any;
    expect(b.ok).toBeTrue();
    expect(Array.isArray(b.phases)).toBeTrue();
  });

  test("title/generate：无消息 → 409 NO_MESSAGES", async () => {
    const r = await fetch(`${BASE}/api/sessions/${sid}/title/generate`, {
      method: "POST",
      headers: h("cu"),
      body: "{}",
    });
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).error.code).toBe("NO_MESSAGES");
  });
});

describe("控制台：会话检索", () => {
  test("列表 ?q= 按标题过滤（命中/不命中）", async () => {
    const created = await (
      await fetch(`${BASE}/api/sessions`, {
        method: "POST",
        headers: h("cu"),
        body: JSON.stringify({ title: "unique-needle-workspace" }),
      })
    ).json();
    const hit = (await (await fetch(`${BASE}/api/sessions?q=unique-needle`, { headers: h("cu") })).json()) as any;
    expect(hit.sessions.some((s: any) => s.id === created.id)).toBeTrue();
    const miss = (await (await fetch(`${BASE}/api/sessions?q=zzz-not-present`, { headers: h("cu") })).json()) as any;
    expect(miss.sessions.some((s: any) => s.id === created.id)).toBeFalse();
  });

  test("/search：q 少于 2 字符 400；空结果 200", async () => {
    expect((await fetch(`${BASE}/api/sessions/search?q=a`, { headers: h("cu") })).status).toBe(400);
    const r = await fetch(`${BASE}/api/sessions/search?q=不存在的词`, { headers: h("cu") });
    expect(r.status).toBe(200);
    const b = (await r.json()) as any;
    expect(Array.isArray(b.results)).toBeTrue();
    expect(b.total).toBe(b.results.length);
  });

  test("/search：跨用户隔离（他人搜索看不到我的会话）", async () => {
    const created = await (
      await fetch(`${BASE}/api/sessions`, {
        method: "POST",
        headers: h("cu"),
        body: JSON.stringify({ title: "secret-title-xyz" }),
      })
    ).json();
    const mine = (await (
      await fetch(`${BASE}/api/sessions/search?q=secret-title-xyz`, { headers: h("cu") })
    ).json()) as any;
    const others = (await (
      await fetch(`${BASE}/api/sessions/search?q=secret-title-xyz`, { headers: h("intruder") })
    ).json()) as any;
    // 标题匹配来自 SQL 列表，正文匹配来自 JSONL；两者都不得泄给他人
    expect(others.results.some((x: any) => x.sessionId === created.id)).toBeFalse();
    expect(Array.isArray(mine.results)).toBeTrue();
  });
});

describe("集成面：分页/配额（DESIGN §21）", () => {
  test("会话列表：total/page/perPage 分页字段", async () => {
    const b = (await (await fetch(`${BASE}/api/sessions?per_page=1&page=0`, { headers: h("cu") })).json()) as any;
    expect(b.sessions.length).toBeLessThanOrEqual(1);
    expect(typeof b.total).toBe("number");
    expect(b.total).toBeGreaterThanOrEqual(b.sessions.length);
    expect(b.page).toBe(0);
    expect(b.perPage).toBe(1);
  });

  test("/api/me/limits：配额 + 本月用量 + RPM 窗口", async () => {
    const b = (await (await fetch(`${BASE}/api/me/limits`, { headers: h("cu") })).json()) as any;
    expect(typeof b.limits.maxSessions).toBe("number");
    expect(typeof b.limits.maxConcurrent).toBe("number");
    expect(b.limits).toHaveProperty("rpm");
    expect(b.limits).toHaveProperty("monthlyBudgetUsd");
    expect(typeof b.usage.activeSessions).toBe("number");
    expect(typeof b.usage.monthCostUsd).toBe("number");
    expect(b.usage.budgetRemainingUsd).toBeNull(); // 无预算时 null
    expect(typeof b.rpmWindow.used).toBe("number");
  });

  test("SSE ?types=：只收匹配事件（含通配），replay.state 恒放行", async () => {
    const created = await (
      await fetch(`${BASE}/api/sessions`, { method: "POST", headers: h("cu"), body: "{}" })
    ).json();
    const events: string[] = [];
    const ac = new AbortController();
    const done = (async () => {
      try {
        const res = await fetch(`${BASE}/api/sessions/${created.id}/events?types=turn.*`, {
          headers: h("cu"),
          signal: ac.signal,
        });
        const reader = res.body!.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
          const { done: d, value } = await reader.read();
          if (d) break;
          buf += dec.decode(value, { stream: true });
          for (const m of buf.matchAll(/^event: (.+)$/gm)) events.push(m[1]);
          if (events.includes("replay.state") && events.length > 0) {
            // 收到状态帧即可判定（无需触发 turn）
            await new Promise((r) => setTimeout(r, 300));
            break;
          }
        }
      } catch {}
    })();
    await new Promise((r) => setTimeout(r, 500));
    ac.abort();
    await Promise.race([done, new Promise((r) => setTimeout(r, 2_000))]);
    expect(events).toContain("replay.state"); // 协议帧恒放行
    expect(events.every((e) => e === "replay.state" || e.startsWith("turn.") || e === "error")).toBeTrue();
  });
});

describe("控制台：守卫", () => {
  test("控制台：守卫 跨用户", async () => {
    for (const ep of ["commands", "models", "todos", "context", "modes", "plan", "maintenance", "session-tree"]) {
      expect((await fetch(`${BASE}/api/sessions/${sid}/${ep}`, { headers: h("intruder") })).status).toBe(404);
      expect((await fetch(`${BASE}/api/sessions/no-such/${ep}`, { headers: h("cu") })).status).toBe(404);
    }
  });
});

describe("gateway-events v1.2：事件归一化矩阵", () => {
  test("todo_reminder / todo_auto_clear", () => {
    expect(
      normalizeOmpEvent({ type: "todo_reminder", todos: [{ content: "x" }], attempt: 1, maxAttempts: 3 } as any),
    ).toEqual({
      type: "todo.reminder",
      todos: [{ content: "x" }],
      attempt: 1,
      maxAttempts: 3,
    });
    expect(normalizeOmpEvent({ type: "todo_auto_clear" } as any)).toEqual({ type: "todo.cleared" });
  });

  test("goal_updated / queue_update", () => {
    expect(normalizeOmpEvent({ type: "goal_updated", goal: { id: "g" }, state: { active: true } } as any)).toEqual({
      type: "goal.updated",
      goal: { id: "g" },
      state: { active: true },
    });
    expect(
      normalizeOmpEvent({ type: "queue_update", steering: ["a"], followUp: ["b"], liveSteered: 2 } as any),
    ).toEqual({
      type: "queue.updated",
      steering: ["a"],
      followUp: ["b"],
      liveSteered: 2,
    });
  });

  test("compaction（auto/manual 四事件）", () => {
    expect(
      normalizeOmpEvent({ type: "auto_compaction_start", reason: "threshold", action: "context-full" } as any),
    ).toEqual({
      type: "compaction.started",
      manual: false,
      reason: "threshold",
      action: "context-full",
    });
    expect(
      normalizeOmpEvent({
        type: "auto_compaction_end",
        action: "context-full",
        aborted: false,
        willRetry: true,
      } as any),
    ).toEqual({
      type: "compaction.completed",
      manual: false,
      aborted: false,
      willRetry: true,
      skipped: undefined,
      error: undefined,
    });
    expect(normalizeOmpEvent({ type: "manual_compaction_start", mode: "remote" } as any)).toEqual({
      type: "compaction.started",
      manual: true,
      action: "remote",
    });
    expect(normalizeOmpEvent({ type: "manual_compaction_end", aborted: true } as any)).toEqual({
      type: "compaction.completed",
      manual: true,
      aborted: true,
      skipped: undefined,
      error: undefined,
    });
  });

  test("retry started/end + fallback", () => {
    expect(
      normalizeOmpEvent({
        type: "auto_retry_start",
        attempt: 2,
        maxAttempts: 5,
        delayMs: 1000,
        errorMessage: "boom",
      } as any),
    ).toEqual({ type: "retry.started", attempt: 2, maxAttempts: 5, delayMs: 1000, errorMessage: "boom" });
    expect(normalizeOmpEvent({ type: "auto_retry_end", success: true, attempt: 2 } as any)).toEqual({
      type: "retry.completed",
      success: true,
      attempt: 2,
      finalError: undefined,
    });
    expect(
      normalizeOmpEvent({ type: "retry_fallback_applied", from: "a/1", to: "b/2", role: "default" } as any),
    ).toEqual({
      type: "model.fallback",
      from: "a/1",
      to: "b/2",
      role: "default",
      reason: undefined,
      succeeded: false,
    });
    expect(normalizeOmpEvent({ type: "retry_fallback_succeeded", model: "b/2", role: "default" } as any)).toEqual({
      type: "model.fallback",
      from: "",
      to: "b/2",
      role: "default",
      succeeded: true,
    });
  });

  test("config_warnings_changed / ttsr_triggered", () => {
    expect(normalizeOmpEvent({ type: "config_warnings_changed" } as any)).toEqual({ type: "config.warnings" });
    expect(normalizeOmpEvent({ type: "ttsr_triggered", rules: [{ id: "r" }] } as any)).toEqual({
      type: "rules.triggered",
      rules: [{ id: "r" }],
    });
  });

  test("schema 事件枚举与 openapi 清单一致（v1.2）", async () => {
    const schema = JSON.parse(
      await Bun.file(path.join(import.meta.dir, "..", "..", "contracts", "gateway-events.v1.schema.json")).text(),
    );
    const spec = await (await fetch(`${BASE}/openapi.json`)).json();
    expect((schema.properties.type.enum as string[]).sort()).toEqual(
      [...(spec["x-gateway-events"].types as string[])].sort(),
    );
  });
});
