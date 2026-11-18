/** Agent 定义 CRUD（DESIGN §28/§30）：agents/*.md 原文与结构化 JSON 双通道 + 校验。 */
import type { Hono } from "hono";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  AGENT_NAME_RE,
  agentDefinitionDto,
  agentDocumentFromMarkdown,
  isStructuredBody,
  normalizeAgentDefinition,
  parseJsonText,
  readJsonBody,
  respondCodecError,
  tryParseAgentMarkdown,
  type AgentDocument,
} from "../../core/config-codec.ts";
import { globalAgentsDir, userAgentDir } from "../../core/paths.ts";
import { audit } from "../../core/tenant-store.ts";
import type { AgentConfigEnv } from "./env.ts";

const asList = (v: unknown): string[] | null => {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string" && v.trim())
    return v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return null;
};

/** 扫描 agent 定义目录（*.md），带 scope 标签（user/global）；目录不存在返回空。 */
async function describeAgentFiles(dir: string, scope: "user" | "global"): Promise<Array<Record<string, unknown>>> {
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  const agents: Array<Record<string, unknown>> = [];
  for (const file of entries) {
    if (!file.endsWith(".md")) continue;
    const full = path.join(dir, file);
    // 根目录边界校验（词法）：join 结果必须仍位于 dir 内（readdir 理论上不含路径段，双保险）
    const root = path.resolve(dir);
    const target = path.resolve(full);
    if (target !== root && !target.startsWith(root + path.sep)) continue;
    const st = await fs.stat(full).catch(() => null);
    if (!st?.isFile()) continue;
    const text = await fs.readFile(full, "utf8").catch(() => "");
    const parsed = tryParseAgentMarkdown(text);
    const fm = parsed?.frontmatter ?? null;
    const body = parsed ? parsed.instructions : text;
    const nameFromFile = file.replace(/\.md$/, "");
    const name = String(fm?.name ?? nameFromFile);
    agents.push({
      name,
      file,
      scope,
      valid: Boolean(fm?.name && fm?.description),
      ...(typeof fm?.description === "string" ? { description: fm.description } : {}),
      tools: asList(fm?.tools),
      model: asList(fm?.model),
      thinkingLevel: fm?.["thinking-level"] ?? fm?.thinkingLevel ?? fm?.thinking ?? null,
      spawns: fm?.spawns === "*" ? "*" : asList(fm?.spawns),
      autoloadSkills: asList(fm?.["autoload-skills"] ?? fm?.autoloadSkills),
      readSummarize: fm?.["read-summarize"] ?? fm?.readSummarize ?? null,
      structured: fm?.structured ?? null,
      blocking: fm?.blocking ?? null,
      prewalk: fm?.prewalk ?? null,
      advisor: fm?.advisor ?? null,
      hasOutputSchema: fm?.output !== undefined,
      instructionsChars: body.trim().length,
      bytes: st.size,
      updatedAt: st.mtime.toISOString(),
      // 名字与文件名不一致会被 SDK 按 frontmatter name 注册（提示修正）
      ...(name !== nameFromFile
        ? { warning: `frontmatter name "${name}" differs from filename "${nameFromFile}"` }
        : {}),
    });
  }
  return agents.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/** Agent 定义 CRUD：agentDir/agents/*.md 原文与结构化 JSON 双通道（DESIGN §28/§30）。 */
export function mountAgentDefinitionRoutes(app: Hono<AgentConfigEnv>): void {
  // ---- Agent 定义（docs/agents-and-roles + docs/subagent-authoring）----

  const agentsDir = (uid: string) => path.join(userAgentDir(uid), "agents");

  app.get("/me/agents", async (c) => {
    const uid = c.get("userId");
    const agents = await describeAgentFiles(agentsDir(uid), "user");
    // 全局定义合成进各会话 workspace（composeAgentsForWorkspace）；这里仅清单可见性
    agents.push(...(await describeAgentFiles(globalAgentsDir(), "global")));
    return c.json({
      agents,
      dir: "agent/agents/",
      precedence: "project(.omp/agents) > user(agentDir/agents) > extension > bundled",
    });
  });

  app.get("/me/agents/:name", async (c) => {
    const uid = c.get("userId");
    const name = c.req.param("name");
    if (!AGENT_NAME_RE.test(name)) {
      return c.json({ error: { code: "INVALID_NAME", message: "name must match ^[a-z][a-z0-9-]{0,63}$" } }, 400);
    }
    const content = await fs.readFile(path.join(agentsDir(uid), `${name}.md`), "utf8").catch(() => null);
    if (content == null) {
      return c.json({ error: { code: "NOT_FOUND", message: "agent definition not found" } }, 404);
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

  async function persistAgent(uid: string, doc: AgentDocument, format: "json" | "markdown"): Promise<number> {
    await fs.mkdir(agentsDir(uid), { recursive: true });
    await fs.writeFile(path.join(agentsDir(uid), `${doc.name}.md`), doc.markdown, "utf8");
    audit("config.agent.write", "agent", doc.name, uid, { bytes: doc.markdown.length, format });
    return doc.markdown.length;
  }

  app.put("/me/agents/:name", async (c) => {
    const uid = c.get("userId");
    const name = c.req.param("name");
    if (!AGENT_NAME_RE.test(name)) {
      return c.json({ error: { code: "INVALID_NAME", message: "name must match ^[a-z][a-z0-9-]{0,63}$" } }, 400);
    }
    const body = await c.req.text();
    const structured = isStructuredBody(c, body);
    try {
      const doc = structured
        ? normalizeAgentDefinition(name, parseJsonText(body))
        : agentDocumentFromMarkdown(name, body);
      const bytes = await persistAgent(uid, doc, structured ? "json" : "markdown");
      return c.json(
        {
          ok: true,
          name: doc.name,
          bytes,
          format: structured ? "json" : "markdown",
          note: "delegation re-reads definitions on next use; new sessions also pick it up",
        },
        201,
      );
    } catch (err) {
      return respondCodecError(c, err);
    }
  });

  /** 结构化创建（name 取自 body.name；`{content}` 通道则取自 frontmatter）。 */
  app.post("/me/agents", async (c) => {
    const uid = c.get("userId");
    try {
      const doc = normalizeAgentDefinition(null, await readJsonBody(c));
      const exists = await fs.stat(path.join(agentsDir(uid), `${doc.name}.md`)).catch(() => null);
      if (exists?.isFile()) {
        return c.json(
          { error: { code: "ALREADY_EXISTS", message: `agent "${doc.name}" already exists; use PUT to update` } },
          409,
        );
      }
      const bytes = await persistAgent(uid, doc, "json");
      return c.json({ ok: true, name: doc.name, bytes, format: "json", note: "agent definition created" }, 201);
    } catch (err) {
      return respondCodecError(c, err);
    }
  });

  app.delete("/me/agents/:name", async (c) => {
    const uid = c.get("userId");
    const name = c.req.param("name");
    if (!AGENT_NAME_RE.test(name)) {
      return c.json({ error: { code: "INVALID_NAME", message: "name must match ^[a-z][a-z0-9-]{0,63}$" } }, 400);
    }
    const file = path.join(agentsDir(uid), `${name}.md`);
    const exists = await fs.stat(file).catch(() => null);
    if (!exists?.isFile()) return c.json({ error: { code: "NOT_FOUND", message: "agent definition not found" } }, 404);
    await fs.rm(file, { force: true });
    audit("config.agent.delete", "agent", name, uid);
    return c.json({ ok: true });
  });
}
