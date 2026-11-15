/**
 * 环境迁移 e2e（DESIGN §32）：实例 A（dataRoot A）造完整环境 → export bundle →
 * 实例 B（**不同的 dataRoot 路径**，同一共享 export 目录）import → 全量对账。
 *
 * 覆盖：会话（含真实 JSONL 的复活链路）、workspace 文件、快照、webhook/钩子/HTTP 工具订阅、
 * usage、user_version 迁移（旧绝对路径库在 B 不适用——A 已是相对路径）、INV-1 相对路径语义。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const TOK = "mig-token";
const H = { authorization: `Bearer ${TOK}`, "content-type": "application/json", "x-user-id": "mig-admin" };
const h = (uid: string) => ({ ...H, "x-user-id": uid });

const sharedRoot = mkdtempSync(path.join(tmpdir(), "omp-mig-"));
const dataRootA = path.join(sharedRoot, "data-a");
const dataRootB = path.join(sharedRoot, "data-b");
const exportDir = path.join(sharedRoot, "exports");
const PORT_A = 8981;
const PORT_B = 8982;
const BASE_A = `http://127.0.0.1:${PORT_A}`;
const BASE_B = `http://127.0.0.1:${PORT_B}`;

function spawnGateway(port: number, dataRoot: string): Bun.Subprocess {
  return Bun.spawn([process.execPath, "run", "src/index.ts"], {
    cwd: path.resolve(import.meta.dir, ".."),
    env: {
      ...process.env,
      GATEWAY_PORT: String(port),
      GATEWAY_DATA_ROOT: dataRoot,
      GATEWAY_SERVICE_TOKENS: TOK,
      GATEWAY_EXPORT_DIR: exportDir,
      GATEWAY_IMPORT_DIRS: exportDir,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
}

async function waitHealthy(base: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`gateway not healthy: ${base}`);
}

function kill(proc: Bun.Subprocess | undefined): void {
  if (!proc) return;
  try {
    proc.kill();
  } catch {}
  try {
    Bun.spawnSync(["taskkill", "/F", "/T", "/PID", String(proc.pid)]);
  } catch {}
}

let procA: Bun.Subprocess | undefined;
let procB: Bun.Subprocess | undefined;

/** 合成有效会话 JSONL（校验器可过 + model_change 让 revive 离线可用）。 */
function sessionJsonl(sid: string, model: string): string {
  const now = new Date().toISOString();
  const lines = [
    JSON.stringify({ type: "session", id: sid, version: 1, timestamp: now, cwd: "/tmp", title: "migrated-session" }),
    JSON.stringify({
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: now,
      message: { role: "user", content: [{ type: "text", text: "hello from A" }] },
    }),
    JSON.stringify({
      type: "message",
      id: "m2",
      parentId: "m1",
      timestamp: now,
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    }),
    JSON.stringify({ type: "model_change", id: "mchg1", parentId: "m2", timestamp: now, model }),
  ];
  return `${lines.join("\n")}\n`;
}

