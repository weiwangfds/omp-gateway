/**
 * 角色与 Agent 定义面（DESIGN §28，对齐 docs/roles + docs/agents-and-roles + docs/subagent-authoring + docs/mcp）：
 * - 模型角色：modelRoles / cycleOrder 读写（用户级 config.yml）
 * - Agent 定义：agentDir/agents/*.md 用户级 CRUD + frontmatter 校验
 * - MCP 用户级设置：disabledServers/enabledServers
 * - 会话级：agents/definitions、mcp/servers
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 8951;
const BASE = `http://127.0.0.1:${PORT}`;
const TOK = "roles-token";
const h = (uid: string) => ({ authorization: `Bearer ${TOK}`, "content-type": "application/json", "x-user-id": uid });
const md = (uid: string) => ({ authorization: `Bearer ${TOK}`, "content-type": "text/markdown", "x-user-id": uid });

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
const mmKey = readMiniMaxKey();
const liveOk = mmKey !== null;
const dataRoot = mkdtempSync(path.join(tmpdir(), "omp-roles-"));
let proc: Bun.Subprocess | null = null;
let sid = "";

const AGENT_MD = [
  "---",
  "name: release-auditor",
  "description: Check release readiness and report concrete blockers.",
  "tools: read, grep, glob, bash",
  'model: "@slow"',
  "prewalk: false",
  'advisor: "@advisor"',
  "---",
  "",
  "You audit releases. Report blockers as a bulleted list.",
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
  if (liveOk) {
    await fetch(`${BASE}/api/me/models/config`, {
      method: "PUT",
      headers: h("ru"),
      body: [
        "providers:",
        "  minimax:",
        "    baseUrl: https://api.minimax.cn/v1",
        "    api: openai-completions",
        "    models:",
        "      - id: MiniMax-M3.1-Flash",
        "        name: MiniMax M3.1 Flash",
        "",
      ].join("\n"),
    });
    await fetch(`${BASE}/api/me/models/credentials`, {
      method: "POST",
      headers: h("ru"),
      body: JSON.stringify({ provider: "minimax", apiKey: mmKey }),
    });
  }
  const created = await (await fetch(`${BASE}/api/sessions`, { method: "POST", headers: h("ru"), body: "{}" })).json();
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

describe("模型角色（roles）", () => {
  test("GET 默认：roles 空、cycleOrder 默认、roleStorage=global", async () => {
    const b = (await (await fetch(`${BASE}/api/me/model-roles`, { headers: h("ru") })).json()) as any;
    expect(b.roles).toEqual({});
    expect(b.cycleOrder).toEqual(["smol", "default", "slow"]);
    expect(b.roleStorage).toBe("global");
  });

  test("PUT roles（含 @role/thinking 后缀）→ GET 往返", async () => {
    const put = await fetch(`${BASE}/api/me/model-roles`, {
      method: "PUT",
      headers: h("ru"),
      body: JSON.stringify({
        roles: { default: "minimax/MiniMax-M3.1-Flash", slow: "minimax/MiniMax-M3.1-Flash:high", smol: "@default" },
      }),
    });
    expect(put.status).toBe(200);
    const b = (await (await fetch(`${BASE}/api/me/model-roles`, { headers: h("ru") })).json()) as any;
    expect(b.roles.default).toContain("MiniMax");
    expect(b.roles.slow).toContain(":high");
    expect(b.roles.smol).toBe("@default");
  });

  test("PUT cycleOrder → 往返；非法角色名/空体 400", async () => {
    expect(
      (
        await fetch(`${BASE}/api/me/model-roles`, {
          method: "PUT",
          headers: h("ru"),
          body: JSON.stringify({ cycleOrder: ["default", "smol"] }),
        })
      ).status,
    ).toBe(200);
    const b = (await (await fetch(`${BASE}/api/me/model-roles`, { headers: h("ru") })).json()) as any;
    expect(b.cycleOrder).toEqual(["default", "smol"]);
    expect(
      (
        await fetch(`${BASE}/api/me/model-roles`, {
          method: "PUT",
          headers: h("ru"),
          body: JSON.stringify({ roles: { "Bad Role": "x/y" } }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${BASE}/api/me/model-roles`, {
          method: "PUT",
          headers: h("ru"),
          body: JSON.stringify({ roles: { default: "" } }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${BASE}/api/me/model-roles`, {
          method: "PUT",
          headers: h("ru"),
          body: "{}",
        })
      ).status,
    ).toBe(400);
  });

  test("跨用户隔离", async () => {
    const other = (await (await fetch(`${BASE}/api/me/model-roles`, { headers: h("other") })).json()) as any;
    expect(other.roles).toEqual({});
  });
});

describe("Agent 定义（agents-and-roles / subagent-authoring）", () => {
  test("PUT → 列表解析 frontmatter → GET 原文 → DELETE", async () => {
    const put = await fetch(`${BASE}/api/me/agents/release-auditor`, {
      method: "PUT",
      headers: md("ru"),
      body: AGENT_MD,
    });
    expect(put.status).toBe(201);
    const list = (await (await fetch(`${BASE}/api/me/agents`, { headers: h("ru") })).json()) as any;
    const a = list.agents.find((x: any) => x.name === "release-auditor");
    expect(a).toBeTruthy();
    expect(a.valid).toBeTrue();
    expect(a.tools).toEqual(["read", "grep", "glob", "bash"]);
    expect(a.model).toEqual(["@slow"]);
    expect(a.prewalk).toBeFalse();
    expect(a.advisor).toBe("@advisor");
    expect(a.instructionsChars).toBeGreaterThan(10);
    const raw = await (await fetch(`${BASE}/api/me/agents/release-auditor`, { headers: h("ru") })).text();
    expect(raw).toContain("release-auditor");
    expect(raw).toContain("You audit releases");
    expect((await fetch(`${BASE}/api/me/agents/release-auditor`, { method: "DELETE", headers: h("ru") })).status).toBe(
      200,
    );
    expect((await fetch(`${BASE}/api/me/agents/release-auditor`, { headers: h("ru") })).status).toBe(404);
  });

  test("frontmatter 校验：缺 frontmatter / 缺 description / name 与路径不符 400", async () => {
    const put = (name: string, body: string) =>
      fetch(`${BASE}/api/me/agents/${name}`, { method: "PUT", headers: md("ru"), body });
    expect((await put("no-fm", "just text")).status).toBe(400);
    expect((await put("no-desc", "---\nname: no-desc\n---\nbody")).status).toBe(400);
    expect((await put("mismatch", "---\nname: other\ndescription: d\n---\nbody")).status).toBe(400);
    expect((await put("empty-body", "---\nname: empty-body\ndescription: d\n---\n")).status).toBe(400);
  });

  test("非法名 400；跨用户隔离", async () => {
    expect(
      (await fetch(`${BASE}/api/me/agents/Bad_Name`, { method: "PUT", headers: md("ru"), body: AGENT_MD })).status,
    ).toBe(400);
    await fetch(`${BASE}/api/me/agents/iso-agent`, {
      method: "PUT",
      headers: md("ru"),
      body: "---\nname: iso-agent\ndescription: d\n---\nbody\n",
    });
    const other = (await (await fetch(`${BASE}/api/me/agents`, { headers: h("other") })).json()) as any;
    expect(other.agents.some((x: any) => x.name === "iso-agent")).toBeFalse();
    await fetch(`${BASE}/api/me/agents/iso-agent`, { method: "DELETE", headers: h("ru") });
  });
});

describe("Agent 定义结构化 JSON（DESIGN §30）", () => {
  test("PUT application/json → 组合 frontmatter；列表与 ?format=json 往返", async () => {
    const payload = {
      description: "Check release readiness and report concrete blockers.",
      tools: ["read", "grep", "glob", "bash"],
      model: "@slow",
      thinkingLevel: "high",
      spawns: "*",
      autoloadSkills: ["release-checklist"],
      readSummarize: false,
      blocking: false,
      prewalk: false,
      advisor: "@advisor",
      output: { type: "object", properties: { blockers: { type: "array", items: { type: "string" } } } },
      instructions: "You audit releases. Report blockers as a bulleted list.",
    };
    const put = await fetch(`${BASE}/api/me/agents/structured-bot`, {
      method: "PUT",
      headers: h("ru"),
      body: JSON.stringify(payload),
    });
    expect(put.status).toBe(201);
    expect(((await put.json()) as any).format).toBe("json");

    const list = (await (await fetch(`${BASE}/api/me/agents`, { headers: h("ru") })).json()) as any;
    const a = list.agents.find((x: any) => x.name === "structured-bot");
    expect(a).toBeTruthy();
    expect(a.valid).toBeTrue();
    expect(a.tools).toEqual(["read", "grep", "glob", "bash"]);
    expect(a.model).toEqual(["@slow"]);
    expect(a.thinkingLevel).toBe("high");
    expect(a.spawns).toBe("*");
    expect(a.autoloadSkills).toEqual(["release-checklist"]);
    expect(a.readSummarize).toBeFalse();
    expect(a.blocking).toBeFalse();
    expect(a.prewalk).toBeFalse();
    expect(a.advisor).toBe("@advisor");
    expect(a.hasOutputSchema).toBeTrue();

    // 落盘为 SDK parseAgentFields 读取的 camelCase 键
    const raw = await (await fetch(`${BASE}/api/me/agents/structured-bot`, { headers: h("ru") })).text();
    expect(raw).toContain("thinkingLevel: high");
    expect(raw).toContain("autoloadSkills:");
    expect(raw).toContain('advisor: "@advisor"');
    expect(raw).toContain("You audit releases");

    const dto = (await (
      await fetch(`${BASE}/api/me/agents/structured-bot?format=json`, { headers: h("ru") })
    ).json()) as any;
    expect(dto.name).toBe("structured-bot");
    expect(dto.description).toContain("release readiness");
    expect(dto.tools).toEqual(["read", "grep", "glob", "bash"]);
    expect(dto.thinkingLevel).toBe("high");
    expect(dto.instructions).toContain("bulleted list");
    expect(dto.frontmatter.name).toBe("structured-bot");
    expect(dto.frontmatter.output.type).toBe("object");

    await fetch(`${BASE}/api/me/agents/structured-bot`, { method: "DELETE", headers: h("ru") });
  });

  test("POST /api/me/agents：name 取自 body；content 原文通道等价于 markdown PUT", async () => {
    const created = await fetch(`${BASE}/api/me/agents`, {
      method: "POST",
      headers: h("ru"),
      body: JSON.stringify({ name: "posted-bot", description: "Created by POST", instructions: "Do posted work." }),
    });
    expect(created.status).toBe(201);
    expect(((await created.json()) as any).name).toBe("posted-bot");
    // POST=创建；同名重复 → 409（更新用 PUT）
    const dup = await fetch(`${BASE}/api/me/agents`, {
      method: "POST",
      headers: h("ru"),
      body: JSON.stringify({ name: "posted-bot", description: "dup", instructions: "dup" }),
    });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as any).error.code).toBe("ALREADY_EXISTS");
    const rawPost = await (await fetch(`${BASE}/api/me/agents/posted-bot`, { headers: h("ru") })).text();
    expect(rawPost).toContain("name: posted-bot");
    expect(rawPost).toContain("Do posted work.");

    const content = [
      "---",
      "name: content-bot",
      "description: Raw content agent",
      "tools: read, grep",
      "---",
      "",
      "Raw content instructions.",
      "",
    ].join("\n");
    const put = await fetch(`${BASE}/api/me/agents/content-bot`, {
      method: "PUT",
      headers: h("ru"),
      body: JSON.stringify({ content }),
    });
    expect(put.status).toBe(201);
    expect(await (await fetch(`${BASE}/api/me/agents/content-bot`, { headers: h("ru") })).text()).toBe(content);

    await fetch(`${BASE}/api/me/agents/posted-bot`, { method: "DELETE", headers: h("ru") });
    await fetch(`${BASE}/api/me/agents/content-bot`, { method: "DELETE", headers: h("ru") });
  });

  test("结构化校验：未知字段/缺字段/别名冲突/name 不符/content 混用 → 400", async () => {
    const put = (name: string, body: unknown) =>
      fetch(`${BASE}/api/me/agents/${name}`, { method: "PUT", headers: h("ru"), body: JSON.stringify(body) });

    const cases: Array<[string, unknown, string]> = [
      ["bad-1", { description: "d", instructions: "i", typoField: 1 }, "INVALID_AGENT"],
      ["bad-2", { instructions: "i" }, "INVALID_AGENT"],
      ["bad-3", { description: "d" }, "INVALID_AGENT"],
      ["bad-4", { description: "d", instructions: "i", tools: [1] }, "INVALID_AGENT"],
      ["bad-5", { description: "d", instructions: "i", prewalk: "" }, "INVALID_AGENT"],
      [
        "bad-6",
        { description: "d", instructions: "i", thinkingLevel: "high", "thinking-level": "low" },
        "INVALID_AGENT",
      ],
      ["bad-7", { name: "other-name", description: "d", instructions: "i" }, "INVALID_AGENT"],
      ["bad-8", { content: "---\nname: bad-8\ndescription: d\n---\nbody\n", tools: ["read"] }, "INVALID_AGENT"],
    ];
    for (const [name, body, code] of cases) {
      const r = await put(name, body);
      expect(r.status).toBe(400);
      expect(((await r.json()) as any).error.code).toBe(code);
    }
    // POST 缺 name
    const post = await fetch(`${BASE}/api/me/agents`, {
      method: "POST",
      headers: h("ru"),
      body: JSON.stringify({ description: "d", instructions: "i" }),
    });
    expect(post.status).toBe(400);
    expect(((await post.json()) as any).error.code).toBe("INVALID_NAME");
  });
});

describe("MCP 用户级设置（mcp）", () => {
  test("GET 默认空；PUT disabledServers → 写入 mcp.json → GET 可见", async () => {
    const put = await fetch(`${BASE}/api/me/mcp/settings`, {
      method: "PUT",
      headers: h("ru"),
      body: JSON.stringify({ disabledServers: ["noisy-server"] }),
    });
    expect(put.status).toBe(200);
    const b = (await (await fetch(`${BASE}/api/me/mcp/settings`, { headers: h("ru") })).json()) as any;
    expect(b.disabledServers).toContain("noisy-server");
    expect(
      (
        await fetch(`${BASE}/api/me/mcp/settings`, {
          method: "PUT",
          headers: h("ru"),
          body: JSON.stringify({ disabledServers: [] }),
        })
      ).status,
    ).toBe(200);
  });

  test("非法 body 400（非数组/空体）", async () => {
    expect(
      (
        await fetch(`${BASE}/api/me/mcp/settings`, {
          method: "PUT",
          headers: h("ru"),
          body: JSON.stringify({ disabledServers: "x" }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${BASE}/api/me/mcp/settings`, {
          method: "PUT",
          headers: h("ru"),
          body: "{}",
        })
      ).status,
    ).toBe(400);
  });
});

describe.skipIf(!liveOk)("会话级：agent 定义与 MCP 服务器", () => {
  test("agents/definitions：返回定义清单与 advertised 标记", async () => {
    const b = (await (
      await fetch(`${BASE}/api/sessions/${sid}/agents/definitions`, { headers: h("ru") })
    ).json()) as any;
    expect(Array.isArray(b.definitions)).toBeTrue();
    expect(typeof b.total).toBe("number");
    for (const d of b.definitions.slice(0, 5)) {
      expect(typeof d.name).toBe("string");
      expect(typeof d.advertised).toBe("boolean");
    }
  });

  test("mcp/servers：无服务器时结构完整（或 409 MCP_DISABLED）", async () => {
    const r = await fetch(`${BASE}/api/sessions/${sid}/mcp/servers`, { headers: h("ru") });
    expect([200, 409]).toContain(r.status);
    if (r.status === 200) {
      const b = (await r.json()) as any;
      expect(Array.isArray(b.servers)).toBeTrue();
      expect(Array.isArray(b.connected)).toBeTrue();
    }
  });
});
