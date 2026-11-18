/** 全局层管理（DESIGN §18）：全局 skills/plugins/MCP/agents 的 CRUD，X-Admin-Id 门禁。 */
import { Hono } from "hono";
import * as fs from "node:fs/promises";
import path from "node:path";
import { writeMcpFileText } from "../core/mcp-registry.ts";
import { globalMcpPath, globalSkillsDir, globalExtensionsDir, globalAgentsDir } from "../core/paths.ts";
import {
  AGENT_NAME_RE,
  agentDefinitionDto,
  agentDocumentFromMarkdown,
  isStructuredBody,
  normalizeAgentDefinition,
  parseJsonText,
  respondCodecError,
  tryParseAgentMarkdown,
  type AgentDocument,
} from "../core/config-codec.ts";
import {
  ManagementError,
  assertPluginName,
  deletePlugin,
  deleteSkill,
  listPluginsIn,
  listSkillsIn,
  readSkill,
  writePlugin,
  writeSkill,
} from "../core/registry-management.ts";
import { audit } from "../core/tenant-store.ts";
import { requireAdmin } from "../middleware/auth.ts";
import { kbAdminApp } from "./admin-kb.ts";
import { wrenAdminApp } from "./admin-wren.ts";

/**
 * 全局层管理（DESIGN §18 / §38 / §39）：/admin/global/{mcp,skills,plugins,agents}
 * + /admin/kb/*（知识库）+ /admin/wren/*（数据查询语义层）。
 * 权限模型：网关自身无权限体系——上级注入 X-Admin-Id 标识即视为管理层调用，
 * actor 记入审计（谁在管理由上游负责）。
 */
export const adminApp = new Hono();
adminApp.use("*", requireAdmin);

const mgmtErr = (c: any, err: unknown) => {
  if (err instanceof ManagementError) return c.json({ error: { code: err.code, message: err.message } }, 400);
  console.error("[admin]", err);
  return c.json({ error: { code: "INTERNAL", message: "management operation failed" } }, 500);
};
const actor = (c: any): string => c.get("adminId") ?? "admin";

// ---- 全局 skills ----
adminApp.get("/global/skills", async (c) => c.json({ skills: await listSkillsIn(globalSkillsDir()) }));

adminApp.get("/global/skills/:name", async (c) => {
  try {
    const content = await readSkill(globalSkillsDir(), c.req.param("name"));
    return content != null
      ? c.body(content, 200, { "content-type": "text/plain; charset=utf-8" })
      : c.json({ error: { code: "NOT_FOUND", message: "skill not found" } }, 404);
  } catch (err) {
    return mgmtErr(c, err);
  }
});

adminApp.put("/global/skills/:name", async (c) => {
  const body = await c.req.json().catch(() => null as any);
  if (typeof body?.description !== "string" || !body.description.trim()) {
    return c.json({ error: { code: "BAD_REQUEST", message: "body.description required" } }, 400);
  }
  try {
    await writeSkill(globalSkillsDir(), c.req.param("name"), { description: body.description, content: body?.content });
    audit("admin.global_skill.write", "global", c.req.param("name"), actor(c));
    return c.json({ ok: true, name: c.req.param("name"), scope: "global" }, 201);
  } catch (err) {
    return mgmtErr(c, err);
  }
});

adminApp.delete("/global/skills/:name", async (c) => {
  const ok = await deleteSkill(globalSkillsDir(), c.req.param("name"));
  if (ok) audit("admin.global_skill.delete", "global", c.req.param("name"), actor(c));
  return ok ? c.json({ ok: true }) : c.json({ error: { code: "NOT_FOUND", message: "skill not found" } }, 404);
});

// ---- 全局 plugins（extensions）----
adminApp.get("/global/plugins", async (c) => c.json({ plugins: await listPluginsIn(globalExtensionsDir()) }));

adminApp.get("/global/plugins/:name", async (c) => {
  const name = c.req.param("name");
  try {
    assertPluginName(name); // 命名净化：杜绝 ../ 穿越读取
  } catch (err) {
    return mgmtErr(c, err);
  }
  try {
    const content = await fs.readFile(path.join(globalExtensionsDir(), name), "utf8");
    return c.body(content, 200, { "content-type": "text/plain; charset=utf-8" });
  } catch {
    return c.json({ error: { code: "NOT_FOUND", message: "plugin not found" } }, 404);
  }
});

adminApp.put("/global/plugins/:name", async (c) => {
  const body = await c.req.text().catch(() => "");
  try {
    const r = await writePlugin(
      globalExtensionsDir(),
      c.req.param("name"),
      typeof body === "string" && body ? body : "",
    );
    audit("admin.global_plugin.write", "global", c.req.param("name"), actor(c), { bytes: r.bytes });
    return c.json({ ok: true, name: c.req.param("name"), scope: "global", ...r }, 201);
  } catch (err) {
    return mgmtErr(c, err);
  }
});

adminApp.delete("/global/plugins/:name", async (c) => {
  const ok = await deletePlugin(globalExtensionsDir(), c.req.param("name"));
  if (ok) audit("admin.global_plugin.delete", "global", c.req.param("name"), actor(c));
  return ok ? c.json({ ok: true }) : c.json({ error: { code: "NOT_FOUND", message: "plugin not found" } }, 404);
});

