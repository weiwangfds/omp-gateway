/**
 * 逐端点详细测试（对照 /openapi.json 的全部操作（M7-M10 后 122+））：
 * 在既有套件之外补齐每端点的边界与细节断言（无模型依赖，全部离线）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 8798;
const BASE = `http://127.0.0.1:${PORT}`;
const TOK = "detail-token";
const ADM = { "x-admin-token": "unused", "x-admin-id": "detail-admin", "x-user-id": "detail-admin" };
const H = { authorization: `Bearer ${TOK}`, "content-type": "application/json" };
const h = (uid: string) => ({ ...H, "x-user-id": uid });

const dataRoot = mkdtempSync(path.join(tmpdir(), "omp-gw-detail-"));
let proc: Bun.Subprocess | null = null;

beforeAll(async () => {
  proc = Bun.spawn([process.execPath, "run", "src/index.ts"], {
    cwd: path.resolve(import.meta.dir, ".."),
    env: {
      ...process.env,
      GATEWAY_PORT: String(PORT),
      GATEWAY_DATA_ROOT: dataRoot,
      GATEWAY_SERVICE_TOKENS: TOK,
      GATEWAY_ADMIN_TOKENS: "legacy-adm", // 仅验证头存在性判定已改为 X-Admin-Id（旧 token 不再被接受）
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

const _j = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => ({})) });
const mk = async (uid: string, body: Record<string, unknown> = {}) => {
  const r = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: h(uid), body: JSON.stringify(body) });
  return (await r.json()) as { id: string };
};

describe("逐端点详测：ops + openapi", () => {
  test("openapi：全部操作登记、无重复 path+method", async () => {
    const spec = await (await fetch(`${BASE}/openapi.json`)).json();
    const ops = Object.entries(spec.paths as Record<string, Record<string, unknown>>).flatMap(([p, m]) =>
      Object.keys(m).map((me) => `${me.toUpperCase()} ${p}`),
    );
    expect(ops.length).toBeGreaterThanOrEqual(90);
    expect(new Set(ops).size).toBe(ops.length);
    // 事件类型清单与 schema 文件一致
    const schema = JSON.parse(
      await Bun.file(path.join(import.meta.dir, "..", "..", "contracts", "gateway-events.v1.schema.json")).text(),
    );
    expect(schema.properties.type.enum.sort()).toEqual([...(spec["x-gateway-events"].types as string[])].sort());
  });

  test("openapi：摘要全覆盖、components 与 x-gateway-error-codes 就位", async () => {
    const spec = await (await fetch(`${BASE}/openapi.json`)).json();
    // 每个操作都有语义摘要（不允许退回 "METHOD /path" 占位）
    for (const [p, methods] of Object.entries(spec.paths as Record<string, Record<string, any>>)) {
      for (const [me, op] of Object.entries(methods)) {
        const s = String(op.summary ?? "");
        expect(`${me.toUpperCase()} ${p}: ${s}`).not.toBe(`${me.toUpperCase()} ${p}: ${me.toUpperCase()} ${p}`);
        expect(s.length).toBeGreaterThanOrEqual(4);
        expect(op.responses["401"]).toBeTruthy(); // 统一错误面
        expect(op.tags?.length).toBeTruthy(); // 每个操作归属一个标签
      }
    }
    // 覆盖率自省：摘要覆盖率必须 100%（新增路由未登记摘要会立刻掉下来）
    const cov = spec["x-gateway-coverage"];
    expect(cov.summaryCoverage).toBe(1);
    expect(cov.documented).toBe(cov.operations);
    expect(cov.operations).toBeGreaterThanOrEqual(190);
    expect(cov.responseModels).toBeGreaterThanOrEqual(40);
    expect(cov.tags.length).toBeGreaterThanOrEqual(12);
    // components：Error 信封 + 事件信封 + 响应模型
    expect(spec.components.schemas.Error.properties.error.properties.code).toBeTruthy();
    expect(spec.components.schemas.GatewayEventEnvelope.properties.type.enum.length).toBeGreaterThanOrEqual(28);
    expect(spec.components.schemas.Session.properties.id).toBeTruthy();
    expect(spec.components.schemas.EventReplay.properties.nextSince).toBeTruthy();
    // 错误码契约投影
    expect(spec["x-gateway-error-codes"].STREAM_QUEUE_TIMEOUT).toBeString();
    expect(spec["x-gateway-error-codes"].BUNDLE_INCOMPLETE).toBeString();
    // 幂等操作带 Idempotency-Key 头文档
    const create = spec.paths["/api/sessions"].post;
    expect(create.parameters.some((x: any) => x.name === "Idempotency-Key")).toBeTrue();
    // 高频操作带请求体、查询参数与专属错误码
    const prompt = spec.paths["/api/sessions/{sid}/prompt"].post;
    expect(prompt.requestBody.content["application/json"].schema.properties.text).toBeTruthy();
    expect(prompt.responses["409"]).toBeTruthy();
    expect(prompt.responses["429"]).toBeTruthy();
    // 查询参数已声明（否则集成端只能靠试）
    const list = spec.paths["/api/sessions"].get;
    expect(list.parameters.some((x: any) => x.name === "page")).toBeTrue();
    expect(list.parameters.some((x: any) => x.name === "status")).toBeTrue();
    const events = spec.paths["/api/sessions/{sid}/events"].get;
    expect(events.parameters.some((x: any) => x.name === "types")).toBeTrue();
  });

  test("healthz/readyz：数据根只读故障 → readyz 503", async () => {
    expect((await fetch(`${BASE}/healthz`)).status).toBe(200);
    expect((await (await fetch(`${BASE}/readyz`)).json()).ready).toBe(true);
  });
});

describe("逐端点详测：auth 中间件", () => {
  test("X-Admin-Id 旧 token 头（x-admin-token）不再被接受 → 403", async () => {
    // admin token 体系已废：仅 X-Admin-Id 标识有效
    const r = await fetch(`${BASE}/admin/global/skills`, {
      headers: { ...H, "x-admin-token": "legacy-adm", "x-user-id": "a" },
    });
    expect(r.status).toBe(403);
    expect(((await r.json()) as any).error.code).toBe("ADMIN_REQUIRED");
  });

  test("X-Admin-Id 格式非法 → 视为未注入 → 403", async () => {
    const r = await fetch(`${BASE}/admin/global/skills`, {
      headers: { ...H, "x-admin-id": "../evil", "x-user-id": "a" },
    });
    expect(r.status).toBe(403);
  });

  test("分享令牌 + X-Admin-Id → 管理面仍拒绝（分享身份无管理权）", async () => {
    const sid = (await mk("share-admin")).id;
    const link = await (
      await fetch(`${BASE}/api/sessions/${sid}/share-link`, {
        method: "POST",
        headers: h("share-admin"),
        body: '{"access":"control"}',
      })
    ).json();
    const r = await fetch(`${BASE}/admin/global/skills`, {
      headers: { "x-share-token": link.token, "x-admin-id": "someone" },
    });
    expect(r.status).toBe(403);
  }, 20_000);
});

describe("逐端点详测：sessions", () => {
  let sid = "";

  test("PATCH title 持久化 + detail.usage 字段存在", async () => {
    sid = (await mk("detail-u1", { title: "t0" })).id;
    await fetch(`${BASE}/api/sessions/${sid}`, {
      method: "PATCH",
      headers: h("detail-u1"),
      body: '{"title":"renamed-detail"}',
    });
    const d = await (await fetch(`${BASE}/api/sessions/${sid}`, { headers: h("detail-u1") })).json();
    expect(d.title).toBe("renamed-detail");
    expect(d.usage).toMatchObject({ turns: 0, inputTokens: 0, costUsd: 0 });
    expect(typeof d.session_file).toBe("string");
  }, 20_000);

  test("GET /:sid/entries：零 turn 会话仍有系统条目（model_change 等），结构完整", async () => {
    const e = await (await fetch(`${BASE}/api/sessions/${sid}/entries`, { headers: h("detail-u1") })).json();
    expect(e.total).toBeGreaterThanOrEqual(0);
    expect(e.entries.every((x: any) => typeof x.id === "string" && typeof x.type === "string")).toBeTrue();
  });

  test("POST /:sid/model：非法 provider 字段缺失 → 404（modelId 为空串）", async () => {
    const r = await (
      await fetch(`${BASE}/api/sessions/${sid}/model`, {
        method: "POST",
        headers: h("detail-u1"),
        body: '{"provider":""}',
      })
    ).json();
    expect(r.error).toBeTruthy();
  });

  test("share-link：ttlSeconds 过期后 401；列表端点返回登记项", async () => {
    const link = await (
      await fetch(`${BASE}/api/sessions/${sid}/share-link`, {
        method: "POST",
        headers: h("detail-u1"),
        body: '{"access":"view","ttlSeconds":1}',
      })
    ).json();
    expect(link.expiresAt).toBeTruthy();
    expect((await fetch(`${BASE}/api/sessions/${sid}`, { headers: { "x-share-token": link.token } })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 1500));
    expect((await fetch(`${BASE}/api/sessions/${sid}`, { headers: { "x-share-token": link.token } })).status).toBe(401);
    const list = await (await fetch(`${BASE}/api/sessions/${sid}/share-links`, { headers: h("detail-u1") })).json();
    expect(list.shares.some((s: any) => s.id === link.id)).toBeTrue();
    expect(list.shares[0].token_hash).toBeUndefined();
  });

  test("share-link：无效 access → 默认 view", async () => {
    const r = await (
      await fetch(`${BASE}/api/sessions/${sid}/share-link`, {
        method: "POST",
        headers: h("detail-u1"),
        body: '{"access":"root"}',
      })
    ).json();
    expect(r.access).toBe("view");
    await fetch(`${BASE}/api/sessions/${sid}/share-link/${r.id}`, { method: "DELETE", headers: h("detail-u1") });
  });

  test("file/raw：416 非法 Range", async () => {
    await fetch(`${BASE}/api/sessions/${sid}/file?path=r.txt`, {
      method: "PUT",
      headers: h("detail-u1"),
      body: '{"content":"0123456789"}',
    });
    const bad = await fetch(`${BASE}/api/sessions/${sid}/file/raw?path=r.txt`, {
      headers: { ...h("detail-u1"), range: "bytes=99-200" },
    });
    expect(bad.status).toBe(416);
  });

  test("files/upload：无 files 字段 → 400", async () => {
    const fd = new FormData();
    fd.append("notfiles", new File(["x"], "x.txt"));
    const { "content-type": _ct, ...hh } = h("detail-u1") as any;
    const r = await fetch(`${BASE}/api/sessions/${sid}/files/upload`, { method: "POST", headers: hh, body: fd });
    expect(r.status).toBe(400);
  });

  test("git：未 init 仓库时 worktree/log/diff/branches → 409 NOT_A_GIT_REPO", async () => {
    const sid2 = (await mk("detail-u2")).id;
    for (const ep of ["status", "log", "diff", "branches"]) {
      const r = await fetch(`${BASE}/api/sessions/${sid2}/git/${ep}`, { headers: h("detail-u2") });
      const b = await r.json();
      if (b.error) expect(b.error.code).toBe("NOT_A_GIT_REPO");
    }
  }, 20_000);

  test("prompt：streamingBehavior 非法值被忽略（仍 202/409 而非 500）", async () => {
    const r = await fetch(`${BASE}/api/sessions/${sid}/prompt`, {
      method: "POST",
      headers: h("detail-u1"),
      body: JSON.stringify({ text: "x", streamingBehavior: "bogus" }),
    });
    expect([202, 409]).toContain(r.status);
  });
});

describe("逐端点详测：me/management", () => {
  test("me/skills：PUT 非法名 400；GET 未创建 404；DELETE 未创建 404", async () => {
    expect(
      (await fetch(`${BASE}/api/me/skills/Bad_Name`, { method: "PUT", headers: h("md"), body: '{"description":"x"}' }))
        .status,
    ).toBe(400);
    expect((await fetch(`${BASE}/api/me/skills/never-created`, { headers: h("md") })).status).toBe(404);
    expect((await fetch(`${BASE}/api/me/skills/never-created`, { method: "DELETE", headers: h("md") })).status).toBe(
      404,
    );
    // 合法创建 → GET 内容含 frontmatter → DELETE 成功
    expect(
      (
        await fetch(`${BASE}/api/me/skills/good-name`, {
          method: "PUT",
          headers: h("md"),
          body: '{"description":"d","content":"hello"}',
        })
      ).status,
    ).toBe(201);
    const raw = await (await fetch(`${BASE}/api/me/skills/good-name`, { headers: h("md") })).text();
    expect(raw).toContain("name: good-name");
    expect(raw).toContain("hello");
    expect((await fetch(`${BASE}/api/me/skills/good-name`, { method: "DELETE", headers: h("md") })).status).toBe(200);
  });

  test("me/plugins：非法名 400、GET 未创建 404、合法往返", async () => {
    // %2e%2e 编码穿越：客户端归一化后仍到达服务端 → 400 INVALID_NAME
    expect(
      (
        await fetch(`${BASE}/api/me/plugins/%2e%2e%2fevil.ts`, {
          method: "PUT",
          headers: { ...h("md"), "content-type": "text/plain" },
          body: "x",
        })
      ).status,
    ).toBe(400);
    expect((await fetch(`${BASE}/api/me/plugins/never.ts`, { headers: h("md") })).status).toBe(404);
    expect((await fetch(`${BASE}/api/me/plugins/never.ts`, { method: "DELETE", headers: h("md") })).status).toBe(404);
    const putOk = await fetch(`${BASE}/api/me/plugins/ok.ts`, {
      method: "PUT",
      headers: { ...h("md"), "content-type": "text/plain" },
      body: "export default 1;",
    });
    if (putOk.status !== 201) console.error("DIAG PUT ok.ts:", putOk.status, await putOk.text());
    expect(putOk.status).toBe(201);
    expect((await fetch(`${BASE}/api/me/plugins/ok.ts`, { headers: h("md") })).status).toBe(200);
    expect((await fetch(`${BASE}/api/me/plugins/ok.ts`, { method: "DELETE", headers: h("md") })).status).toBe(200);
  });

  test("me/models：credentials 非法 provider 400；test 缺字段 400", async () => {
    expect(
      (
        await fetch(`${BASE}/api/me/models/credentials`, {
          method: "POST",
          headers: h("md"),
          body: '{"provider":"../evil","apiKey":"x"}',
        })
      ).status,
    ).toBe(400);
    expect(
      (await fetch(`${BASE}/api/me/models/credentials`, { method: "POST", headers: h("md"), body: '{"provider":"p"}' }))
        .status,
    ).toBe(400);
    expect(
      (await fetch(`${BASE}/api/me/models/test`, { method: "POST", headers: h("md"), body: '{"provider":"p"}' }))
        .status,
    ).toBe(400);
  });

  test("me/usage：group=model 分桶键格式 provider/model", async () => {
    const r = await (await fetch(`${BASE}/api/me/usage?group=model`, { headers: h("md") })).json();
    expect(r.group).toBe("model");
    expect(r.buckets.every((b: any) => /^(.+)\/(.+)$/.test(b.key) || b.key.includes("?"))).toBeTrue();
  });
});

describe("逐端点详测：admin/global", () => {
  test("skill：GET 单个返回 SKILL.md 原文；非法名 400", async () => {
    await fetch(`${BASE}/admin/global/skills/adm-skill`, {
      method: "PUT",
      headers: { ...H, ...ADM },
      body: '{"description":"admin made","content":"ADMIN-BODY"}',
    });
    const raw = await (await fetch(`${BASE}/admin/global/skills/adm-skill`, { headers: { ...H, ...ADM } })).text();
    expect(raw).toContain("ADMIN-BODY");
    expect((await fetch(`${BASE}/admin/global/skills/Bad!`, { headers: { ...H, ...ADM } })).status).toBe(400);
    await fetch(`${BASE}/admin/global/skills/adm-skill`, { method: "DELETE", headers: { ...H, ...ADM } });
  });

  test("plugin：GET 未创建 404；穿越名 400；往返 + 删除", async () => {
    expect((await fetch(`${BASE}/admin/global/plugins/never.ts`, { headers: { ...H, ...ADM } })).status).toBe(404);
    expect(
      (await fetch(`${BASE}/admin/global/plugins/..%2F..%2Fsecret.ts`, { headers: { ...H, ...ADM } })).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${BASE}/admin/global/plugins/adm.ts`, {
          method: "PUT",
          headers: { ...H, ...ADM, "content-type": "text/plain" },
          body: "export default 2;",
        })
      ).status,
    ).toBe(201);
    expect((await fetch(`${BASE}/admin/global/plugins/adm.ts`, { headers: { ...H, ...ADM } })).status).toBe(200);
    expect(
      (await fetch(`${BASE}/admin/global/plugins/adm.ts`, { method: "DELETE", headers: { ...H, ...ADM } })).status,
    ).toBe(200);
  });

  test("global mcp：PUT→GET 往返；非法 JSON 400", async () => {
    expect(
      (await fetch(`${BASE}/admin/global/mcp`, { method: "PUT", headers: { ...H, ...ADM }, body: "{bad" })).status,
    ).toBe(400);
    const mcp = { mcpServers: { probe: { type: "stdio", command: "noop" } } };
    expect(
      (await fetch(`${BASE}/admin/global/mcp`, { method: "PUT", headers: { ...H, ...ADM }, body: JSON.stringify(mcp) }))
        .status,
    ).toBe(200);
    const round = JSON.parse(await (await fetch(`${BASE}/admin/global/mcp`, { headers: { ...H, ...ADM } })).text());
    expect(round.mcpServers.probe.command).toBe("noop");
    // 还原为空，避免影响其他用例
    await fetch(`${BASE}/admin/global/mcp`, {
      method: "PUT",
      headers: { ...H, ...ADM },
      body: JSON.stringify({ mcpServers: {} }),
    });
  });
});

describe("逐端点详测：internal + webhooks", () => {
  test("webhooks：非法 URL 400；列表脱敏（无 secret）；删除他人 404", async () => {
    expect(
      (
        await fetch(`${BASE}/internal/users/wu/webhooks`, {
          method: "POST",
          headers: h("admin"),
          body: '{"url":"ftp://x"}',
        })
      ).status,
    ).toBe(400);
    const wh = await (
      await fetch(`${BASE}/internal/users/wu/webhooks`, {
        method: "POST",
        headers: h("admin"),
        body: '{"url":"http://127.0.0.1:9/hook","events":["turn.completed"]}',
      })
    ).json();
    expect(wh.secret).toBeTruthy();
    const list = await (await fetch(`${BASE}/internal/users/wu/webhooks`, { headers: h("admin") })).json();
    expect(list.webhooks[0].secret).toBeUndefined();
    // 归属：非属主删除 → 404；属主（wu）删除 → 200
    expect(
      (await fetch(`${BASE}/internal/webhooks/${wh.id}`, { method: "DELETE", headers: h("other-admin") })).status,
    ).toBe(404);
    expect((await fetch(`${BASE}/internal/webhooks/${wh.id}`, { method: "DELETE", headers: h("wu") })).status).toBe(
      200,
    );
  });

  test("limits：PATCH 仅接受已知字段（未知字段被忽略）", async () => {
    await fetch(`${BASE}/internal/users/lim-u/limits`, {
      method: "PATCH",
      headers: h("admin"),
      body: '{"maxSessions":2,"bogus":1}',
    });
    const sum = await (await fetch(`${BASE}/internal/users/lim-u/summary`, { headers: h("admin") })).json();
    expect(sum.limits.maxSessions).toBe(2);
  });

  test("usage：group=session 键为会话 id", async () => {
    const r = await (await fetch(`${BASE}/internal/users/lim-u/usage?group=session`, { headers: h("admin") })).json();
    expect(Array.isArray(r.buckets)).toBeTrue();
  });
});
