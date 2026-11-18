#!/usr/bin/env node
/**
 * apply.mjs — 给全局安装的 @tobilu/qmd 打「OpenAI 兼容远程 embedding provider」补丁。
 *
 * 用法:
 *   node apply.mjs [--dir <qmd 安装目录>] [--revert]
 *
 * 定位顺序: --dir 参数 > QMD_INSTALL_DIR 环境变量 > $HOME/.bun/install/global/node_modules/@tobilu/qmd
 *
 * 补丁内容（幂等，可重复执行）:
 *   1. 写入 dist/qmd-embed-api.js（远程 provider + 白名单装饰器，源码内嵌于本脚本）
 *   2. dist/llm.js      — getDefaultLlamaCpp() 函数体开头插入 globalThis 钩子（远程时返回装饰器单例）
 *   3. dist/index.js    — 顶部注入 import；`new LlamaCpp({` → `__createLlamaCpp({`
 *   4. dist/cli/qmd.js  — shebang 后注入 import；`new LlamaCpp({` → `__createLlamaCpp({`
 *
 * 应用后自检: 动态 import 补丁后的 dist/index.js，按当前 env 断言工厂行为:
 *   - 三件套齐（KB_QMD_EMBED_BASE_URL/API_KEY/MODEL）→ full 远程装饰器
 *   - 三件套缺但 embed 模型已是 api:*（config 被 qmd saveConfig 持久化过）→ degraded 装饰器
 *     （embed 快速返回 null + stderr 告警；expandQuery/rerank/tokenize 走无 LLM 合成实现；
 *      绝不回退 stock 本地路径 —— 否则 expandQuery 会去 HF 拉 1.7B 模型静默卡死，实测可复现）
 *   - 都不是 → 原生 LlamaCpp（真正干净的本地配置）
 *
 * --revert: 从 *.qmd-pre-patch.bak 还原三个被改文件并删除 qmd-embed-api.js。
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// =============================================================================
// dist/qmd-embed-api.js 完整源码（写进 qmd 安装目录，随 qmd 一起被 import）
// =============================================================================
const PROVIDER_SOURCE = String.raw`/**
 * qmd-embed-api.js — gateway 分发的 qmd 远程 embedding 补丁文件。
 * 源头维护在 gateway/docker/qmd-patch/apply.mjs（内嵌字符串），此处为生成物，勿手改。
 *
 * 约定的三件套环境变量（语义对齐 la-sequence-script/kb/.env 的 KB_EMBEDDING_*）:
 *   KB_QMD_EMBED_BASE_URL  OpenAI 兼容服务根地址（如 https://ark.cn-beijing.volces.com/api/v3）
 *   KB_QMD_EMBED_API_KEY   Bearer token
 *   KB_QMD_EMBED_MODEL     embedding 模型名（如 doubao-embedding-text-240715）
 *   KB_QMD_EMBED_BATCH     单请求 input 条数（默认 16）
 * 状态机（__createLlamaCpp / getDefaultLlamaCpp 钩子共用）:
 *   full     三件套齐 → embed/embedBatch 走远程 API
 *   degraded 三件套缺但 embed 模型已是 api:*（qmd 的 saveConfig 会在远程跑过一次后把
 *            解析出的模型持久化进 config yml）→ 不回退 stock 本地路径（否则 expandQuery
 *            会去 HF 拉 1.7B generate 模型静默卡死，实测复现）；embed 快速返回 null 并
 *            stderr 告警一次，expandQuery/rerank/tokenize 走无 LLM 合成实现
 *   stock    干净本地配置 → 原生 LlamaCpp，行为不变
 * 访问面白名单（grep dist 枚举 store.js/cli/qmd.js/mcp/server.js/index.js 对 llm 对象的
 * 全部方法/属性访问）: 白名单外一律抛错，绝不委托 inner、绝不 import node-llama-cpp。
 * inner LlamaCpp 只在 generate 显式被调时才允许构造（远程管线不应触发）。
 */
import { LlamaCpp, resolveGenerateModel, resolveRerankModel } from "./llm.js";
import os from "node:os";