beforeAll(async () => {
  procA = spawnGateway(PORT_A, dataRootA);
  await waitHealthy(BASE_A);

  // ---- 在 A 上造环境 ----
  // 模型目录（离线可 revive：可用性=配置检查，不验凭据）
  await fetch(`${BASE_A}/api/me/models/config`, {
    method: "PUT",
    headers: h("mig-u"),
    body: JSON.stringify({
      providers: {
        minimax: {
          baseUrl: "https://api.example.com/v1",
          api: "openai-completions",
          apiKey: "sk-test",
          models: [{ id: "MiniMax-Test", name: "Test" }],
        },
      },
    }),
  });

  // 会话 1：经 session-import 注入真实 JSONL（含 model_change → 可复活）
  const impRes = await fetch(`${BASE_A}/api/sessions/import`, {
    method: "POST",
    headers: h("mig-u"),
    body: sessionJsonl("migsession0001", "minimax/MiniMax-Test"),
  });
  expect(impRes.status).toBe(201);
  const imp = (await impRes.json()) as any;
  expect(imp.id).toBe("migsession0001");

  // 会话 2：普通建会话 + workspace 文件
  const s2 = (await (
    await fetch(`${BASE_A}/api/sessions`, { method: "POST", headers: h("mig-u"), body: '{"title":"plain"}' })
  ).json()) as { id: string };
  const fput = await fetch(`${BASE_A}/api/sessions/${s2.id}/file?path=docs/readme.md`, {
    method: "PUT",
    headers: h("mig-u"),
    body: JSON.stringify({ content: "# migrated" }),
  });
  expect(fput.status).toBe(200);

  // 快照（会话 1 有真实 JSONL）
  const snap = await fetch(`${BASE_A}/api/sessions/migsession0001/snapshots`, {
    method: "POST",
    headers: h("mig-u"),
    body: "{}",
  });
  expect(snap.status).toBe(201);

  // 集成订阅：webhook / hook / http 工具
  const wh = await fetch(`${BASE_A}/api/me/webhooks`, {
    method: "POST",
    headers: h("mig-u"),
    body: JSON.stringify({ url: "https://biz.example.com/cb", events: ["*"] }),
  });
  expect(wh.status).toBe(201);
  const hk = await fetch(`${BASE_A}/api/me/hooks`, {
    method: "POST",
    headers: h("mig-u"),
    body: JSON.stringify({ event: "turn_end", url: "https://biz.example.com/hook" }),
  });
  expect(hk.status).toBe(201);
  const tool = await fetch(`${BASE_A}/api/me/tools/http/order_status`, {
    method: "PUT",
    headers: h("mig-u"),
    body: JSON.stringify({
      description: "d",
      url: "https://biz.example.com/tools/order",
      parameters: { type: "object", properties: {} },
    }),
  });
  expect(tool.status).toBe(201);
}, 30_000);

afterAll(() => {
  kill(procA);
  kill(procB);
});