// ---- 全局 mcp.json ----
adminApp.get("/global/mcp", async (c) => {
  try {
    return c.body(await fs.readFile(globalMcpPath(), "utf8"), 200, { "content-type": "application/json" });
  } catch {
    return c.body(JSON.stringify({ mcpServers: {} }, null, 2), 200, { "content-type": "application/json" });
  }
});

adminApp.put("/global/mcp", async (c) => {
  const text = await c.req.text();
  try {
    JSON.parse(text);
  } catch (err) {
    return c.json({ error: { code: "INVALID_JSON", message: String(err) } }, 400);
  }
  // 走 mcp-registry 的串行锁：与 wren/qmd 的 upsert/remove 并发时不丢对方刚写入的键
  await writeMcpFileText(text);
  audit("admin.global_mcp.write", "global", "mcp.json", actor(c), { bytes: text.length });
  return c.json({ ok: true, note: "applies to new sessions (compose at session create)" });
});

// ---- 全局 agents（定义与 /api/me/agents 同构；合成进各用户 workspace 的 .omp/agents）----
const agentFile = (name: string) => path.join(globalAgentsDir(), `${name}.md`);

const listAgentFilesIn = async (dir: string) => {
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  const agents: Array<Record<string, unknown>> = [];
  for (const file of entries) {
    if (!file.endsWith(".md")) continue;
    const st = await fs.stat(path.join(dir, file)).catch(() => null);
    if (!st?.isFile()) continue;
    const text = await fs.readFile(path.join(dir, file), "utf8").catch(() => "");
    const fm = tryParseAgentMarkdown(text)?.frontmatter ?? null;
    agents.push({
      name: String(fm?.name ?? file.replace(/\.md$/, "")),
      file,
      valid: Boolean(fm?.name && fm?.description),
      ...(typeof fm?.description === "string" ? { description: fm.description } : {}),
      tools: Array.isArray(fm?.tools) ? fm.tools.map(String) : typeof fm?.tools === "string" ? fm.tools : null,
      model: Array.isArray(fm?.model) ? fm.model.map(String) : typeof fm?.model === "string" ? fm.model : null,
      bytes: st.size,
      updatedAt: st.mtime.toISOString(),
    });
  }
  return agents.sort((a, b) => String(a.name).localeCompare(String(b.name)));
};

adminApp.get("/global/agents", async (c) => c.json({ agents: await listAgentFilesIn(globalAgentsDir()) }));

adminApp.get("/global/agents/:name", async (c) => {
  const name = c.req.param("name");
  if (!AGENT_NAME_RE.test(name)) {
    return c.json({ error: { code: "INVALID_NAME", message: "name must match ^[a-z][a-z0-9-]{0,63}$" } }, 400);
  }
  const content = await fs.readFile(agentFile(name), "utf8").catch(() => null);
  if (content == null) {
    return c.json({ error: { code: "NOT_FOUND", message: "global agent definition not found" } }, 404);
  }
  if (c.req.query("format") === "json") {
    try {
      return c.json({ format: "json", ...agentDefinitionDto(name, content) });
    } catch (err) {
      return respondCodecError(c, err);
    }
  }
  return c.body(content, 200, { "content-type": "text/markdown; charset=utf-8" });
});

adminApp.put("/global/agents/:name", async (c) => {
  const name = c.req.param("name");
  if (!AGENT_NAME_RE.test(name)) {
    return c.json({ error: { code: "INVALID_NAME", message: "name must match ^[a-z][a-z0-9-]{0,63}$" } }, 400);
  }
  const body = await c.req.text();
  try {
    const structured = isStructuredBody(c, body);
    const doc: AgentDocument = structured
      ? normalizeAgentDefinition(name, parseJsonText(body))
      : agentDocumentFromMarkdown(name, body);
    await fs.mkdir(globalAgentsDir(), { recursive: true });
    await fs.writeFile(agentFile(doc.name), doc.markdown, "utf8");
    audit("admin.global_agent.write", "global", doc.name, actor(c), {
      bytes: doc.markdown.length,
      format: structured ? "json" : "markdown",
    });
    return c.json(
      { ok: true, name: doc.name, scope: "global", note: "applies to new sessions (compose at session create)" },
      201,
    );
  } catch (err) {
    return respondCodecError(c, err);
  }
});

adminApp.delete("/global/agents/:name", async (c) => {
  const name = c.req.param("name");
  if (!AGENT_NAME_RE.test(name)) {
    return c.json({ error: { code: "INVALID_NAME", message: "name must match ^[a-z][a-z0-9-]{0,63}$" } }, 400);
  }
  const file = agentFile(name);
  const exists = await fs.stat(file).catch(() => null);
  if (!exists?.isFile()) {
    return c.json({ error: { code: "NOT_FOUND", message: "global agent definition not found" } }, 404);
  }
  await fs.rm(file, { force: true });
  audit("admin.global_agent.delete", "global", name, actor(c));
  return c.json({ ok: true });
});

// 知识库管理面（DESIGN §38）：/admin/kb/*
adminApp.route("/kb", kbAdminApp);
// WrenAI 数据源管理面（DESIGN §39.2.1）：/admin/wren/*（运行时增删改查 + rebuild/test）
adminApp.route("/wren", wrenAdminApp);