const REMOTE_PREFIX = "api:";
const FETCH_TIMEOUT_MS = 120000;
const DEFAULT_BATCH_SIZE = 16;
const MAX_CONCURRENCY = 4;

const WHITELIST = new Set([
    "embed", "embedBatch", "expandQuery", "rerank", "generate", "modelExists",
    "dispose", "tokenize", "detokenize", "countTokens", "getDeviceInfo",
    "unloadIdleResources", "embedModelName", "generateModelName", "rerankModelName",
]);

/** 读取并校验远程三件套；未配齐或 base_url 非 http(s) 时返回 null。 */
export function remoteEmbedConfig() {
    const baseUrl = (process.env.KB_QMD_EMBED_BASE_URL || "").trim();
    const apiKey = (process.env.KB_QMD_EMBED_API_KEY || "").trim();
    const model = (process.env.KB_QMD_EMBED_MODEL || "").trim();
    if (!baseUrl || !apiKey || !model) return null;
    let parsed = null;
    try {
        parsed = new URL(baseUrl);
    } catch {
        return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model };
}

export function isRemoteEmbedConfigured() {
    return remoteEmbedConfig() !== null;
}

function looksLikeApiModel(value) {
    return typeof value === "string" && value.startsWith(REMOTE_PREFIX);
}

// 最早的钩子：本模块被 index.js / cli/qmd.js 首行 import，此时任何 LlamaCpp
// 实例都尚未创建。三件套齐时设置 QMD_EMBED_MODEL，让 embed 指纹（sha256(model URI
// + 格式化探针 + 分块参数)）与 status/doctor 显示都反映远程模型。
{
    const cfg = remoteEmbedConfig();
    if (cfg) {
        process.env.QMD_EMBED_MODEL = REMOTE_PREFIX + cfg.model;
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 单批请求：POST {BASE_URL}/embeddings，body {model, input:[...]}，
 * 响应 data[] 按 index 排序保序。失败重试 2 次（退避 1s/2s），耗尽后该批全 null
 * （qmd 会把这些 chunk 记为未嵌入，下次 embed 续跑）。
 */
async function fetchEmbeddingsBatch(cfg, texts) {
    const body = JSON.stringify({ model: cfg.model, input: texts });
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await sleep(1000 * attempt);
        try {
            const res = await fetch(cfg.baseUrl + "/embeddings", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: "Bearer " + cfg.apiKey,
                },
                body,
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            if (!res.ok) {
                const text = await res.text().catch(() => "");
                throw new Error("HTTP " + res.status + ": " + text.slice(0, 200));
            }
            const json = await res.json();
            const data = Array.isArray(json && json.data) ? json.data : null;
            if (!data || data.length !== texts.length) {
                throw new Error("响应 data 数量不匹配: 期望 " + texts.length + ", 实得 " + (data ? data.length : "无 data"));
            }
            const sorted = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
            return sorted.map((item) => (Array.isArray(item && item.embedding) ? item.embedding : null));
        } catch (err) {
            lastErr = err;
        }
    }
    const reason = lastErr instanceof Error ? lastErr.message : String(lastErr);
    process.stderr.write("[qmd-embed-api] 批量 embed 失败（" + texts.length + " 条, 重试耗尽, 本批记为未嵌入）: " + reason + "\n");
    return texts.map(() => null);
}

/** 分批（KB_QMD_EMBED_BATCH，默认 16）+ 保序并发（≤4）。 */
async function remoteEmbedBatch(cfg, texts) {
    if (!Array.isArray(texts) || texts.length === 0) return [];
    const parsed = Number.parseInt(process.env.KB_QMD_EMBED_BATCH || "", 10);
    const size = Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_BATCH_SIZE;
    const batches = [];
    for (let i = 0; i < texts.length; i += size) {
        batches.push(texts.slice(i, i + size));
    }
    const results = new Array(batches.length);
    let next = 0;
    const worker = async () => {
        while (next < batches.length) {
            const idx = next++;
            results[idx] = await fetchEmbeddingsBatch(cfg, batches[idx]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, batches.length) }, () => worker()));
    return results.flat();
}

