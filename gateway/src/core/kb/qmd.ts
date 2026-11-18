/**
 * qmd 检索引擎包装（KB 模块可选增强，DESIGN §38.6 / §40）：qmd CLI 子进程薄封装——
 * 不进 SDK 进程树；qmd 未安装时全部 no-op（{ok:false, reason:"qmd not installed"}），
 * 失败绝不抛进管理面，原生检索照常。spawn/超时/截断日志统一由 core/proc 提供。
 * 子进程 env：QMD_CONFIG_DIR/XDG_CACHE_HOME 指向 <dataRoot>/global/kb/qmd/*（随迁移搬移）。
 * env：KB_QMD_BIN / KB_QMD_INDEX / KB_QMD_MCP=1 / KB_QMD_EMBED_{BASE_URL,API_KEY,MODEL}
 * （三件齐才 embed，否则只 update——未配时 embed 会走本地 GGUF 触发模型下载，必须跳过）。
 * 安全：slug 先过 assertSlug 再进 argv（Bun.spawn 数组无 shell）；日志前缀 [gateway:qmd]。
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { config } from "../../config.ts";
import { readMcpServers, upsertMcpServers } from "../mcp-registry.ts";
import { globalMcpPath, globalSkillsDir } from "../paths.ts";
import { resolveBin, runCommand, truncate, type RunCommandResult } from "../proc.ts";
import { assertSlug, skillNameFor } from "./names.ts";

const LOG = "[gateway:qmd]";
/** qmd MCP daemon 的内网服务地址（qmd mcp --http 默认端口 8181、路径 /mcp） */
const QMD_MCP_URL = "http://127.0.0.1:8181/mcp";

/** 命令结果：reason=前置 no-op 原因；skipped=有意跳过的步骤；error=执行失败诊断。 */
export interface QmdOutcome {
  ok: boolean;
  reason?: string;
  error?: string;
  skipped?: string;
}

export const qmdBin = (): string => process.env.KB_QMD_BIN?.trim() || "qmd";

/** qmd 命名索引（白名单校验；非法值回落默认，避免部署方 typo 进命令行）。 */
export const qmdIndexName = (): string => {
  const v = process.env.KB_QMD_INDEX?.trim();
  return v && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v) ? v : "kb";
};

/** qmd 配置与缓存目录（dataRoot 内，随迁移 bundle 整体搬移）。 */
export const qmdDirs = (): { configDir: string; cacheDir: string } => ({
  configDir: path.join(config.dataRoot, "global", "kb", "qmd", "config"),
  cacheDir: path.join(config.dataRoot, "global", "kb", "qmd", "cache"),
});

/** 子进程 env：继承容器 env（KB_QMD_EMBED_* 直通给 patched qmd），再注入 qmd 数据目录。 */
export const qmdSubprocessEnv = (): Record<string, string | undefined> => {
  const { configDir, cacheDir } = qmdDirs();
  return { ...process.env, QMD_CONFIG_DIR: configDir, XDG_CACHE_HOME: cacheDir };
};

const indexArgs = (): string[] => ["--index", qmdIndexName()];

