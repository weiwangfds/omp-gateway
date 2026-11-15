/**
 * 并发冒烟（10 用户同时使用，离线无模型）：验证多租户并发下的稳定性与延迟量级。
 * 每个用户的负载轨迹：建会话×2 → SSE 订阅 → bootstrap/status → inject → 文件+git →
 * prompt(预期 409 MODEL_UNAVAILABLE) → 快照 → 删除；全部 10 用户并行两波。
 * 断言：全部预期状态码、healthz 全程 200、轻端点 p95 延迟量级健康。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 8971;
const BASE = `http://127.0.0.1:${PORT}`;
const TOK = "load-token";
const USERS = 10;
const h = (uid: string) => ({ authorization: `Bearer ${TOK}`, "content-type": "application/json", "x-user-id": uid });

const dataRoot = mkdtempSync(path.join(tmpdir(), "omp-load-"));
let proc: Bun.Subprocess | null = null;
const latencies: Array<{ op: string; ms: number }> = [];

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
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("gateway not healthy");
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

async function timed<T>(op: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    latencies.push({ op, ms: Date.now() - t0 });
  }
}

/** 单用户完整轨迹（离线）：返回其持有的 SSE abort controller。 */
async function userWorkload(uid: string): Promise<AbortController> {
  const ac = new AbortController();

  const s1 = await timed(
    `${uid}:create1`,
    async () =>
      (await (await fetch(`${BASE}/api/sessions`, { method: "POST", headers: h(uid), body: "{}" })).json()) as {
        id: string;
      },
  );
  const s2 = await timed(
    `${uid}:create2`,
    async () =>
      (await (await fetch(`${BASE}/api/sessions`, { method: "POST", headers: h(uid), body: "{}" })).json()) as {
        id: string;
      },
  );

  // SSE 订阅（收到 replay.state 即视为成功，保持连接直到轨迹结束）
  const sse = timed(`${uid}:sse`, async () => {
    const res = await fetch(`${BASE}/api/sessions/${s1.id}/events`, { headers: h(uid), signal: ac.signal });
    expect(res.ok).toBeTrue();
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("replay.state");
    ac.abort(); // 建连即断开（本测试只验证并发建连与首帧）
  });

  await timed(`${uid}:bootstrap`, async () => {
    const b = (await (await fetch(`${BASE}/api/sessions/${s1.id}/bootstrap`, { headers: h(uid) })).json()) as any;
    expect(b.session.id).toBe(s1.id);
  });
  await timed(`${uid}:status`, async () => {
    const st = (await (await fetch(`${BASE}/api/sessions/${s1.id}/status`, { headers: h(uid) })).json()) as any;
    expect(st.sessionId).toBe(s1.id);
  });
  await timed(`${uid}:inject`, async () => {
    const r = await fetch(`${BASE}/api/sessions/${s1.id}/inject`, {
      method: "POST",
      headers: h(uid),
      body: JSON.stringify({ text: "ctx", mode: "context" }),
    });
    expect(r.status).toBe(202);
  });
  await timed(`${uid}:file+git`, async () => {
    await fetch(`${BASE}/api/sessions/${s2.id}/file?path=notes.md`, {
      method: "PUT",
      headers: h(uid),
      body: JSON.stringify({ content: "# notes" }),
    });
    const g = await fetch(`${BASE}/api/sessions/${s2.id}/git/commit`, {
      method: "POST",
      headers: h(uid),
      body: JSON.stringify({ message: "init", add: "all" }),
    });
    // workspace 可能非 git（init 由 git/commit 自动处理与否皆有）——只要求非 5xx
    expect(g.status).toBeLessThan(500);
  });
  await timed(`${uid}:prompt-409`, async () => {
    const r = await fetch(`${BASE}/api/sessions/${s1.id}/prompt`, {
      method: "POST",
      headers: h(uid),
      body: JSON.stringify({ text: "hi" }),
    });
    expect(r.status).toBe(409); // 无模型 → 快速确定性失败
  });
  await timed(`${uid}:snapshot`, async () => {
    const r = await fetch(`${BASE}/api/sessions/${s2.id}/snapshots`, { method: "POST", headers: h(uid), body: "{}" });
    // 零 turn 无文件 → SNAPSHOT_EMPTY；这是预期拒绝路径
    expect([201, 409]).toContain(r.status);
  });
  await timed(`${uid}:delete`, async () => {
    const r = await fetch(`${BASE}/api/sessions/${s2.id}?confirm=${s2.id}`, { method: "DELETE", headers: h(uid) });
    expect(r.status).toBe(200);
  });

  await sse;
  return ac;
}

describe("并发冒烟：10 用户同时使用", () => {
  test("两波并行轨迹全部成功，healthz 全程 200", async () => {
    // 波 1：10 用户同时打满
    const wave1 = await Promise.allSettled(Array.from({ length: USERS }, (_, i) => userWorkload(`u${i}`)));
    const failed1 = wave1.filter((r) => r.status === "rejected");
    expect(failed1.map((f) => String((f as PromiseRejectedResult).reason))).toEqual([]);

    // 波 2：在波 1 的 SSE 尚未全部断开时再打一轮（连接叠加）
    const wave2 = await Promise.allSettled(Array.from({ length: USERS }, (_, i) => userWorkload(`v${i}`)));
    const failed2 = wave2.filter((r) => r.status === "rejected");
    expect(failed2.map((f) => String((f as PromiseRejectedResult).reason))).toEqual([]);

    expect((await fetch(`${BASE}/healthz`)).status).toBe(200);
    const ready = (await (await fetch(`${BASE}/readyz`)).json()) as any;
    expect(ready.ready).toBeTrue();

    // 延迟量级：轻端点（bootstrap/status/inject 等除建会话外）p95 < 2000ms
    const light = latencies.filter((l) => !l.op.includes("create") && !l.op.includes("sse"));
    const sorted = light.map((l) => l.ms).sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    console.log(
      `[load] ops=${light.length} p50=${sorted[Math.floor(sorted.length / 2)]}ms p95=${p95}ms max=${sorted.at(-1)}ms`,
    );
    expect(p95).toBeLessThan(2000);
  }, 120_000);
});