describe("环境迁移：export → import（不同 dataRoot）", () => {
  let bundlePath = "";

  test("export：bundle 落盘 + manifest 对账计数正确", async () => {
    const r = await fetch(`${BASE_A}/internal/maintenance/export`, { method: "POST", headers: H });
    expect(r.status).toBe(202);
    const b = (await r.json()) as any;
    bundlePath = b.bundlePath;
    expect(b.manifest.counts).toMatchObject({
      users: 1,
      sessions: 2,
      snapshots: 1,
      webhooks: 1,
      integrationHooks: 1,
      httpTools: 1,
    });
    expect(b.manifest.sha256).toHaveLength(64);
    // bundle 结构
    const manifest = JSON.parse(await Bun.file(path.join(bundlePath, "manifest.json")).text());
    expect(manifest.formatVersion).toBe(1);
    // DB 内路径已是相对路径（INV-1）
    const db = new (require("bun:sqlite") as typeof import("bun:sqlite")).Database(
      path.join(bundlePath, "gateway.db"),
      { readonly: true },
    );
    try {
      const row = db.query("SELECT session_file FROM sessions WHERE id = 'migsession0001'").get() as any;
      expect(row.session_file).not.toMatch(/^([A-Za-z]:|\/)/); // 非绝对路径
      expect(row.session_file).toContain("users/mig-u/sessions/");
    } finally {
      db.close();
    }
  });

  test("import：B 实例（不同 dataRoot）导入成功并全量对账", async () => {
    procB = spawnGateway(PORT_B, dataRootB);
    await waitHealthy(BASE_B);

    const r = await fetch(`${BASE_B}/internal/maintenance/import`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ path: bundlePath, confirm: "REPLACE" }),
    });
    expect(r.status).toBe(200);
    const b = (await r.json()) as any;
    expect(b.counts).toMatchObject({
      users: 1,
      sessions: 2,
      snapshots: 1,
      webhooks: 1,
      integrationHooks: 1,
      httpTools: 1,
    });
    expect(b.backupDir).toContain(".bak-");

    // 会话列表与详情
    const list = (await (await fetch(`${BASE_B}/api/sessions`, { headers: h("mig-u") })).json()) as any;
    expect(list.total).toBe(2);
    const ids: string[] = list.sessions.map((s: any) => s.id);
    expect(ids).toContain("migsession0001");
    expect(ids).toHaveLength(2);

    // 复活链路：bootstrap（按相对路径解析到 B 的 dataRoot + model_change 可用模型）
    const boot = await fetch(`${BASE_B}/api/sessions/migsession0001/bootstrap`, { headers: h("mig-u") });
    expect(boot.status).toBe(200);

    // JSONL 内容原样迁移
    const sf = await (
      await fetch(`${BASE_B}/api/sessions/migsession0001/session-file`, { headers: h("mig-u") })
    ).text();
    expect(sf).toContain("hello from A");

    // workspace 文件（GET /file 返回 JSON 信封 {path,encoding,content,size}）
    const fRes = await fetch(
      `${BASE_B}/api/sessions/${list.sessions.find((s: any) => s.id !== "migsession0001").id}/file?path=docs/readme.md`,
      { headers: h("mig-u") },
    );
    const f = (await fRes.json()) as any;
    expect(f.content).toBe("# migrated");

    // 快照元数据迁移（meta 可查；文件在 B 的 snapshots 目录下按相对路径解析）
    const snaps = (await (
      await fetch(`${BASE_B}/api/sessions/migsession0001/snapshots`, { headers: h("mig-u") })
    ).json()) as any;
    expect(snaps.snapshots).toHaveLength(1);
    // restore fork 走相对路径解析（forkFrom=fromStorePath）→ 新会话含快照内容
    const fr = await (
      await fetch(`${BASE_B}/api/sessions/migsession0001/snapshots/${snaps.snapshots[0].id}/restore`, {
        method: "POST",
        headers: h("mig-u"),
        body: "{}",
      })
    ).json();
    expect(fr.mode).toBe("fork");
    const forkMsgs = (await (
      await fetch(`${BASE_B}/api/sessions/${fr.id}/messages`, { headers: h("mig-u") })
    ).json()) as any;
    expect(forkMsgs.total).toBeGreaterThan(0);

    // 订阅面
    const wh = (await (await fetch(`${BASE_B}/api/me/webhooks`, { headers: h("mig-u") })).json()) as any;
    expect(wh.webhooks).toHaveLength(1);
    const hk = (await (await fetch(`${BASE_B}/api/me/hooks`, { headers: h("mig-u") })).json()) as any;
    expect(hk.hooks).toHaveLength(1);
    const tl = (await (await fetch(`${BASE_B}/api/me/tools/http`, { headers: h("mig-u") })).json()) as any;
    expect(tl.tools).toHaveLength(1);
  }, 40_000);

  test("import 校验面：manifest 篡改 / 未确认 / 越权路径", async () => {
    // 未确认
    const noConfirm = await fetch(`${BASE_B}/internal/maintenance/import`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ path: bundlePath }),
    });
    expect(noConfirm.status).toBe(400);
    expect(((await noConfirm.json()) as any).error.code).toBe("CONFIRM_REQUIRED");

    // 越权路径
    const evil = await fetch(`${BASE_B}/internal/maintenance/import`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ path: "C:/Windows", confirm: "REPLACE" }),
    });
    expect([400, 403]).toContain(evil.status);

    // manifest 篡改（sha256 对账失败）
    const tampered = path.join(exportDir, "tampered");
    await fs.cp(bundlePath, tampered, { recursive: true });
    const m = JSON.parse(await Bun.file(path.join(tampered, "manifest.json")).text());
    m.sha256 = "0".repeat(64);
    await Bun.write(path.join(tampered, "manifest.json"), JSON.stringify(m));
    const bad = await fetch(`${BASE_B}/internal/maintenance/import`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ path: tampered, confirm: "REPLACE" }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error.code).toBe("BUNDLE_INCOMPLETE");
    await fs.rm(tampered, { recursive: true, force: true });
  }, 30_000);
});