/** 跑一条 qmd 命令；missing=true 表示二进制不在（no-op 语义，区别于执行失败）。 */
async function runQmd(args: string[], label: string): Promise<RunCommandResult> {
  const bin = resolveBin(qmdBin());
  if (!bin) return { ok: false, stdout: "", stderr: "", missing: true };
  const { configDir, cacheDir } = qmdDirs();
  for (const d of [configDir, cacheDir])
    try {
      mkdirSync(d, { recursive: true });
    } catch {}
  return runCommand({ bin, args, env: qmdSubprocessEnv(), label, logPrefix: LOG });
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: 剥离 qmd CLI 输出的 ANSI SGR 转义序列（\x1b[...m）
const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;

/** 从 `qmd collection list` 输出判断集合是否已注册（剥 ANSI；按名字边界匹配防前缀误命中）。 */
function listHasCollection(listStdout: string, name: string): boolean {
  const plain = listStdout.replace(ANSI_SGR_RE, "");
  return new RegExp(`(?:^|[^A-Za-z0-9_-])${name}(?:[^A-Za-z0-9_-]|$)`).test(plain);
}

/** embedding 三件套是否配齐（三件齐才跳过本地 GGUF 路径）。 */
const embedEnvReady = (): boolean =>
  Boolean(
    process.env.KB_QMD_EMBED_BASE_URL?.trim() &&
      process.env.KB_QMD_EMBED_API_KEY?.trim() &&
      process.env.KB_QMD_EMBED_MODEL?.trim(),
  );

/** 注册 KB 语料目录为 qmd collection（幂等）：`collection list` 查重，已存在则跳过。 */
export async function kbQmdAdd(slug: string): Promise<QmdOutcome> {
  try {
    assertSlug(slug);
    const name = skillNameFor(slug);
    const list = await runQmd([...indexArgs(), "collection", "list"], `collection list (${name})`);
    if (!list.ok) {
      return list.missing
        ? { ok: false, reason: "qmd not installed" }
        : { ok: false, error: list.error ?? "collection list failed" };
    }
    if (listHasCollection(list.stdout, name)) return { ok: true };
    const corpusDir = path.join(globalSkillsDir(), name, "docs");
    const add = await runQmd(
      [...indexArgs(), "collection", "add", corpusDir, "--name", name],
      `collection add (${name})`,
    );
    return add.ok ? { ok: true } : { ok: false, error: add.error ?? "collection add failed" };
  } catch (err) {
    console.error(`${LOG} kbQmdAdd(${slug}): ${truncate(String(err))}`);
    return { ok: false, error: String(err) };
  }
}

/**
 * 读一次 `qmd --index <index> status`，解析「待嵌入数 / 向量索引是否就绪」：
 * `Vectors: N embedded` 存在且无 `Needs embedding` 行 → 0 待嵌入；不可识别 → null。
 */
export async function kbQmdStatusProbe(): Promise<{ needsEmbedding: number | null; vectorIndex: boolean | null }> {
  const r = await runQmd([...indexArgs(), "status"], "status (probe)");
  if (!r.ok) return { needsEmbedding: null, vectorIndex: null };
  const plain = r.stdout.replace(ANSI_SGR_RE, "");
  const vectors = plain.match(/Vectors:\s*(\d+)\s*embedded/i);
  const needsLine = plain.match(/Needs embedding:\s*(\d+)/i);
  return {
    needsEmbedding: needsLine ? Number(needsLine[1]) : vectors ? 0 : null,
    vectorIndex: vectors
      ? true
      : /Vector index:\s*yes/i.test(plain)
        ? true
        : /Vector index:\s*no/i.test(plain)
          ? false
          : null,
  };
}

/** 同步部分：只跑 `qmd --index <index> update`（重扫语料、重建 BM25 索引，秒级，上传返回时已可用）。 */
export async function kbQmdUpdate(): Promise<QmdOutcome> {
  try {
    const upd = await runQmd([...indexArgs(), "update"], "update");
    return upd.ok
      ? { ok: true }
      : upd.missing
        ? { ok: false, reason: "qmd not installed" }
        : { ok: false, error: upd.error ?? "update failed" };
  } catch (err) {
    console.error(`${LOG} kbQmdUpdate: ${truncate(String(err))}`);
    return { ok: false, error: String(err) };
  }
}

// ---- 语义索引（embed）：后台单飞异步 ----
// embed 分钟级，同步等会撞上游 60s 超时并诱发重复上传；BM25 已同步可用。单飞：同一 KB
// 同时只允许一个 embed（qmd 抢索引写锁，并发只会互相等待）。

type EmbedState = "idle" | "running" | "ok" | "failed" | "skipped" | "unavailable";

export interface KbEmbedStatus {
  /** idle/running/ok/failed/skipped(未配三件套)/unavailable(qmd 未安装) */
  state: EmbedState;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

const embedStates = new Map<string, KbEmbedStatus>();
const embedInFlight = new Map<string, Promise<void>>();
const blankStatus = (): KbEmbedStatus => ({ state: "idle", startedAt: null, finishedAt: null, error: null });

/** 读某 KB 的语义索引状态（进程内；网关重启后回到 idle，实际进度以 qmd status 为准）。 */
export function kbEmbedStatus(slug: string): KbEmbedStatus {
  return embedStates.get(slug) ?? blankStatus();
}

/** 当前是否有 KB 正在后台 embed（诊断/测试用）。 */
export const kbEmbedRunning = (): string[] => [...embedInFlight.keys()];

/** 触发后台 embed（幂等：同 KB 已在跑则复用）。三件套未配 → skipped；失败只记状态 + 告警，不抛。 */
export function scheduleKbQmdEmbed(slug: string): void {
  if (embedInFlight.has(slug)) return;
  if (!embedEnvReady()) {
    embedStates.set(slug, {
      state: "skipped",
      startedAt: null,
      finishedAt: new Date().toISOString(),
      error: "embed: KB_QMD_EMBED_* not fully configured (BM25 only)",
    });
    console.log(
      `${LOG} embed skipped for ${slug}: KB_QMD_EMBED_BASE_URL/API_KEY/MODEL 未配齐（BM25 即刻可用，语义检索关闭）`,
    );
    return;
  }
  const startedAt = new Date().toISOString();
  embedStates.set(slug, { state: "running", startedAt, finishedAt: null, error: null });
  const task = (async () => {
    try {
      const r = await runQmd([...indexArgs(), "embed"], `embed (${slug})`);
      const now = new Date().toISOString();
      if (r.ok) {
        embedStates.set(slug, { state: "ok", startedAt, finishedAt: now, error: null });
        console.log(`${LOG} embed done for ${slug}`);
      } else {
        const error = r.missing ? "qmd not installed" : (r.error ?? "embed failed");
        embedStates.set(slug, { state: r.missing ? "unavailable" : "failed", startedAt, finishedAt: now, error });
      }
    } catch (err) {
      embedStates.set(slug, { state: "failed", startedAt, finishedAt: new Date().toISOString(), error: String(err) });
      console.error(`${LOG} embed(${slug}) crashed: ${truncate(String(err))}`);
    } finally {
      embedInFlight.delete(slug);
    }
  })();
  embedInFlight.set(slug, task);
}

/** 注销 collection（幂等）：`collection remove kb-<slug>`；集合不存在不算失败。 */
export async function kbQmdRemove(slug: string): Promise<QmdOutcome> {
  try {
    assertSlug(slug);
    const name = skillNameFor(slug);
    const r = await runQmd([...indexArgs(), "collection", "remove", name], `collection remove (${name})`);
    if (r.ok || /Collection not found/i.test(`${r.stdout}\n${r.stderr}`)) return { ok: true };
    return r.missing
      ? { ok: false, reason: "qmd not installed" }
      : { ok: false, error: r.error ?? "collection remove failed" };
  } catch (err) {
    console.error(`${LOG} kbQmdRemove(${slug}): ${truncate(String(err))}`);
    return { ok: false, error: String(err) };
  }
}

/**
 * 全局 MCP 注册（网关启动时调用一次）：KB_QMD_MCP=1 时往 global/mcp.json 写入
 * `{ qmd: { type:"http", url:"http://127.0.0.1:8181/mcp" } }`（已有 qmd 键则不动）。
 * 读写经 core/mcp-registry（串行锁）——与 wren 注册不再互相覆盖。url 是固定环回地址
 * （QMD_MCP_URL 常量；daemon 由 entrypoint 起在 127.0.0.1:8181），不经过用户输入路径，
 * 不受 SSRF 门控。
 */
export async function ensureQmdMcpRegistered(): Promise<void> {
  if (process.env.KB_QMD_MCP !== "1") return;
  const file = globalMcpPath();
  try {
    const servers = await readMcpServers();
    if (Object.hasOwn(servers, "qmd")) return; // 幂等：已注册不重写
    const { written } = await upsertMcpServers({ qmd: { type: "http", url: QMD_MCP_URL } });
    if (written) console.log(`${LOG} qmd MCP registered in ${file} → ${QMD_MCP_URL}`);
  } catch (err) {
    console.error(`${LOG} ensureQmdMcpRegistered: ${truncate(String(err))}（写 global/mcp.json 失败，不阻塞启动）`);
  }
}
