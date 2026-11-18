/**
 * Wren 项目/Profile 层（wren CLI 包装，DESIGN §39.2 / §40）：
 * 密钥占位符、profiles.yml 登记、项目骨架、幂等落盘与 CLI 调用助手。
 *
 * 安全：连接 JSON 含密码——日志只打数据源名/类型，不打连接内容；profiles.yml 落盘的
 * 只是 `${WREN_SECRET_<NAME>_<FIELD>}` 占位符，明文仅在进程 env 传递。
 */
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { runCommand, type RunCommandResult } from "../proc.ts";
import { WREN_LOG, wrenHome, wrenSubprocessEnv } from "./env.ts";
import type { ModelWritePlan } from "./models.ts";
import { wrenProjectDir } from "./registry.ts";

/** GET 响应的敏感字段脱敏值（admin 契约恒为 "******"） */
export const WREN_SECRET_MASK = "******";
/** 敏感连接字段：写 profiles.yml 时替换为 env 占位符、GET 响应里打码 */
const SECRET_KEY_RE = /pass(word)?|passwd|secret|token|credential|private_key|^pat$|access_key|connection_url/i;

/** 跑一条 wren 命令（argv 数组无 shell；超时强杀与日志截断由 core/proc 统一）。 */
export const runWrenCommand = (bin: string, args: string[], label: string): Promise<RunCommandResult> =>
  runCommand({ bin, args, env: wrenSubprocessEnv(), label, logPrefix: WREN_LOG });

/** 敏感字段打码（递归到 kwargs 一层；GET 响应与日志共用）。 */
export function redactConnection(value: unknown, depth = 3): unknown {
  if (depth <= 0 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactConnection(v, depth - 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY_RE.test(k) ? WREN_SECRET_MASK : redactConnection(v, depth - 1);
  }
  return out;
}

/** env 占位符变量名：WREN_SECRET_<NAME>_<FIELD>（非 [A-Za-z0-9_] 一律压成 _）。 */
export const secretEnvName = (name: string, field: string): string =>
  `WREN_SECRET_${name}_${field}`.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase();

/**
 * 连接字段 → profile JSON 载荷：敏感字符串字段换成 ${WREN_SECRET_<NAME>_<FIELD>}
 * 占位符（wren 连接期从进程 env 展开，profiles.yml 落盘零明文），并返回需注入的 env。
 */
export function buildProfilePayloadFor(
  name: string,
  datasource: string,
  connection: Record<string, unknown>,
): { payload: Record<string, unknown>; secrets: Record<string, string> } {
  const payload: Record<string, unknown> = { datasource };
  const secrets: Record<string, string> = {};
  for (const [field, value] of Object.entries(connection)) {
    if (SECRET_KEY_RE.test(field) && typeof value === "string" && value.length > 0) {
      const envName = secretEnvName(name, field);
      payload[field] = `\${${envName}}`;
      secrets[envName] = value;
    } else {
      payload[field] = value;
    }
  }
  return { payload, secrets };
}

/** profiles.yml 文本里是否已有该 profile（两空格缩进的顶层键，如 `  pg:`）。 */
export const hasProfileEntry = (profilesYml: string, name: string): boolean =>
  new RegExp(`^  ${name}:\\s*(#.*)?$`, "m").test(profilesYml);

/**
 * 步骤 2/8：连接 profile。已存在则跳过；否则写临时 JSON（敏感字段为占位符）→
 * `wren profile add --no-validate`。校验留待查询期（dry_run/引擎报错）——
 * 实测默认校验对不可达主机会挂起数分钟，阻塞启动。
 */
export async function ensureWrenProfile(bin: string, name: string, payload: Record<string, unknown>): Promise<boolean> {
  const profilesFile = path.join(wrenHome(), "profiles.yml");
  const before = await fs.readFile(profilesFile, "utf8").catch(() => "");
  if (hasProfileEntry(before, name)) return true;
  const tmpFile = path.join(os.tmpdir(), `wren-profile-${name}-${process.pid}-${Date.now()}.json`);
  await fs.writeFile(tmpFile, JSON.stringify(payload), "utf8");
  try {
    await runWrenCommand(
      bin,
      ["profile", "add", name, "--from-file", tmpFile, "--no-validate"],
      `profile add (${name})`,
    );
  } finally {
    await fs.rm(tmpFile, { force: true }).catch(() => {});
  }
  const after = await fs.readFile(profilesFile, "utf8").catch(() => "");
  if (!hasProfileEntry(after, name)) {
    console.error(`${WREN_LOG} ${name}: profile add 后 profiles.yml 仍无该条目（跳过该数据源）`);
    return false;
  }
  console.log(`${WREN_LOG} ${name}: profile 已登记（敏感字段以占位符落盘）`);
  return true;
}

/** 步骤 3 前半：项目骨架（wren_project.yml 已存在不覆盖；context init 拒绝覆盖，双向幂等）。 */
export async function ensureWrenSkeleton(bin: string, name: string): Promise<boolean> {
  const projectDir = wrenProjectDir(name);
  await fs.mkdir(projectDir, { recursive: true });
  if (existsSync(path.join(projectDir, "wren_project.yml"))) return true;
  const init = await runWrenCommand(
    bin,
    ["context", "init", "--empty", "--path", projectDir],
    `context init (${name})`,
  );
  return init.ok;
}

/** 内容变化才落盘（provision/物化期幂等：一致不重写）。 */
export async function writeIfChanged(file: string, content: string): Promise<boolean> {
  const cur = await fs.readFile(file, "utf8").catch(() => null);
  if (cur === content) return false;
  await fs.writeFile(file, content, "utf8");
  return true;
}

/** 读项目现有 model 集：{模型目录名 → metadata.yml 内容}（无 metadata.yml 的目录跳过）。 */
export async function readExistingModels(name: string): Promise<Map<string, { content: string }>> {
  const modelsDir = path.join(wrenProjectDir(name), "models");
  const out = new Map<string, { content: string }>();
  const entries = await fs.readdir(modelsDir).catch(() => [] as string[]);
  for (const e of entries) {
    const content = await fs.readFile(path.join(modelsDir, e, "metadata.yml"), "utf8").catch(() => null);
    if (content !== null) out.set(e, { content });
  }
  return out;
}

/**
 * 落盘增量计划（§39.2.2）：writes 逐目录写（内容一致不重写），deletes 删目录；
 * 每步都带日志。返回实际写入/删除的 model 数。
 */
export async function applyModelPlan(
  name: string,
  plan: ModelWritePlan,
): Promise<{ written: number; removed: number }> {
  const modelsDir = path.join(wrenProjectDir(name), "models");
  let written = 0;
  for (const [model, yaml] of Object.entries(plan.writes)) {
    const dir = path.join(modelsDir, model);
    await fs.mkdir(dir, { recursive: true });
    if (await writeIfChanged(path.join(dir, "metadata.yml"), yaml)) {
      console.log(`${WREN_LOG} ${name}: model ${model} 已生成（${yaml.split("\n").length} 行）`);
    }
    written++;
  }
  for (const prev of plan.deletes) {
    await fs.rm(path.join(modelsDir, prev), { recursive: true, force: true }).catch(() => {});
    console.log(`${WREN_LOG} ${name}: model ${prev} 已随内省集合收敛移除`);
  }
  return { written, removed: plan.deletes.length };
}
