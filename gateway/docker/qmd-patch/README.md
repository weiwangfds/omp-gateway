# qmd 远程 embedding provider 补丁（OpenAI 兼容 / ark doubao）

给全局安装的 `@tobilu/qmd@2.8.3`（Bun 全局，dist 为 ESM）打补丁，使 `embed/embedBatch` 走
OpenAI 兼容远程 API（火山方舟 doubao-embedding-text-240715，2560 维），本地 GGUF /
node-llama-cpp 完全不参与 embed 路径。

- 应用方式：`node gateway/docker/qmd-patch/apply.mjs`（幂等可重放；`--dir` 指定安装目录；
  `--revert` 从 `.qmd-pre-patch.bak` 还原）。
- 本机安装当前处于**已验证可用**状态（v1 provider）；repo 中的 apply.mjs 含 v2 纵深防御
  改造（见文末「版本说明」），上线前需按同一端到端标准复验。

## 三件套环境变量（qmd 进程 env，部署必配）

| 变量 | 含义 | 示例 |
|---|---|---|
| `KB_QMD_EMBED_BASE_URL` | OpenAI 兼容服务根地址 | `https://ark.cn-beijing.volces.com/api/v3` |
| `KB_QMD_EMBED_API_KEY` | Bearer token | （来自 kb 项目 `.env` 的 `KB_EMBEDDING_API_KEY`，映射后不落盘） |
| `KB_QMD_EMBED_MODEL` | embedding 模型名 | `doubao-embedding-text-240715` |
| `KB_QMD_EMBED_BATCH` | 可选，单请求 input 条数（默认 16） | `16` |

gateway entrypoint 已有门禁：三件套齐才进入远程模式。

## 三处工厂缝（apply.mjs 运行时改写 dist，均有逐字目标串校验 + marker 防重放）

1. `dist/llm.js` — `getDefaultLlamaCpp()` 函数体开头插入钩子（经 `globalThis` 桥接，避免循环 import）：

   ```diff
    export function getDefaultLlamaCpp() {
   +    {
   +        const remoteLlm = globalThis.__qmdRemoteDefaultLlamaCpp?.();
   +        if (remoteLlm) {
   +            return remoteLlm;
   +        }
   +    }
        if (!defaultLlamaCpp) {
            defaultLlamaCpp = new LlamaCpp();
   ```

2. `dist/index.js` — 文件头注入 `import { __createLlamaCpp } from "./qmd-embed-api.js";`；
   `    const llm = new LlamaCpp({` → `    const llm = __createLlamaCpp({`（createStore 的每 store 实例）。

3. `dist/cli/qmd.js` — shebang 行后注入 `import { __createLlamaCpp } from "../qmd-embed-api.js";`；
   `            const llm = new LlamaCpp({` → `            const llm = __createLlamaCpp({`（CLI 的 setDefaultLlamaCpp 单例）。

`dist/mcp/server.js`、`dist/bench/*.js` 经 `../index.js` 间接被缝 2 覆盖，无需单独处理。

## provider 能力面（dist/qmd-embed-api.js）

| 成员 | 实现 |
|---|---|
| `embed(text)` / `embedBatch(texts)` | `POST {BASE_URL}/embeddings`，仅 http(s)，`AbortSignal.timeout(120s)`；分批（`KB_QMD_EMBED_BATCH`，默认 16）保序并发 ≤4；响应 `data[]` 按 index 排序；单批失败重试 2 次（退避 1s/2s）后整批返回 `null`（qmd 记为未嵌入、下次 embed 续跑），错误写 stderr |
| `expandQuery(q)` | 返回 `[{type:'lex',text:q},{type:'vec',text:q}]`：原查询同进 BM25 与向量路，无 LLM 扩展（不触 1.7B generate 模型） |
| `rerank(q, docs)` | 输入序等分 `{file,score:1,index}`（无本地重排模型；等分使融合公式保持 RRF 序） |
| `tokenize/detokenize/countTokens` | 启发式分词：CJK 1 码点 = 1 token，其余 4 字符 = 1 token（对齐 qmd 自身 ~4 chars/token 估算）；token 即原文片段，join 精确还原（`chunkDocumentByTokens` 依赖） |
| `getDeviceInfo` | 合成纯 CPU 信息（远程模式不加载本地 llama 运行时，doctor 设备探测不触 native） |
| `embedModelName` | `api:<model>`（doctor/status 显示、embed 指纹、DB model 列三者一致） |
| `generateModelName` / `rerankModelName` | 字符串解析（与 LlamaCpp 构造函数同逻辑），**不构造 inner** |
| `modelExists` | `{name, exists:true}`（远程模型无存在性检查） |
| `dispose` | 幂等；仅当 generate 已构造过 inner 时才委托 dispose |
| `generate` | **唯一允许惰性构造 inner LlamaCpp 的方法**（显式本地生成请求；远程管线不应触发） |