const CJK_RE = /[\u2E80-\u2EFF\u3000-\u303F\u3040-\u30FF\u31C0-\u31EF\u3200-\u32FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]|\uD83C[\uDF00-\uDFFF]|[\uD840-\uD87F][\uDC00-\uDFFF]/;

/**
 * 启发式分词（qmd 的 chunkDocumentByTokens 依赖 llm.tokenize/detokenize，
 * 远程模式绝不触 node-llama-cpp）：CJK 1 码点 = 1 token，其余每 4 字符 = 1 token
 * （与 qmd 自身的 ~4 chars/token 估算一致）。token 即原文字符片段，join 可精确还原。
 */
function heuristicTokenize(text) {
    const tokens = [];
    let buf = "";
    let bufLen = 0;
    const flush = () => {
        if (buf) {
            tokens.push(buf);
            buf = "";
            bufLen = 0;
        }
    };
    for (const ch of text) {
        if (CJK_RE.test(ch)) {
            flush();
            tokens.push(ch);
        } else {
            buf += ch;
            bufLen += 1;
            if (bufLen >= 4) flush();
        }
    }
    flush();
    return tokens;
}

/**
 * 远程 embedding 装饰器（full = 三件套齐；degraded = 仅 api:* 模型名可用）。
 * embed/embedBatch 走远程 API（degraded 快速 null）；expandQuery 无 LLM 扩展
 * （原查询同时进 BM25 与向量路）；rerank 返回输入序等分（融合公式保持 RRF 序）。
 */
