/**
 * Provider 面（DESIGN §27/§30）：结构化视图（models.yml 解析+可用性反推）、开关设置、
 * models.yml 原文与结构化 JSON 双通道、单 provider CRUD、schema 自描述、凭据注入。
 */
import { Hono } from "hono";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  assertProviderId,
  configSchema,
  isStructuredBody,
  modelsConfigToYaml,
  normalizeModelsConfig,
  normalizeProviderConfig,
  parseJsonText,
  parseModelsYaml,
  readJsonBody,
  respondCodecError,
  type ModelsConfigDoc,
} from "../../core/config-codec.ts";
import { userAgentDir } from "../../core/paths.ts";
import { userSettings } from "../../core/settings-facade.ts";
import { audit } from "../../core/tenant-store.ts";
import { getUserContext, reloadUserContext } from "../../core/user-context.ts";
import type { ConfigEnv } from "./env.ts";

const app = new Hono<ConfigEnv>();
const modelsPath = (uid: string) => path.join(userAgentDir(uid), "models.yml");

/**
 * Provider 结构化视图（DESIGN §27，对齐 docs/providers）：
 * 解析 models.yml + 反推可用性（SDK 规则：未禁用 且有可解析凭据 → getAvailable 中出现），
 * 集成端无需自己解析 YAML / 读进程 env。
 */