- 模块加载即设 `process.env.QMD_EMBED_MODEL = "api:" + KB_QMD_EMBED_MODEL`（在所有 LlamaCpp
  实例化之前），使 embed 指纹（sha256(model URI + 格式化探针 + 分块参数)[:6]）与 status/doctor
  显示反映远程模型。
- 构造器与全部方法均不 import node-llama-cpp；inner 仅 generate 路径可构造。

## 已实测的调用面覆盖（grep dist 枚举 + 运行验证）

管线对 llm 对象的全部访问面（`store.js`/`cli/qmd.js`/`mcp/server.js`/`index.js`）：
`embed`、`embedBatch`、`expandQuery`、`rerank`、`tokenize`、`detokenize`、`getDeviceInfo`、
`dispose`、`embedModelName`、`generateModelName`、`rerankModelName`、`modelExists`（管线外零调用）、
`generate`（管线外零调用）、`countTokens`/`unloadIdleResources`（管线外零调用）——**全部被 provider
覆盖或显式合成，无未覆盖委托路径**。

实测（本机 Windows，qmd 跑在 Bun runtime）：

- `qmd --index kb vsearch "write leveling training" -c kb-jedec -n 3` → 1.4-1.6s，命中
  `LPDDR6-JESD209-6.md?index=kb:1797 #476beb` Score 70%；中文/混合查询 69-100% 命中。
- daemon `/query`（8181 MCP）2.5s 正常；`qmd get "#476beb" -l 3`、`qmd search "training"`、
  `qmd --index kb status`（显示 api:doubao-embedding-text-240715）回归正常。
- provider 直连（bun -e → `__createLlamaCpp({})`）：embed 158-231ms 返回 2560 维；
  embedBatch 保序、可复现；带/不带代理 env 均正常。
- `qmd doctor`：`sqlite-vec v0.1.9` 可用；模型显示 `api:doubao-embedding-text-240715`；
  指纹 `e5e760`（远程）≠ `c37385`（本地），模型切换由指纹机制识别、需重建向量。
- 干净本地配置（无三件套、无 api: 污染的 config）→ 工厂返回原生 LlamaCpp，doctor/search 正常。

## 已知行为与部署要求（重要）

**未配三件套 → qmd 回退原生本地 GGUF 路径，在本机形态下会静默挂死**（主线已实测定位，
非 provider 缺陷）：

- 机制：三件套缺失时工厂返回原生 `LlamaCpp`。vsearch 是唯一在输出任何内容之前就调用
  `store.expandQuery()` 的命令；原生 `expandQuery` → `ensureGenerateModel()` →
  `resolveModelFile("hf:tobil/qmd-query-expansion-1.7B...")` 向 HF 发起下载，网络不通时
  **静默挂起 45-130s+（零输出、零 CPU）**；node-llama-cpp 原生二进制缺失时同样会静默挂起。
  `search`（BM25）/`get`/`status` 不走 expandQuery，不受影响。
- 加重因素：qmd 的 `ensureModelsConfiguredForCli` 会在远程模式跑过一次后把解析出的
  `models.embed: api:doubao-embedding-text-240715` **持久化进 config yml**（原生 saveConfig
  行为）。此后即使想回本地模式，该 config 目录下的 embed URI 已是无效的 `api:` scheme
  （embed 快速报错 "No model file found"），本地路径实际不可用。
- **部署要求：必须保证三件套在 qmd 进程 env 中**（entrypoint 已有门禁）；如需本地模式，
  使用从未跑过远程模式的干净 `QMD_CONFIG_DIR`。切勿在缺三件套的 shell 里对已污染 config
  目录执行 vsearch/embed。

## 版本说明

- **v1（本机当前已应用、已验证）**：三件套齐 → 远程装饰器；否则 → 原生 LlamaCpp（契约
  「未配置行为不变」仅对干净 config 成立，见上）。
- **v2（repo 中 apply.mjs，纵深防御，未应用到本机）**：在 v1 基础上增加
  (a) 白名单式包装——对 llm 对象白名单外成员访问抛
  `[qmd-embed-api] method X not supported in remote-embedding mode`，绝不委托 inner、绝不
  import node-llama-cpp，inner 仅 `generate` 显式调用时构造（含 `_innerCaller` 不变量断言）；
  (b) 污染态防护——三件套缺但 embed 模型已是 `api:*` 时返回 degraded 装饰器
  （expandQuery/rerank/tokenize 走合成实现、embed 快速 null + stderr 告警），**消灭上述挂死**。
  v2 已通过语法校验；**上线前必须按「已实测的调用面覆盖」一节的同一端到端标准复验**。
