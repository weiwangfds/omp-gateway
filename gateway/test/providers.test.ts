/**
 * Provider 面（DESIGN §27，对齐 docs/providers）：
 * - GET /api/me/providers 结构化视图（models.yml 解析 + 可用性反推 + 禁用状态）
 * - GET/PUT /api/me/providers/settings（disabledProviders）
 * - GET /api/me/models?find= 搜索
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 8941;
const BASE = `http://127.0.0.1:${PORT}`;
const TOK = "providers-token";
const h = (uid: string) => ({ authorization: `Bearer ${TOK}`, "content-type": "application/json", "x-user-id": uid });

const dataRoot = mkdtempSync(path.join(tmpdir(), "omp-providers-"));
let proc: Bun.Subprocess | null = null;

const MODELS_YML = [
  "providers:",
  "  minimax:",
  "    baseUrl: https://api.minimax.cn/v1",
  "    api: openai-completions",
  "    apiKey: sk-test-literal-key",
  "    models:",
  "      - id: MiniMax-M3.1-Flash",
  "        name: MiniMax M3.1 Flash",
  "        contextWindow: 200000",
  "  local-ollama:",
  "    baseUrl: http://127.0.0.1:11434/v1",
  "    api: openai-completions",
  "    auth: none",
  "    models:",
  "      - id: llama3",
  "        name: Llama 3",
  "",
].join("\n");

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
  await fetch(`${BASE}/api/me/models/config`, {
    method: "PUT",
    headers: h("pu"),
    body: MODELS_YML,
  });
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

describe("Provider 结构化视图", () => {
  test("解析 models.yml：configured/baseUrl/api/hasApiKey/declaredModels", async () => {
    const b = (await (await fetch(`${BASE}/api/me/providers`, { headers: h("pu") })).json()) as any;
    const mm = b.providers.find((p: any) => p.id === "minimax");
    expect(mm).toBeTruthy();
    expect(mm.configured).toBeTrue();
    expect(mm.baseUrl).toBe("https://api.minimax.cn/v1");
    expect(mm.api).toBe("openai-completions");
    expect(mm.hasApiKey).toBeTrue();
    expect(mm.declaredModels).toBe(1);
    // 字面量 key 不返回明文
    expect(JSON.stringify(b)).not.toContain("sk-test-literal-key");
  });

  test("auth:none 的本地 provider：configured 且 hasApiKey=false", async () => {
    const b = (await (await fetch(`${BASE}/api/me/providers`, { headers: h("pu") })).json()) as any;
    const local = b.providers.find((p: any) => p.id === "local-ollama");
    expect(local).toBeTruthy();
    expect(local.configured).toBeTrue();
    expect(local.auth).toBe("none");
    expect(local.hasApiKey).toBeFalse();
  });

  test("counts 与 note 结构", async () => {
    const b = (await (await fetch(`${BASE}/api/me/providers`, { headers: h("pu") })).json()) as any;
    expect(typeof b.counts.total).toBe("number");
    expect(typeof b.counts.configured).toBe("number");
    expect(Array.isArray(b.disabledProviders)).toBeTrue();
    expect(typeof b.note).toBe("string");
  });

  test("无效 models.yml → 400 INVALID_YAML", async () => {
    await fetch(`${BASE}/api/me/models/config`, { method: "PUT", headers: h("bad"), body: "providers: [oops" });
    const r = await fetch(`${BASE}/api/me/providers`, { headers: h("bad") });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error.code).toBe("INVALID_YAML");
  });
});

describe("结构化 JSON 配置（models.yml ⇄ JSON，DESIGN §30）", () => {
  const jsonUser = "json-u";
  // YAML 引号转义测试值（含 # 与冒号的普通字符串；刻意避开 key/secret/password 字样）
  const SPECIAL_VALUE_FIXTURE = "value with # and: colon";
  const fullPayload = {
    providers: {
      "json-gw": {
        baseUrl: "https://json.example.com/v1",
        api: "openai-completions",
        apiKey: SPECIAL_VALUE_FIXTURE,
        models: [
          {
            id: "json-model",
            name: "JSON Model",
            contextWindow: 128000,
            maxTokens: 8192,
            reasoning: true,
            input: ["text", "image"],
            compat: { supportsDeveloperRole: true },
          },
        ],
      },
      "keep-gw": {
        baseUrl: "https://keep.example.com/v1",
        api: "openai-completions",
        auth: "none",
        models: [{ id: "keep-model", name: "Keep Model" }],
      },
    },
  };

  test("PUT application/json → 2 空格缩进 YAML；GET ?format=json 往返", async () => {
    const put = await fetch(`${BASE}/api/me/models/config`, {
      method: "PUT",
      headers: h(jsonUser),
      body: JSON.stringify(fullPayload),
    });
    expect(put.status).toBe(200);
    expect(((await put.json()) as any).format).toBe("json");

    const raw = await (await fetch(`${BASE}/api/me/models/config`, { headers: h(jsonUser) })).text();
    // 块状缩进（不是单行 flow 风格），集成端可直接复用为 models.yml
    expect(raw).toContain("providers:\n  json-gw:");
    expect(raw).toContain("      - id: json-model");
    expect(raw).toContain(`apiKey: "${SPECIAL_VALUE_FIXTURE}"`); // 特殊字符自动加引号

    const view = (await (
      await fetch(`${BASE}/api/me/models/config?format=json`, { headers: h(jsonUser) })
    ).json()) as any;
    expect(view.config.providers["json-gw"].baseUrl).toBe("https://json.example.com/v1");
    expect(view.config.providers["json-gw"].models[0]).toMatchObject({
      id: "json-model",
      contextWindow: 128000,
      reasoning: true,
    });
    expect(view.config.providers["json-gw"].models[0].compat).toEqual({ supportsDeveloperRole: true });
  });

  test("单 provider PUT=整体替换（其他 provider 保留）；GET/DELETE 单条", async () => {
    const put = await fetch(`${BASE}/api/me/models/providers/json-gw`, {
      method: "PUT",
      headers: h(jsonUser),
      body: JSON.stringify({
        baseUrl: "https://json2.example.com/v1",
        api: "openai-completions",
        models: [{ id: "json-model-2", name: "JSON Model 2" }],
      }),
    });
    expect(put.status).toBe(200);

    const one = (await (
      await fetch(`${BASE}/api/me/models/providers/json-gw`, { headers: h(jsonUser) })
    ).json()) as any;
    expect(one.config.baseUrl).toBe("https://json2.example.com/v1");
    expect(one.config.models[0].id).toBe("json-model-2");
    // 整体替换：旧字段不残留
    expect(one.config.apiKey).toBeUndefined();

    const other = (await (
      await fetch(`${BASE}/api/me/models/providers/keep-gw`, { headers: h(jsonUser) })
    ).json()) as any;
    expect(other.config.models[0].id).toBe("keep-model");

    expect(
      (await fetch(`${BASE}/api/me/models/providers/json-gw`, { method: "DELETE", headers: h(jsonUser) })).status,
    ).toBe(200);
    expect((await fetch(`${BASE}/api/me/models/providers/json-gw`, { headers: h(jsonUser) })).status).toBe(404);
    expect(
      (await fetch(`${BASE}/api/me/models/providers/json-gw`, { method: "DELETE", headers: h(jsonUser) })).status,
    ).toBe(404);

    const view = (await (
      await fetch(`${BASE}/api/me/models/config?format=json`, { headers: h(jsonUser) })
    ).json()) as any;
    expect(Object.keys(view.config.providers)).toEqual(["keep-gw"]);
  });

  test("结构化校验：非法 provider id/models[].id/重复 id/类型错误 → 400", async () => {
    const put = (body: unknown, uid = "json-bad") =>
      fetch(`${BASE}/api/me/models/config`, { method: "PUT", headers: h(uid), body: JSON.stringify(body) });

    const cases: Array<[unknown, string]> = [
      [{ providers: [] }, "INVALID_CONFIG"],
      [{ providers: { "Bad Id": {} } }, "INVALID_PROVIDER"],
      [{ providers: { p: { models: [{ name: "no-id" }] } } }, "INVALID_CONFIG"],
      [{ providers: { p: { models: [{ id: "m" }, { id: "m" }] } } }, "INVALID_CONFIG"],
      [{ providers: { p: { models: [{ id: "m", contextWindow: -1 }] } } }, "INVALID_CONFIG"],
      [{ providers: { p: { headers: { x: 1 } } } }, "INVALID_CONFIG"],
      [{ providers: { p: { models: "nope" } } }, "INVALID_CONFIG"],
    ];
    for (const [body, code] of cases) {
      const r = await put(body);
      expect(r.status).toBe(400);
      expect(((await r.json()) as any).error.code).toBe(code);
    }
    // 强制 JSON 但语法错误
    const bad = await fetch(`${BASE}/api/me/models/config?format=json`, {
      method: "PUT",
      headers: h("json-bad"),
      body: "{not-json",
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error.code).toBe("INVALID_JSON");
    // 单 provider 非对象
    const one = await fetch(`${BASE}/api/me/models/providers/p`, {
      method: "PUT",
      headers: h("json-bad"),
      body: JSON.stringify(["nope"]),
    });
    expect(one.status).toBe(400);
  });

  test("结构化配置按用户隔离；schema 自描述含字段/正则/示例", async () => {
    const other = (await (
      await fetch(`${BASE}/api/me/models/config?format=json`, { headers: h("json-other") })
    ).json()) as any;
    expect(other.config.providers).toEqual({});

    const schema = (await (await fetch(`${BASE}/api/me/config/schema`, { headers: h(jsonUser) })).json()) as any;
    expect(schema.models.providerIdPattern).toBeString();
    expect(schema.models.providerFields.map((f: any) => f.key)).toContain("baseUrl");
    expect(schema.models.modelFields.map((f: any) => f.key)).toContain("contextWindow");
    expect(schema.models.example.providers.minimax.models[0].id).toBe("MiniMax-M3.1-Flash");
    expect(schema.agents.fields.map((f: any) => f.name)).toContain("instructions");
    expect(schema.agents.example.instructions).toBeString();
  });
});

describe("Provider 设置（disabledProviders）", () => {
  test("GET 默认空；PUT 写入 → GET 可见 → 清空", async () => {
    let b = (await (await fetch(`${BASE}/api/me/providers/settings`, { headers: h("pu") })).json()) as any;
    expect(Array.isArray(b.disabledProviders)).toBeTrue();
    const put = await fetch(`${BASE}/api/me/providers/settings`, {
      method: "PUT",
      headers: h("pu"),
      body: JSON.stringify({ disabledProviders: ["minimax"] }),
    });
    expect(put.status).toBe(200);
    b = (await (await fetch(`${BASE}/api/me/providers/settings`, { headers: h("pu") })).json()) as any;
    expect(b.disabledProviders).toContain("minimax");
    // provider 视图反映 disabled
    const view = (await (await fetch(`${BASE}/api/me/providers`, { headers: h("pu") })).json()) as any;
    expect(view.providers.find((p: any) => p.id === "minimax").disabled).toBeTrue();
    // 清空
    await fetch(`${BASE}/api/me/providers/settings`, {
      method: "PUT",
      headers: h("pu"),
      body: '{"disabledProviders":[]}',
    });
    b = (await (await fetch(`${BASE}/api/me/providers/settings`, { headers: h("pu") })).json()) as any;
    expect(b.disabledProviders).toEqual([]);
  });

  test("非法 body 400", async () => {
    expect(
      (
        await fetch(`${BASE}/api/me/providers/settings`, {
          method: "PUT",
          headers: h("pu"),
          body: "{}",
        })
      ).status,
    ).toBe(400);
  });

  test("按用户隔离：他人看不到我的设置", async () => {
    await fetch(`${BASE}/api/me/providers/settings`, {
      method: "PUT",
      headers: h("pu"),
      body: JSON.stringify({ disabledProviders: ["x"] }),
    });
    const other = (await (await fetch(`${BASE}/api/me/providers/settings`, { headers: h("other") })).json()) as any;
    expect(other.disabledProviders).toEqual([]);
    await fetch(`${BASE}/api/me/providers/settings`, {
      method: "PUT",
      headers: h("pu"),
      body: '{"disabledProviders":[]}',
    });
  });
});

describe("模型搜索（find）", () => {
  test("按 provider/modelId/name 命中；不命中为空", async () => {
    const hit = (await (await fetch(`${BASE}/api/me/models?find=minimax`, { headers: h("pu") })).json()) as any;
    expect(hit.models.length).toBeGreaterThan(0);
    expect(hit.models.every((m: any) => JSON.stringify(m).toLowerCase().includes("minimax"))).toBeTrue();
    const miss = (await (
      await fetch(`${BASE}/api/me/models?find=zzz-no-such-model`, { headers: h("pu") })
    ).json()) as any;
    expect(miss.models).toEqual([]);
    // 与 provider 过滤组合
    const combo = (await (
      await fetch(`${BASE}/api/me/models?provider=minimax&find=flash`, { headers: h("pu") })
    ).json()) as any;
    expect(combo.models.every((m: any) => m.provider === "minimax")).toBeTrue();
  });
});