app.get("/me/providers", async (c) => {
  const uid = c.get("userId");
  const uctx = await getUserContext(uid);
  const { cfgDisabledProviders } = await import("@oh-my-pi/pi-coding-agent/config/model-settings");
  const disabled = new Set<string>(cfgDisabledProviders.get(uctx.settings) ?? []);
  const modelsPath = path.join(uctx.agentDir, "models.yml");
  const raw = await fs.readFile(modelsPath, "utf8").catch(() => "");
  let yamlProviders: Record<string, any> = {};
  if (raw.trim()) {
    try {
      const parsed = (Bun as unknown as { YAML?: { parse: (t: string) => unknown } }).YAML?.parse(raw) as
        | { providers?: Record<string, any> }
        | undefined;
      yamlProviders = parsed?.providers ?? {};
    } catch (err) {
      return c.json(
        {
          error: {
            code: "INVALID_YAML",
            message: `models.yml parse failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        },
        400,
      );
    }
  }
  // 可用性：getAvailable 中出现即"未禁用且有凭据"（SDK 语义）
  const available = (uctx.modelRegistry.getAvailable() ?? []) as Array<Record<string, any>>;
  const byProvider = new Map<string, Array<{ modelId: string; name: string | null; contextWindow: number | null }>>();
  for (const m of available) {
    const id = String(m.provider ?? "");
    if (!id) continue;
    const list = byProvider.get(id) ?? [];
    list.push({ modelId: String(m.id ?? ""), name: m.name ?? null, contextWindow: m.contextWindow ?? null });
    byProvider.set(id, list);
  }
  const ids = [...new Set([...Object.keys(yamlProviders), ...byProvider.keys()])].sort();
  const providers = ids.map((id) => {
    const cfg = yamlProviders[id] as Record<string, any> | undefined;
    const models = Array.isArray(cfg?.models) ? cfg!.models : [];
    const avail = byProvider.get(id) ?? [];
    return {
      id,
      configured: Boolean(cfg), // models.yml 显式配置（覆盖自动发现）
      builtin: !cfg,
      available: avail.length > 0, // 有可解析凭据且未禁用
      disabled: disabled.has(id),
      baseUrl: cfg?.baseUrl ?? null,
      api: cfg?.api ?? null,
      auth: cfg?.auth ?? null,
      hasApiKey: Boolean(cfg?.apiKey),
      declaredModels: models.length,
      availableModels: avail.length,
      models: avail.slice(0, 50),
    };
  });
  return c.json({
    providers,
    disabledProviders: [...disabled],
    counts: {
      total: providers.length,
      configured: providers.filter((x) => x.configured).length,
      available: providers.filter((x) => x.available).length,
      disabled: providers.filter((x) => x.disabled).length,
    },
    note: "available=有可解析凭据且未禁用（SDK 可用性规则）；apiKey 不返回明文。apiKey 值若为环境变量名，由 SDK 在请求时解析",
  });
});

/** Provider/模型开关设置（disabledProviders；写入文件 config.yml，按用户隔离）。 */
app.get("/me/providers/settings", async (c) => {
  const { cfgDisabledProviders } = await import("@oh-my-pi/pi-coding-agent/config/model-settings");
  return c.json({ disabledProviders: (await userSettings.read(c.get("userId"), cfgDisabledProviders as never)) ?? [] });
});

app.put("/me/providers/settings", async (c) => {
  const uid = c.get("userId");
  const body = await c.req.json().catch(() => null as any);
  if (!Array.isArray(body?.disabledProviders)) {
    return c.json({ error: { code: "BAD_REQUEST", message: "body.disabledProviders (string[]) required" } }, 400);
  }
  const list = body.disabledProviders.map(String).filter((x: string) => x.trim());
  const { cfgDisabledProviders } = await import("@oh-my-pi/pi-coding-agent/config/model-settings");
  await userSettings.write(uid, cfgDisabledProviders as never, list as never);
  // 不 rebuild user context：settings 内存即时生效（ModelRegistry 持有同实例引用），
  // 落盘为异步 best-effort；立即 reload 反而会读到旧文件。
  audit("config.disabled_providers", "user", uid, uid, { providers: list });
  return c.json({
    ok: true,
    disabledProviders: list,
    note: "applies to new sessions; live sessions keep their registry",
  });
});

app.get("/me/models/config", async (c) => {
  const uid = c.get("userId");
  const raw = await fs.readFile(modelsPath(uid), "utf8").catch(() => "# providers: {}\n");
  if (c.req.query("format") === "json") {
    try {
      return c.json({
        format: "json",
        config: parseModelsYaml(raw),
        note: "结构化视图；apiKey 为明文（与 GET 原文一致，仅全权身份可读）",
      });
    } catch (err) {
      return respondCodecError(c, err);
    }
  }
  return c.body(raw, 200, { "content-type": "text/yaml" });
});

app.put("/me/models/config", async (c) => {
  const uid = c.get("userId");
  const body = await c.req.text();
  const structured = isStructuredBody(c, body);
  let text = body;
  if (structured) {
    try {
      text = modelsConfigToYaml(normalizeModelsConfig(parseJsonText(body)));
    } catch (err) {
      return respondCodecError(c, err);
    }
  }
  await fs.mkdir(path.dirname(modelsPath(uid)), { recursive: true });
  await fs.writeFile(modelsPath(uid), text, "utf8");
  await reloadUserContext(uid);
  audit("config.models", "user", uid, uid, { bytes: text.length, format: structured ? "json" : "yaml" });
  return c.json({
    ok: true,
    format: structured ? "json" : "yaml",
    bytes: text.length,
    note: structured
      ? "written as formatted YAML (comments/anchors are not preserved); use text/yaml to keep the original formatting"
      : "raw YAML written verbatim",
  });
});

/**
 * 单 Provider 结构化读写（DESIGN §30）：避免集成端为改一个 provider 而读改写整份 YAML。
 * PUT 语义 = **整体替换该 provider 段**；省略字段即删除。只改凭据请用 /me/models/credentials。
 */
app.get("/me/models/providers/:provider", async (c) => {
  const uid = c.get("userId");
  try {
    const id = assertProviderId(c.req.param("provider"));
    const doc = await readModelsDoc(uid);
    const config = doc.providers[id];
    if (!config) {
      return c.json({ error: { code: "NOT_FOUND", message: `provider "${id}" is not configured in models.yml` } }, 404);
    }
    return c.json({ id, configured: true, config });
  } catch (err) {
    return respondCodecError(c, err);
  }
});

app.put("/me/models/providers/:provider", async (c) => {
  const uid = c.get("userId");
  try {
    const { id, config } = normalizeProviderConfig(c.req.param("provider"), await readJsonBody(c));
    const doc = await readModelsDoc(uid);
    doc.providers[id] = config;
    await writeModelsDoc(uid, doc);
    audit("config.provider.write", "provider", id, uid, {
      models: Array.isArray(config.models) ? config.models.length : 0,
    });
    return c.json({
      ok: true,
      id,
      config,
      note: "provider replaced (omitted fields are removed); other providers untouched; applies to new sessions",
    });
  } catch (err) {
    return respondCodecError(c, err);
  }
});

app.delete("/me/models/providers/:provider", async (c) => {
  const uid = c.get("userId");
  try {
    const id = assertProviderId(c.req.param("provider"));
    const doc = await readModelsDoc(uid);
    if (!doc.providers[id]) {
      return c.json({ error: { code: "NOT_FOUND", message: `provider "${id}" is not configured in models.yml` } }, 404);
    }
    delete doc.providers[id];
    await writeModelsDoc(uid, doc);
    audit("config.provider.delete", "provider", id, uid);
    return c.json({ ok: true, id, removed: true });
  } catch (err) {
    return respondCodecError(c, err);
  }
});

/** 结构化配置自描述（DESIGN §30）：字段清单/正则/示例，供前端生成表单。 */
app.get("/me/config/schema", (c) => c.json(configSchema()));

/**
 * 凭据写入：把 apiKey 合并进 models.yml 的 provider（config-sourced key，已验证隔离）。
 * 走结构化读-改-写（与 PUT /me/models/providers 同一编解码路径）——此前用正则做 YAML
 * 手术，含 `#`/引号/换行的 key 会破坏文件结构，provider 只校验首字符还会被拼进 RegExp。
 */
app.post("/me/models/credentials", async (c) => {
  const uid = c.get("userId");
  const body = await c.req.json().catch(() => null as any);
  try {
    const provider = assertProviderId(body?.provider);
    const apiKey = String(body?.apiKey ?? "");
    if (!apiKey) return c.json({ error: { code: "BAD_REQUEST", message: "apiKey required" } }, 400);
    const doc = await readModelsDoc(uid);
    doc.providers[provider] = { ...(doc.providers[provider] ?? {}), apiKey };
    await writeModelsDoc(uid, doc);
    audit("config.credentials", "user", uid, uid, { provider });
    return c.json({ ok: true, provider });
  } catch (err) {
    return respondCodecError(c, err);
  }
});

async function readModelsDoc(uid: string): Promise<ModelsConfigDoc> {
  const raw = await fs.readFile(modelsPath(uid), "utf8").catch(() => "");
  return parseModelsYaml(raw);
}

async function writeModelsDoc(uid: string, doc: ModelsConfigDoc): Promise<string> {
  const text = modelsConfigToYaml(doc);
  await fs.mkdir(path.dirname(modelsPath(uid)), { recursive: true });
  await fs.writeFile(modelsPath(uid), text, "utf8");
  await reloadUserContext(uid);
  return text;
}

export { app as providersApp };