class RemoteEmbedLlm {
    constructor(config = {}, mode = "full") {
        const cfg = remoteEmbedConfig();
        if (mode === "full" && !cfg) {
            throw new Error("RemoteEmbedLlm full 模式需要完整 KB_QMD_EMBED_* 三件套");
        }
        this._mode = mode;
        this._cfg = cfg;
        this._config = config || {};
        // inner LlamaCpp 仅允许 generate() 显式构造；_innerCaller 是不变量断言：
        // 非 generate 路径若发现自己拿到了 inner 即为补丁缺陷，立即抛错而不是静默触 native。
        this._inner = null;
        this._innerCaller = null;
        this._disposed = false;
        this._warned = false;
    }
    get embedModelName() {
        if (this._cfg) return REMOTE_PREFIX + this._cfg.model;
        if (looksLikeApiModel(this._config.embedModel)) return String(this._config.embedModel);
        return String(process.env.QMD_EMBED_MODEL || REMOTE_PREFIX + "unknown");
    }
    get generateModelName() {
        // 与 LlamaCpp 构造函数同样的解析逻辑，但不构造 inner（纯字符串解析）
        return resolveGenerateModel({ generate: this._config.generateModel });
    }
    get rerankModelName() {
        return resolveRerankModel({ rerank: this._config.rerankModel });
    }
    _guardCi() {
        if (process.env.CI) throw new Error("LLM operations are disabled in CI (set CI=true)");
    }
    _warnDegradedOnce(op) {
        if (this._warned) return;
        this._warned = true;
        process.stderr.write(
            "[qmd-embed-api] KB_QMD_EMBED_* 三件套不完整，无法调用远程 embed（当前模型 " + this.embedModelName + "）。" +
            op + " 按空结果快速失败（不回退本地 GGUF 以免卡死）；补齐三件套后重试。\n"
        );
    }
    async embed(text, options = {}) {
        if (this._disposed) return null;
        if (this._mode !== "full") {
            this._warnDegradedOnce("embed");
            return null;
        }
        const out = await remoteEmbedBatch(this._cfg, [text]);
        return out[0] ? { embedding: out[0], model: options.model ?? this.embedModelName } : null;
    }
    async embedBatch(texts, options = {}) {
        this._guardCi();
        if (this._disposed || !Array.isArray(texts) || texts.length === 0) {
            return Array.isArray(texts) && texts.length > 0 ? texts.map(() => null) : [];
        }
        if (this._mode !== "full") {
            this._warnDegradedOnce("embedBatch");
            return texts.map(() => null);
        }
        const out = await remoteEmbedBatch(this._cfg, texts);
        return out.map((vec) => (vec ? { embedding: vec, model: options.model ?? this.embedModelName } : null));
    }
    async expandQuery(query, _options = {}) {
        this._guardCi();
        // 无本地 1.7B 扩展模型：原查询同时进 lex(BM25) 与 vec(向量) 路，无 LLM 扩展。
        // 这是 vsearch 挂死的解药：stock expandQuery 会在返回前阻塞在 HF 下载上。
        return [
            { type: "lex", text: query },
            { type: "vec", text: query },
        ];
    }
    async rerank(_query, documents, _options = {}) {
        this._guardCi();
        // 无本地重排模型：全部等分，RRF 融合序即最终序。
        return {
            results: (documents ?? []).map((doc, i) => ({ file: doc.file, score: 1, index: i })),
            model: REMOTE_PREFIX + "no-rerank",
        };
    }
    // generate 是唯一允许构造 inner 的白名单方法（显式本地生成请求）。
    async generate(prompt, options) {
        return this._touchInner("generate").generate(prompt, options);
    }
    _touchInner(caller) {
        if (this._innerCaller && this._innerCaller !== caller) {
            throw new Error("[qmd-embed-api] 不变量破坏: inner LlamaCpp 已被 " + this._innerCaller + " 构造");
        }
        if (!this._inner) this._inner = new LlamaCpp(this._config);
        this._innerCaller = caller;
        return this._inner;
    }
    async modelExists(model) {
        // 远程模型无从「存在性检查」，视为可用
        return { name: model, exists: true };
    }
    async dispose() {
        this._disposed = true;
        if (this._inner) {
            const inner = this._inner;
            this._inner = null;
            await inner.dispose();
        }
    }
    async getDeviceInfo() {
        // 远程模式不加载本地 llama 运行时，返回纯 CPU 合成信息（doctor 设备探测用）
        return {
            gpu: false,
            gpuOffloading: false,
            gpuDevices: [],
            cpuCores: typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length,
        };
    }
    tokenize(text) {
        return heuristicTokenize(String(text));
    }
    detokenize(tokens) {
        return Array.from(tokens ?? []).join("");
    }
    countTokens(text) {
        return heuristicTokenize(String(text)).length;
    }
    async unloadIdleResources() {
        // 只回收已存在的 inner 资源，绝不构造 inner
        if (this._inner) await this._inner.unloadIdleResources();
    }
}

/** 白名单代理：whitelist 外的成员访问一律抛错（绝不委托 inner / 触 native）。 */
function wrapWithWhitelist(impl) {
    return new Proxy(impl, {
        get(target, prop) {
            if (typeof prop === "symbol") return undefined;
            if (prop === "then") return undefined; // 避免 thenable 误判
            if (WHITELIST.has(prop)) {
                const value = target[prop];
                return typeof value === "function" ? value.bind(target) : value;
            }
            // 自身的私有状态（_cfg/_mode 等）仅允许内省（util.inspect 走 ownKeys）
            if (Object.prototype.hasOwnProperty.call(target, prop)) return target[prop];
            throw new Error(
                "[qmd-embed-api] method " + String(prop) +
                " not supported in remote-embedding mode（白名单: embed/embedBatch/expandQuery/rerank/" +
                "generate/modelExists/dispose/tokenize/detokenize/countTokens/getDeviceInfo/" +
                "unloadIdleResources/embedModelName/generateModelName/rerankModelName）"
            );
        },
    });
}

function resolveDecoratedSingleton(mode) {
    return wrapWithWhitelist(new RemoteEmbedLlm({}, mode));
}

// getDefaultLlamaCpp()（llm.js）通过该桥按需取远程单例；非远程态返回 null 走本地原逻辑。
let defaultDecorated = null; // { mode, proxy }
globalThis.__qmdRemoteDefaultLlamaCpp = () => {
    let mode = null;
    if (isRemoteEmbedConfigured()) {
        mode = "full";
    } else if (looksLikeApiModel(process.env.QMD_EMBED_MODEL)) {
        mode = "degraded";
    }
    if (!mode) return null;
    if (!defaultDecorated || defaultDecorated.mode !== mode) {
        defaultDecorated = { mode, proxy: resolveDecoratedSingleton(mode) };
    }
    return defaultDecorated.proxy;
};

