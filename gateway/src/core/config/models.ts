/** models.yml 结构化编解码（DESIGN §30）：provider id / 模型条目校验 + YAML 序列化。 */
import { fail } from "./errors.ts";
import { isRecord, yaml } from "./yaml.ts";

/* ============================ models.yml ============================ */

/** provider id 同时用于 auth 查找与路径/正则拼接，限定为安全字符集。 */
export const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface ModelsConfigDoc {
  providers: Record<string, Record<string, unknown>>;
  [rootKey: string]: unknown;
}

export interface FieldSpec {
  key: string;
  type: string;
  description: string;
}

/** 结构化写入时被轻量校验的 provider 字段（其余字段透传）。 */
export const PROVIDER_FIELDS: readonly FieldSpec[] = [
  { key: "baseUrl", type: "string", description: "上游 base URL（兼容网关/自建代理）" },
  { key: "apiKey", type: "string", description: "环境变量名或字面量；!cmd 执行命令取 stdout" },
  {
    key: "api",
    type: "string",
    description: "wire API，如 openai-completions / anthropic-messages / google-generative-ai",
  },
  { key: "auth", type: "string", description: "认证方式（apiKey / none / oauth 等）" },
  { key: "headers", type: "Record<string,string>", description: "附加请求头" },
  { key: "authHeader", type: "boolean", description: "以 Authorization 头发送凭据" },
  { key: "disableStrictTools", type: "boolean", description: "兼容端点拒绝 strict 字段时置 true" },
  { key: "discovery", type: "object", description: "自动发现配置（type/timeoutMs）" },
  { key: "modelOverrides", type: "Record<string,ModelOverride>", description: "按模型 id 覆盖元数据" },
  { key: "models", type: "ModelEntry[]", description: "自定义模型清单（为空表示仅覆盖内置模型）" },
];

/** 结构化写入时被轻量校验的 model 字段（其余字段透传）。 */
export const MODEL_FIELDS: readonly FieldSpec[] = [
  { key: "id", type: "string (required)", description: "模型 id（provider 内唯一）" },
  { key: "name", type: "string", description: "展示名" },
  { key: "api", type: "string", description: "模型级 wire API 覆盖" },
  { key: "baseUrl", type: "string", description: "模型级 base URL 覆盖" },
  { key: "reasoning", type: "boolean", description: "是否支持推理" },
  { key: "input", type: "string[]", description: "输入模态，如 [text, image]" },
  { key: "contextWindow", type: "positive integer", description: "常规上下文窗口" },
  { key: "maxContextWindow", type: "positive integer", description: "扩展上下文窗口" },
  { key: "maxTokens", type: "positive integer", description: "最大输出 token" },
  { key: "cost", type: "object", description: "input/output/cacheRead/cacheWrite 单价" },
  { key: "headers", type: "Record<string,string>", description: "模型级请求头" },
  { key: "compat", type: "object", description: "端点兼容性开关（extraBody/routing 等）" },
];

/** provider id 校验（auth 查找与路径/正则拼接都用到它，字符集从紧）。 */
export function assertProviderId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id || !PROVIDER_ID_RE.test(id)) {
    fail("INVALID_PROVIDER", `invalid provider id "${String(value)}" (expected ${PROVIDER_ID_RE.source})`);
  }
  return id;
}

function assertStringMap(value: unknown, field: string): void {
  if (!isRecord(value)) fail("INVALID_CONFIG", `${field} must be an object of string values`);
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "string") fail("INVALID_CONFIG", `${field}.${k} must be a string`);
  }
}

function assertModelEntry(providerId: string, entry: unknown, index: number, seen: Set<string>): void {
  const field = `providers.${providerId}.models[${index}]`;
  if (!isRecord(entry)) fail("INVALID_CONFIG", `${field} must be an object`);
  if (typeof entry.id !== "string" || !entry.id.trim()) {
    fail("INVALID_CONFIG", `${field}.id is required (non-empty string)`);
  }
  const id = entry.id.trim();
  if (seen.has(id)) fail("INVALID_CONFIG", `${field}.id "${id}" is duplicated`);
  seen.add(id);
  for (const key of ["name", "baseUrl", "api"] as const) {
    if (entry[key] !== undefined && typeof entry[key] !== "string") {
      fail("INVALID_CONFIG", `${field}.${key} must be a string`);
    }
  }
  for (const key of ["contextWindow", "maxContextWindow", "maxTokens"] as const) {
    const v = entry[key];
    if (v !== undefined && (!Number.isInteger(v) || Number(v) <= 0)) {
      fail("INVALID_CONFIG", `${field}.${key} must be a positive integer`);
    }
  }
  if (entry.reasoning !== undefined && typeof entry.reasoning !== "boolean") {
    fail("INVALID_CONFIG", `${field}.reasoning must be a boolean`);
  }
  if (entry.input !== undefined) {
    if (!Array.isArray(entry.input) || entry.input.some((x) => typeof x !== "string")) {
      fail("INVALID_CONFIG", `${field}.input must be string[]`);
    }
  }
  if (entry.cost !== undefined && !isRecord(entry.cost)) {
    fail("INVALID_CONFIG", `${field}.cost must be an object`);
  }
  if (entry.compat !== undefined && !isRecord(entry.compat)) {
    fail("INVALID_CONFIG", `${field}.compat must be an object`);
  }
  if (entry.headers !== undefined) assertStringMap(entry.headers, `${field}.headers`);
}

