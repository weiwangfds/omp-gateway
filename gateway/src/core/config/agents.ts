/** agents/*.md 结构化编解码（DESIGN §30）：字段白名单 ⇄ frontmatter + instructions。 */
import { fail } from "./errors.ts";
import { isRecord, yaml } from "./yaml.ts";

/* ============================ agents/*.md ============================ */

/** Agent 名同时是文件名，限制为安全 kebab-case。 */
export const AGENT_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

export type AgentFieldKind = "string" | "stringList" | "boolean" | "booleanOrString" | "json";

export interface AgentFieldSpec {
  /** 写回 frontmatter 的规范键（camelCase，SDK parseAgentFields 直接读取）。 */
  key: string;
  /** 兼容读取的别名（docs 中出现的 kebab-case / 旧键）。 */
  aliases: readonly string[];
  kind: AgentFieldKind;
  description: string;
}

/**
 * 字段白名单：与 SDK `parseAgentFields`（pi-coding-agent/src/discovery/helpers.ts）对齐。
 * `name`/`description`/`instructions` 单独处理（必填/来自路径）。
 */
export const AGENT_FIELD_SPECS: readonly AgentFieldSpec[] = [
  {
    key: "tools",
    aliases: [],
    kind: "stringList",
    description: "工具白名单（数组或逗号分隔）；[] 表示不允许任何内置工具",
  },
  {
    key: "model",
    aliases: [],
    kind: "stringList",
    description: "模型选择器（provider/model[:level]、@role），可给有序数组",
  },
  {
    key: "thinkingLevel",
    aliases: ["thinking-level", "thinking"],
    kind: "string",
    description: "思考级别（off/minimal/low/medium/high/xhigh/max/auto）",
  },
  {
    key: "spawns",
    aliases: [],
    kind: "stringList",
    description: '可委派的 agent 列表；"*" 表示全部（含 task 工具时默认 "*"）',
  },
  {
    key: "autoloadSkills",
    aliases: ["autoload-skills"],
    kind: "stringList",
    description: "启动时自动加载的 skill 名",
  },
  {
    key: "readSummarize",
    aliases: ["read-summarize"],
    kind: "boolean",
    description: "read 结果摘要开关（false=关闭）",
  },
  { key: "structured", aliases: [], kind: "boolean", description: "task.structured 关闭时仍保留 yield 与输出 schema" },
  { key: "blocking", aliases: [], kind: "boolean", description: "是否阻塞等待该子代理完成" },
  { key: "prewalk", aliases: [], kind: "booleanOrString", description: "true=默认 prewalk 目标；字符串=指定模型模式" },
  {
    key: "advisor",
    aliases: [],
    kind: "booleanOrString",
    description: "true=默认 advisor 角色模型；字符串=指定模型模式",
  },
  { key: "output", aliases: [], kind: "json", description: "结构化输出 JSON Schema" },
];

const AGENT_ALLOWED_KEYS = new Set<string>([
  "name",
  "description",
  "instructions",
  "content",
  ...AGENT_FIELD_SPECS.flatMap((s) => [s.key, ...s.aliases]),
]);

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export interface ParsedAgentMarkdown {
  frontmatter: Record<string, unknown>;
  instructions: string;
}

export interface AgentDocument {
  name: string;
  frontmatter: Record<string, unknown>;
  instructions: string;
  /** 最终落盘内容（结构化输入为组合结果，content 输入为原文）。 */
  markdown: string;
}