/** 三处工厂缝共用。同步返回。 */
export function __createLlamaCpp(config = {}) {
    if (isRemoteEmbedConfigured()) {
        return wrapWithWhitelist(new RemoteEmbedLlm(config, "full"));
    }
    const apiModel = looksLikeApiModel(config.embedModel)
        ? String(config.embedModel)
        : (looksLikeApiModel(process.env.QMD_EMBED_MODEL) ? String(process.env.QMD_EMBED_MODEL) : null);
    if (apiModel) {
        // config 已持久化 api:* 模型但本次三件套不齐：degraded，绝不回退 stock。
        // 顺手把 env 对齐，让 getDefaultLlamaCpp 钩子（chunkDocumentByTokens 等
        // 不经过工厂的路径）也能拿到 degraded 装饰器而不是 stock（否则 tokenize
        // 会去 HF 拉 embeddinggemma 卡死）。
        if (!looksLikeApiModel(process.env.QMD_EMBED_MODEL)) {
            process.env.QMD_EMBED_MODEL = apiModel;
        }
        return wrapWithWhitelist(new RemoteEmbedLlm(config, "degraded"));
    }
    return new LlamaCpp(config);
}
`;

// =============================================================================
// 三处缝的精确目标串（与 @tobilu/qmd 2.8.3 dist 逐字对齐）
// =============================================================================
const LLM_TARGET = [
    "export function getDefaultLlamaCpp() {",
    "    if (!defaultLlamaCpp) {",
].join("\n");
const LLM_REPLACED = [
    "export function getDefaultLlamaCpp() {",
    "    {",
    "        const remoteLlm = globalThis.__qmdRemoteDefaultLlamaCpp?.();",
    "        if (remoteLlm) {",
    "            return remoteLlm;",
    "        }",
    "    }",
    "    if (!defaultLlamaCpp) {",
].join("\n");
const INDEX_SEAM_TARGET = "    const llm = new LlamaCpp({";
const INDEX_SEAM_REPLACED = "    const llm = __createLlamaCpp({";
const CLI_SEAM_TARGET = "            const llm = new LlamaCpp({";
const CLI_SEAM_REPLACED = "            const llm = __createLlamaCpp({";
const INDEX_IMPORT = 'import { __createLlamaCpp } from "./qmd-embed-api.js";';
const CLI_IMPORT = 'import { __createLlamaCpp } from "../qmd-embed-api.js";';

function countOccurrences(haystack, needle) {
    let count = 0;
    let pos = haystack.indexOf(needle);
    while (pos !== -1) {
        count += 1;
        pos = haystack.indexOf(needle, pos + needle.length);
    }
    return count;
}

/** 单文件补丁：验证目标存在 → 备份 → 前置 import/替换。已打标（含 marker）则跳过。 */
function patchFile({ label, filePath, marker, edits = [], prependImport = null }) {
    if (!existsSync(filePath)) {
        throw new Error(`${label}: 文件不存在: ${filePath}`);
    }
    const original = readFileSync(filePath, "utf8");
    if (original.includes(marker)) {
        console.log(`  [跳过] ${label}: 已打过补丁`);
        return false;
    }
    let content = original;
    if (prependImport) {
        if (content.startsWith("#!")) {
            const nl = content.indexOf("\n");
            if (nl === -1) throw new Error(`${label}: 只有 shebang 没有正文?`);
            content = content.slice(0, nl + 1) + prependImport + "\n" + content.slice(nl + 1);
        } else {
            content = prependImport + "\n" + content;
        }
    }
    for (const edit of edits) {
        const n = countOccurrences(content, edit.target);
        if (n !== edit.expectedCount) {
            throw new Error(`${label}: 目标串出现 ${n} 次（期望 ${edit.expectedCount}），与预期不符:\n---\n${edit.target}\n---`);
        }
        content = content.replaceAll(edit.target, edit.replacement);
    }
    const backup = filePath + ".qmd-pre-patch.bak";
    if (!existsSync(backup)) {
        copyFileSync(filePath, backup);
    }
    writeFileSync(filePath, content);
    console.log(`  [完成] ${label}`);
    return true;
}

function restoreFile(filePath) {
    const backup = filePath + ".qmd-pre-patch.bak";
    if (existsSync(backup)) {
        copyFileSync(backup, filePath);
        console.log(`  [还原] ${filePath}`);
        return true;
    }
    console.log(`  [跳过] 无备份: ${filePath}`);
    return false;
}

function locateQmdDir() {
    const argIndex = process.argv.indexOf("--dir");
    if (argIndex !== -1 && process.argv[argIndex + 1]) {
        return resolve(process.argv[argIndex + 1]);
    }
    if (process.env.QMD_INSTALL_DIR) {
        return resolve(process.env.QMD_INSTALL_DIR);
    }
    const home = process.env.HOME || process.env.USERPROFILE || "";
    return resolve(home, ".bun", "install", "global", "node_modules", "@tobilu", "qmd");
}

function expectedRemoteState() {
    const triplet =
        !!process.env.KB_QMD_EMBED_BASE_URL?.trim() &&
        !!process.env.KB_QMD_EMBED_API_KEY?.trim() &&
        !!process.env.KB_QMD_EMBED_MODEL?.trim();
    if (triplet) return "full";
    if (looksLikeApi(process.env.QMD_EMBED_MODEL)) return "degraded";
    return "stock";
}
function looksLikeApi(v) {
    return typeof v === "string" && v.startsWith("api:");
}

async function verify(qmdDir) {
    const distUrl = (name) => pathToFileURL(join(qmdDir, "dist", name)).href;
    await import(distUrl("index.js"));
    const api = await import(distUrl("qmd-embed-api.js"));
    const llmMod = await import(distUrl("llm.js"));
    const state = expectedRemoteState();
    const envDesc = ["KB_QMD_EMBED_BASE_URL", "KB_QMD_EMBED_API_KEY", "KB_QMD_EMBED_MODEL", "QMD_EMBED_MODEL"]
        .map((name) => `${name}=${process.env[name] ? "<set>" : "<unset>"}`)
        .join(" ");
    const inst = api.__createLlamaCpp({
        embedModel: state === "degraded" ? "api:doubao-embedding-text-240715" : undefined,
        generateModel: "hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf",
        rerankModel: "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf",
    });
    const expectDecorated = state !== "stock";
    const isStock = inst instanceof llmMod.LlamaCpp;
    if (expectDecorated === isStock) {
        throw new Error(`自检失败: 期望 ${state} 态但工厂返回 ${isStock ? "stock LlamaCpp" : "decorator"}（${envDesc}）`);
    }
    // 白名单验证：未知成员必须抛错（stock 态跳过）
    if (expectDecorated) {
        try {
            inst.ensureEmbedContexts;
            throw new Error("自检失败: 白名单外成员访问未抛错");
        } catch (err) {
            if (!String(err.message).includes("not supported in remote-embedding mode")) {
                throw err;
            }
        }
        const eq = await inst.expandQuery("白名单自检查询");
        if (!Array.isArray(eq) || eq.length !== 2 || eq[0].type !== "lex" || eq[1].type !== "vec") {
            throw new Error("自检失败: expandQuery 返回形状不对");
        }
    }
    if (state === "full") {
        const model = process.env.KB_QMD_EMBED_MODEL;
        if (inst.embedModelName !== "api:" + model) {
            throw new Error(`自检失败: embedModelName=${inst.embedModelName}，期望 api:${model}`);
        }
        if (process.env.QMD_EMBED_MODEL !== "api:" + model) {
            throw new Error(`自检失败: QMD_EMBED_MODEL=${process.env.QMD_EMBED_MODEL}，期望 api:${model}`);
        }
        console.log(`  [自检通过] full 远程模式, embed 模型 = ${inst.embedModelName}, 白名单装饰器生效`);
    } else if (state === "degraded") {
        if (isStock) throw new Error("自检失败: degraded 态不应返回 stock LlamaCpp（会卡死在 HF 下载）");
        const r = await inst.embed("自检");
        if (r !== null) throw new Error("自检失败: degraded embed 应快速返回 null");
        console.log(`  [自检通过] degraded 态（三件套缺、模型 ${inst.embedModelName}）: 不回退 stock, embed 快速 null, 白名单装饰器生效`);
    } else {
        if (process.env.QMD_EMBED_MODEL) {
            throw new Error(`自检失败: 干净本地态不应改写 QMD_EMBED_MODEL（现为 ${process.env.QMD_EMBED_MODEL}）`);
        }
        console.log(`  [自检通过] 干净本地配置 → 原生 LlamaCpp（${envDesc}）`);
    }
}

async function main() {
    if (process.argv.includes("--revert")) {
        const qmdDir = locateQmdDir();
        console.log(`还原 qmd 补丁: ${qmdDir}`);
        restoreFile(join(qmdDir, "dist", "llm.js"));
        restoreFile(join(qmdDir, "dist", "index.js"));
        restoreFile(join(qmdDir, "dist", "cli", "qmd.js"));
        const provider = join(qmdDir, "dist", "qmd-embed-api.js");
        if (existsSync(provider)) {
            unlinkSync(provider);
            console.log(`  [删除] ${provider}`);
        }
        return;
    }

    const qmdDir = locateQmdDir();
    const pkgPath = join(qmdDir, "package.json");
    if (!existsSync(pkgPath)) {
        throw new Error(`未找到 qmd 安装目录（package.json 不存在）: ${qmdDir}\n用 --dir 指定，例如: node apply.mjs --dir /path/to/@tobilu/qmd`);
    }
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    console.log(`qmd 安装目录: ${qmdDir} (name=${pkg.name}, version=${pkg.version})`);
    if (pkg.name !== "@tobilu/qmd") {
        throw new Error(`目标不是 @tobilu/qmd: ${pkg.name}`);
    }
    if (pkg.version !== "2.8.3") {
        console.warn(`  [警告] 版本 ${pkg.version} 与补丁目标 2.8.3 不一致，缝字符串可能匹配失败`);
    }

    console.log("写入 provider ...");
    const providerPath = join(qmdDir, "dist", "qmd-embed-api.js");
    writeFileSync(providerPath, PROVIDER_SOURCE);
    console.log(`  [完成] ${providerPath}`);

    console.log("改写工厂缝 ...");
    patchFile({
        label: "dist/llm.js (getDefaultLlamaCpp 钩子)",
        filePath: join(qmdDir, "dist", "llm.js"),
        marker: "__qmdRemoteDefaultLlamaCpp",
        edits: [{ target: LLM_TARGET, replacement: LLM_REPLACED, expectedCount: 1 }],
    });
    patchFile({
        label: "dist/index.js (import 注入 + 工厂缝)",
        filePath: join(qmdDir, "dist", "index.js"),
        marker: "qmd-embed-api.js",
        prependImport: INDEX_IMPORT,
        edits: [
            {
                target: INDEX_SEAM_TARGET,
                replacement: INDEX_SEAM_REPLACED,
                expectedCount: 1,
            },
        ],
    });
    patchFile({
        label: "dist/cli/qmd.js (shebang 后 import 注入 + 工厂缝)",
        filePath: join(qmdDir, "dist", "cli", "qmd.js"),
        marker: "qmd-embed-api.js",
        prependImport: CLI_IMPORT,
        edits: [
            {
                target: CLI_SEAM_TARGET,
                replacement: CLI_SEAM_REPLACED,
                expectedCount: 1,
            },
        ],
    });

    console.log("自检 ...");
    await verify(qmdDir);
    console.log("补丁应用完成。");
}

main().catch((err) => {
    console.error("apply.mjs 失败:", err instanceof Error ? err.message : err);
    process.exit(1);
});