function assertProviderConfig(providerId: string, value: unknown): Record<string, unknown> {
  const field = `providers.${providerId}`;
  if (!isRecord(value)) fail("INVALID_CONFIG", `${field} must be an object`);
  for (const key of ["baseUrl", "api", "apiKey", "auth"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      fail("INVALID_CONFIG", `${field}.${key} must be a string`);
    }
  }
  if (typeof value.baseUrl === "string" && value.baseUrl.length > 2048) {
    fail("INVALID_CONFIG", `${field}.baseUrl exceeds 2048 chars`);
  }
  for (const key of ["authHeader", "disableStrictTools"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") {
      fail("INVALID_CONFIG", `${field}.${key} must be a boolean`);
    }
  }
  if (value.headers !== undefined) assertStringMap(value.headers, `${field}.headers`);
  if (value.discovery !== undefined && !isRecord(value.discovery)) {
    fail("INVALID_CONFIG", `${field}.discovery must be an object`);
  }
  if (value.modelOverrides !== undefined && !isRecord(value.modelOverrides)) {
    fail("INVALID_CONFIG", `${field}.modelOverrides must be an object`);
  }
  if (value.models !== undefined) {
    if (!Array.isArray(value.models)) fail("INVALID_CONFIG", `${field}.models must be an array`);
    const seen = new Set<string>();
    value.models.forEach((entry, i) => {
      assertModelEntry(providerId, entry, i, seen);
    });
  }
  return value;
}

/** 结构化整体写入：`{ providers: { ... } }`（未知根键原样保留）。 */
export function normalizeModelsConfig(input: unknown): ModelsConfigDoc {
  if (!isRecord(input)) {
    fail("INVALID_CONFIG", "body must be a JSON object like { providers: { <id>: { ... } } }");
  }
  if (!isRecord(input.providers)) fail("INVALID_CONFIG", "body.providers must be an object");
  const providers: Record<string, Record<string, unknown>> = {};
  for (const [rawId, cfg] of Object.entries(input.providers)) {
    const id = assertProviderId(rawId);
    providers[id] = assertProviderConfig(id, cfg);
  }
  return { ...input, providers };
}

/** 结构化单 provider 写入（PUT /me/models/providers/:provider）。 */
export function normalizeProviderConfig(
  providerId: unknown,
  input: unknown,
): {
  id: string;
  config: Record<string, unknown>;
} {
  const id = assertProviderId(providerId);
  return { id, config: assertProviderConfig(id, input) };
}

/** 解析现有 models.yml；语法/根结构错误 → INVALID_YAML。 */
export function parseModelsYaml(text: string): ModelsConfigDoc {
  if (!text.trim()) return { providers: {} };
  let parsed: unknown;
  try {
    parsed = yaml().parse(text);
  } catch (err) {
    fail("INVALID_YAML", `models.yml parse failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed == null) return { providers: {} };
  if (!isRecord(parsed)) fail("INVALID_YAML", "models.yml root must be a mapping");
  const providers = parsed.providers ?? {};
  if (!isRecord(providers)) fail("INVALID_YAML", "models.yml providers must be a mapping");
  for (const [id, cfg] of Object.entries(providers)) {
    if (!PROVIDER_ID_RE.test(id)) fail("INVALID_YAML", `models.yml provider id "${id}" is invalid`);
    if (!isRecord(cfg)) fail("INVALID_YAML", `models.yml providers.${id} must be a mapping`);
  }
  return { ...parsed, providers: providers as Record<string, Record<string, unknown>> };
}

/** 结构化对象 → 2 空格缩进 YAML（集成端可直接当 models.yml 用）。 */
export function modelsConfigToYaml(config: ModelsConfigDoc): string {
  const text = yaml().stringify(config, null, 2);
  return text.endsWith("\n") ? text : `${text}\n`;
}