/** 解析 frontmatter + 指令正文；缺 frontmatter/YAML 非法/非映射 → ConfigCodecError。 */
export function parseAgentMarkdown(text: string): ParsedAgentMarkdown {
  const m = FRONTMATTER_RE.exec(text);
  if (!m) fail("INVALID_FRONTMATTER", "frontmatter (--- ... ---) required with name and description");
  let parsed: unknown;
  try {
    parsed = yaml().parse(m[1]);
  } catch (err) {
    fail("INVALID_FRONTMATTER", `frontmatter parse failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(parsed)) fail("INVALID_FRONTMATTER", "frontmatter must be a YAML mapping");
  return { frontmatter: parsed, instructions: m[2] ?? "" };
}

/** 列表扫描用：不抛错，坏文件按"无 frontmatter"处理。 */
/** 列表扫描用：不抛错，坏文件按"无 frontmatter"处理。 */
export function tryParseAgentMarkdown(text: string): ParsedAgentMarkdown | null {
  try {
    return parseAgentMarkdown(text);
  } catch {
    return null;
  }
}

function assertAgentName(name: unknown): string {
  const s = typeof name === "string" ? name.trim() : "";
  if (!AGENT_NAME_RE.test(s)) fail("INVALID_NAME", `name "${String(name)}" must match ${AGENT_NAME_RE.source}`);
  return s;
}

function assertNonEmptyString(value: unknown, field: string, maxChars: number): string {
  if (typeof value !== "string" || !value.trim()) {
    fail("INVALID_AGENT", `${field} must be a non-empty string`);
  }
  if (value.length > maxChars) fail("PAYLOAD_TOO_LARGE", `${field} exceeds ${maxChars} chars`);
  return value.trim();
}

function toAgentList(value: unknown, field: string): string[] {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const entry of value) {
      if (typeof entry !== "string") fail("INVALID_AGENT", `${field} entries must be strings`);
      const v = entry.trim();
      if (v) out.push(v);
    }
    return out;
  }
  fail("INVALID_AGENT", `${field} must be a string (CSV) or string[]`);
}

function pickAgentField(input: Record<string, unknown>, spec: AgentFieldSpec): { key: string; value: unknown } | null {
  const keys = [spec.key, ...spec.aliases].filter((k) => input[k] !== undefined);
  if (keys.length === 0) return null;
  if (keys.length > 1) {
    fail("INVALID_AGENT", `${keys.join(" / ")} are aliases; provide only one`);
  }
  return { key: keys[0], value: input[keys[0]] };
}

/** 字段表 → frontmatter 值；`undefined` 表示省略该字段。 */
function coerceAgentField(spec: AgentFieldSpec, value: unknown): unknown {
  switch (spec.kind) {
    case "string":
      return assertNonEmptyString(value, spec.key, 512);
    case "stringList":
      if (spec.key === "spawns") {
        if (value === "*") return "*";
        const list = toAgentList(value, spec.key);
        if (list.length === 1 && list[0] === "*") return "*";
        return list;
      }
      return toAgentList(value, spec.key);
    case "boolean":
      if (typeof value !== "boolean") fail("INVALID_AGENT", `${spec.key} must be a boolean`);
      return value;
    case "booleanOrString":
      if (typeof value === "boolean") return value;
      if (typeof value === "string" && value.trim()) return value.trim();
      return fail("INVALID_AGENT", `${spec.key} must be a boolean or non-empty string`);
    case "json":
      return value;
  }
}

/** frontmatter + 正文 → 最终 markdown（camelCase 键，SDK parseAgentFields 直接读取）。 */
export function composeAgentMarkdown(frontmatter: Record<string, unknown>, instructions: string): string {
  const head = yaml().stringify(frontmatter, null, 2).trimEnd();
  return `---\n${head}\n---\n\n${instructions.trim()}\n`;
}

/** 原文通道：校验并返回可直接落盘的 markdown。 */
/** 原文通道：校验并返回可直接落盘的 markdown（name 必须与路径一致）。 */
export function agentDocumentFromMarkdown(pathName: string | null, text: string): AgentDocument {
  if (!text.trim()) fail("INVALID_AGENT", "body (markdown with frontmatter) required");
  if (text.length > 256 * 1024) fail("PAYLOAD_TOO_LARGE", "agent definition exceeds 256KB");
  const { frontmatter, instructions } = parseAgentMarkdown(text);
  if (typeof frontmatter.name !== "string" || !frontmatter.name.trim()) {
    fail("INVALID_FRONTMATTER", "frontmatter.name is required");
  }
  const name = assertAgentName(frontmatter.name);
  if (pathName && name !== pathName) {
    fail("INVALID_AGENT", `frontmatter name "${name}" must equal path name "${pathName}"`);
  }
  if (typeof frontmatter.description !== "string" || !frontmatter.description.trim()) {
    fail("INVALID_FRONTMATTER", "frontmatter.description is required");
  }
  if (!instructions.trim()) fail("INVALID_AGENT", "agent body (instructions) must not be empty");
  return { name, frontmatter, instructions: instructions.trim(), markdown: text };
}

/**
 * 结构化输入 → AgentDocument。
 * - `{ content: "<markdown>" }`：原文通道（与 text/markdown 等价）
 * - 其余：name（路径或 body.name）+ description + instructions 必填，字段表校验
 */
/**
 * 结构化输入 → AgentDocument。
 * - `{content}`：原文通道（等价 markdown PUT，不可与结构化字段混用）
 * - 其余：name/description/instructions 必填，字段表逐项校验，未知字段拒绝
 */
export function normalizeAgentDefinition(pathName: string | null, input: unknown): AgentDocument {
  if (!isRecord(input)) fail("INVALID_AGENT", "body must be a JSON object");
  for (const key of Object.keys(input)) {
    if (!AGENT_ALLOWED_KEYS.has(key)) {
      fail(
        "INVALID_AGENT",
        `unknown field "${key}"; allowed: ${[...AGENT_ALLOWED_KEYS].join(", ")} (use content for raw markdown)`,
      );
    }
  }

  if (input.content !== undefined) {
    const extra = Object.keys(input).filter((k) => k !== "content" && k !== "name");
    if (extra.length) fail("INVALID_AGENT", `content cannot be combined with structured fields: ${extra.join(", ")}`);
    if (typeof input.content !== "string") fail("INVALID_AGENT", "content must be a string");
    const doc = agentDocumentFromMarkdown(pathName, input.content);
    if (input.name !== undefined && input.name !== doc.name) {
      fail("INVALID_AGENT", `body.name "${String(input.name)}" must equal frontmatter name "${doc.name}"`);
    }
    return doc;
  }

  const name = assertAgentName(pathName ?? input.name);
  if (pathName && input.name !== undefined && input.name !== pathName) {
    fail("INVALID_AGENT", `body.name "${String(input.name)}" must equal path name "${pathName}"`);
  }
  const description = assertNonEmptyString(input.description, "description", 4096);
  const instructions = assertNonEmptyString(input.instructions, "instructions", 256 * 1024);

  const frontmatter: Record<string, unknown> = { name, description };
  for (const spec of AGENT_FIELD_SPECS) {
    const picked = pickAgentField(input, spec);
    if (!picked) continue;
    const value = coerceAgentField(spec, picked.value);
    if (value !== undefined) frontmatter[spec.key] = value;
  }
  const markdown = composeAgentMarkdown(frontmatter, instructions);
  if (markdown.length > 256 * 1024) fail("PAYLOAD_TOO_LARGE", "composed agent definition exceeds 256KB");
  return { name, frontmatter, instructions, markdown };
}

function frontmatterValue(fm: Record<string, unknown>, key: string, ...aliases: string[]): unknown {
  for (const k of [key, ...aliases]) if (fm[k] !== undefined) return fm[k];
  return undefined;
}

function listOrNull(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return null;
}

/** GET /me/agents/:name?format=json 的 DTO（规范字段 + 原始 frontmatter，便于无损编辑）。 */
/** GET ?format=json 的 DTO：规范字段 + 原始 frontmatter（无损编辑用）。 */
export function agentDefinitionDto(fallbackName: string, content: string): Record<string, unknown> {
  const { frontmatter: fm, instructions } = parseAgentMarkdown(content);
  return {
    name: typeof fm.name === "string" ? fm.name : fallbackName,
    description: fm.description ?? null,
    tools: listOrNull(fm.tools),
    model: listOrNull(fm.model),
    thinkingLevel: frontmatterValue(fm, "thinkingLevel", "thinking-level", "thinking") ?? null,
    spawns: fm.spawns === "*" ? "*" : listOrNull(fm.spawns),
    autoloadSkills: listOrNull(frontmatterValue(fm, "autoloadSkills", "autoload-skills")),
    readSummarize: frontmatterValue(fm, "readSummarize", "read-summarize") ?? null,
    structured: fm.structured ?? null,
    blocking: fm.blocking ?? null,
    prewalk: fm.prewalk ?? null,
    advisor: fm.advisor ?? null,
    output: fm.output ?? null,
    instructions: instructions.trim(),
    frontmatter: fm,
  };
}
