# 集成指南（python / go / ts 等集成端）

网关为**多语言集成端**提供统一 HTTP/SSE 契约；不需要任何 omp SDK 依赖。
本文按「提示词注入 → 取状态 → 收事件 → 收回调」四件事组织，每节给出端点为契约。
**四件事全部以会话（sid）为作用域**：注入 `/:sid/inject`、状态 `/:sid/bootstrap`、事件 `/:sid/events`、回调 `/:sid/webhooks`；
仅用户级跨会话汇总（`/api/me/webhooks`）与创建期选项（`appendSystemPrompt`/`contextFiles`，作用于新会话）例外。
客户端代码请按 `GET /openapi.json` 自行生成（网关不产出客户端实现）。

---

## 0. 认证与基础

```http
Authorization: Bearer <service-token>     # 上游服务共享；逗号分隔可双 token 轮换
X-User-Id: <user-id>                      # 代用户调用（必带）
X-Admin-Id: <admin-id>                    # 仅 /admin/* 全局管理面
X-Request-Id: <uuid>                      # 可选；缺省生成并回显
Idempotency-Key: <key>                    # 可选；POST /api/sessions 等写操作 24h 幂等
```

- 响应错误体统一 `{"error":{"code,message,details?}}`；按 `code` 分支，见 `error-codes.md`。
- 分页端点统一 `page`/`per_page`（0 基），返回 `total`。
- 时间均为 ISO8601 字符串；`seq` 为会话内单调整数（事件游标）。

---

## 1. 提示词注入（三层）

### 1.1 创建期：系统提示词追加 + 上下文文件

`POST /api/sessions`

```json
{
  "title": "业务会话",
  "model": { "provider": "minimax", "modelId": "MiniMax-M3.1-Flash" },
  "appendSystemPrompt": "你是本公司的客服助手，回答必须引用知识库编号。",
  "contextFiles": [
    { "path": "kb/policy.md", "content": "...业务规则全文..." }
  ],
  "noContextFiles": true
}
```

| 字段 | 语义 |
|---|---|
| `appendSystemPrompt` | 追加到默认系统提示词末尾（不替换，安全） |
| `contextFiles` | 作为 AGENTS.md 式上下文进入系统提示词（**只进提示词、不落盘**）；单文件 ≤256KB、合计 ≤1MB、≤20 个 |
| `noContextFiles` | 禁用 cwd 向上发现的 AGENTS.md（只保留显式注入） |
| `additionalDirectories` | 额外工作目录（必须在用户数据根内） |

> 系统提示词在会话创建后**不可变**（SDK 契约）。需要改提示词请创建新会话，或改用 1.2 的上下文注入。

### 1.2 运行期：上下文注入（不耗模型、不进用户角色）

`POST /api/sessions/:sid/inject`

```json
{
  "text": "客户已升级为 VIP，后续报价打 8 折。",
  "mode": "context",
  "customType": "business.rule",
  "deliverAs": "nextTurn"
}
```

| 字段 | 语义 |
|---|---|
| `mode: "context"`（默认） | 以自定义消息形式写入上下文；**不触发 turn**（不耗 token 预算） |
| `mode: "user"` | 走 prompt 流程（用户消息；idle 起 turn，streaming 转 steer） |
| `triggerTurn: true` | context 模式下同时触发新一轮（会做 RPM/预算检查） |
| `deliverAs` | `steer`（插话打断） / `followUp`（本轮后追加） / `nextTurn`（下轮开头） / `aside`（不干扰工具批次的旁注） |
| `wait` + `waitTimeoutMs` | 触发 turn 后同步等待终态（上限 600s），返回 `timedOut` |

响应（202）：
```json
{ "ok": true, "mode": "context", "admitted": true, "triggeredTurn": false,
  "streaming": false, "model": {"provider":"…","modelId":"…"}, "latestSeq": 42 }
```

### 1.3 模板注入（复用 omp 斜杠命令）

`POST /api/sessions/:sid/prompt {"text": "/<命令或模板名> [参数]"}` —— SDK 负责展开：
- 文件式斜杠命令 / prompt 模板（列表见 `GET /:sid/commands`）
- `/compact <mode>`、`/handoff`、`/model`、`/btw` 等原生命令
- MCP prompts（`GET /:sid/commands` 的 `mcpPrompts`）

---

## 2. 获取状态

### 2.1 初始化一次拿全

`GET /api/sessions/:sid/bootstrap` → `session` / `state`（模型/思考档/队列/工具/上下文用量）/
`modes`（plan/goal/自动压缩/重试/运行标志）/ `approvals`（待审批）/ `commands` / `events`（事件入口与游标）。

### 2.2 轻量轮询

`GET /api/sessions/:sid/status` → `{status, model, thinkingLevel, pendingApprovals, queueCount, latestSeq}`

### 2.3 明细

| 端点 | 内容 |
|---|---|
| `GET /:sid/state` | 完整状态（含 queue/tools/contextUsage） |
| `GET /:sid/context` | 上下文用量 + 分桶明细 |
| `GET /:sid/modes` | 全部模式面板状态 |
| `GET /:sid/messages` | 消息列表（`?since=`） |
| `GET /:sid/entries` | 会话条目（分叉寻址键） |
| `GET /:sid/todos` | Todo 阶段 |
| `GET /:sid/commands` | 命令/模板/MCP prompts 清单 |
| `GET /:sid/approvals` | 待审批清单 |
| `GET /:sid/skills` / `/:sid/mcp` / `/:sid/lsp` | 资源发现 |
| `GET /:sid/jobs` | 后台任务树 |

---

## 3. 收取事件（两条通道，可组合）

### 3.1 SSE（实时）

```http
GET /api/sessions/:sid/events?types=text.delta,tool.*,turn.completed
Last-Event-ID: <seq>          # 断线重连：回放 seq 之后的事件
```

- 首帧恒为 `replay.state`（`{sessionId,status,subscribers,lastEventId}`）
- `id:` = `seq`（会话内单调），`event:` = 事件类型，`data:` = JSON
- **先订阅后 prompt**；断开=仅解绑订阅（不打断 agent）
- `types` 逗号分隔，支持后缀 `*` 通配；`replay.state`/`error` 恒放行
- 服务端每 10s 发 `: keep-alive` 注释行；客户端应设较长读超时（≥60s）

### 3.2 JSON 回放（轮询/补齐）

`GET /api/sessions/:sid/events/replay?since=<seq>&limit=200&types=tool.*`

```json
{ "events": [ … ], "count": 12, "nextSince": 54, "latestSeq": 54,
  "truncated": false, "bufferLimit": 500 }
```

环形缓冲保留最近 500 条；更早历史用 `/messages`、`/entries`。适合低并发集成端或用 SSE 断线后补齐。

### 3.3 事件全集

见 `gateway-events.v1.schema.json`（26 类型）。UI 映射见 `frontend-mapping.md`。
关键事件：`text.delta` / `tool.started{args}` / `tool.completed` / `turn.completed{isTerminal,usage}` /
`tool.confirm_required` / `todo.*` / `compaction.*` / `retry.*` / `model.fallback`。

---

## 4. 接收回调（webhook，**会话级优先**）

集成端按**会话**注册回调：只收该会话事件，天然隔离（多租户/多任务场景不串流）。
需要跨会话汇总时才用用户级订阅（收该用户全部会话事件）。

### 4.1 会话级管理（推荐）

| 方法 | 端点 | 说明 |
|---|---|---|
| `GET` | `/api/sessions/:sid/webhooks` | 列出该会话订阅（不含 secret，含 `sessionId`） |
| `POST` | `/api/sessions/:sid/webhooks` | `{url, events?: string[], secret?: string}`；响应一次性返回 `secret` |
| `DELETE` | `/api/sessions/:sid/webhooks/:id` | 注销（仅本会话订阅；跨用户/跨会话 404） |

### 4.2 用户级管理（跨会话汇总，可选）

| 方法 | 端点 | 说明 |
|---|---|---|
| `GET` | `/api/me/webhooks` | 列出本人全部订阅（`sessionId=null` 为用户级） |
| `POST` | `/api/me/webhooks` | 注册用户级订阅（`session_id=NULL`）→ 收该用户全部会话事件 |
| `DELETE` | `/api/me/webhooks/:id` | 注销任意本人订阅 |

匹配规则：用户级订阅收该用户全部会话；会话级订阅只收绑定会话。
高频事件（`text.delta`/`omp.raw`）**不投递**；生命周期/工具/面板事件全部投递。

### 4.3 投递格式

```http
POST <your-url>
content-type: application/json
x-omp-signature: <hex hmac-sha256(secret, rawBody)>
x-omp-session: <sid>
```
```json
{ "sessionId": "…", "event": { "type": "turn.completed", "seq": 54, "ts": 1794743739, "isTerminal": true, "usage": { } } }
```

**验签**：对**原始 body 字节**做 HMAC-SHA256 后十六进制比较（勿先解析再序列化）。
失败重试一次（2s 后）；仍失败则丢弃（需要更高可靠性请以 SSE/回放为准）。

### 4.4 回调 vs 同步等待的选择

| 场景 | 推荐 |
|---|---|
| Go/Python 服务端（无长连接） | 会话级回调 + `prompt {wait:true}` 同步模式兜底 |
| 前端/桌面客户端 | SSE（按会话） |
| 批处理/离线 | `events/replay` 轮询 |
| 有审批交互 | 必须 SSE 或轮询 `GET /:sid/approvals` 才及时拿到 `confirm_required` |

### 4.5 自描述

`GET /api/sessions/:sid/integration` 返回本会话全部集成端点 + 契约文档路径（便于集成端自检/版本探测）。

## 5. 生命周期钩子（hooks，双作用域）

omp 官方 hooks 只有 TS 回调；网关提供 **HTTP 钩子**：集成端注册 URL，网关在生命周期节点调用。
与「事件回调（webhook）」的区别：钩子可在节点上**同步决策**（拦截/改写），webhook 只是事后通知。

### 5.1 双作用域

| 作用域 | 端点 | 生效范围 |
|---|---|---|
| 会话级 | `GET/POST /api/sessions/:sid/hooks`、`DELETE /:sid/hooks/:id` | 仅该会话 |
| 用户级 | `GET/POST /api/me/hooks`、`DELETE /api/me/hooks/:id` | 该用户所有会话 |

注册体：`{event, url, mode: "notify"|"decide", matcher?: {tool: "bash|edit"}, timeoutMs?: 3000, onTimeout?: "allow"|"deny", secret?}`

### 5.2 决策型事件（mode=decide，同步等响应）

| event | 返回 | 说明 |
|---|---|---|
| `input` | `{text}` 改写 / `{handled:true}` 拦截 / `{block:true,reason}` 拒绝 | 用户输入审查（prompt 与 inject 均生效） |
| `tool_call` | `{block:true,reason}` / `{input}` 改参 / `{additionalContext}` | 工具拦截（业务权限/危险命令） |
| `tool_result` | `{content}` / `{isError}` / `{additionalContext}` | 工具输出脱敏/改写 |
| `context` | `{messages}` | 本次模型调用的上下文（不改存储） |
| `before_agent_start` | `{systemPrompt}` / `{message:{content}}` | 提示词注入（钩子版） |
| `resources_discover` | `{skillPaths?, promptPaths?, themePaths?}` | 动态技能/模板路径 |
| `session_before_switch` / `session_before_branch` / `session_before_compact` / `session_before_tree` | `{cancel:true}` | 导航/压缩前拦截 |
| `session.compacting` | `{context?, prompt?, preserveData?}` | 自定义压缩输入 |
| `session_stop` | `{continue:true, additionalContext}` / `{decision:"block", reason}` | 阻止停止，让 agent 继续 |
| `user_bash` / `user_python` | `{result}` | 用户 !/$ 命令（TUI 场景） |

**合并语义**（对齐官方）：block/cancel 首个获胜；input/content/messages/systemPrompt 末个获胜且**链式**
（后续钩子的载荷含前面改动）；resources/message 累积；session_stop 首个非空 continuation 获胜。
**超时**：`onTimeout: "deny"` → tool_call/input 视为 block、session_before_* 视为 cancel（fail-closed）。

### 5.3 通知型事件（mode=notify）

`session_start` / `session_shutdown` / `turn_end` / `agent_end` / `session_compact` /
`tool_approval_requested` / `tool_approval_resolved`（异步，失败 2s 后重试一次）。

### 5.4 投递格式

```http
POST <your-hook-url>
content-type: application/json
x-omp-signature: <hmac-sha256(secret, rawBody)>
x-omp-hook-event: tool_call
x-omp-hook-id: <hook id>
```
tool_call 载荷：`{event, sessionId, ts, toolName, toolCallId, input}`；tool_result 额外带 `text`(≤8KB)、`isError`。

**验签**：对原始 body 字节做 HMAC-SHA256（勿解析后重序列化）。

## 6. 业务工具（HTTP custom tools，双作用域）

业务系统把自己的函数暴露给 agent（无需写 TS，与 MCP 并列的轻量路径）。

| 作用域 | 端点 | 可见性 |
|---|---|---|
| 用户级 | `GET/PUT /api/me/tools/http[/:name]`、`DELETE` | 该用户全部会话 |
| 会话级 | `GET/PUT /api/sessions/:sid/tools/http[/:name]`、`DELETE` | 仅该会话（同名覆盖用户级） |

注册体：
```json
{
  "description": "查询订单状态（业务系统）",
  "parameters": { "type": "object", "properties": { "orderId": { "type": "string" } }, "required": ["orderId"] },
  "url": "https://biz.example.com/tools/order_status",
  "label": "订单查询",
  "timeoutMs": 10000,
  "approval": "exec"
}
```

执行：模型调用时网关 POST 业务端点（带 `x-omp-signature`/`x-omp-tool`/`x-omp-tool-call-id`/`x-omp-session`），
body `{toolCallId, name, args, sessionId, userId}`；响应 `{"text":"…"}` 或 `{"content":[…],"isError":false}`。
超时/不可达 → 工具结果 `isError:true`（模型可见，不中断 turn）。

**生效时机**：新建会话自动注入；运行期新增/删除**热生效**（refreshMCPTools）；
`POST /:sid/mcp/reload` 后网关自动重放（无需集成端处理）。

## 7. 推荐调用序列

```
1. POST /api/sessions                  → sid（携带 appendSystemPrompt/contextFiles）
2. GET  /:sid/bootstrap                → 模型/命令/审批/游标
3. GET  /:sid/events (SSE) 或 POST /:sid/webhooks (会话级回调)；业务拦截用 POST /:sid/hooks
   业务工具用 PUT /api/me/tools/http/:name（或会话级 /:sid/tools/http/:name）
4. POST /:sid/prompt {text, wait?:false}
   … 消费 text.delta / tool.* / turn.completed
5. 若出现 tool.confirm_required → POST /:sid/approvals/:approvalId {approve}
6. 需要追加业务上下文 → POST /:sid/inject {mode:"context", deliverAs:"nextTurn"}
7. 断线 → 带 Last-Event-ID 重连，或 GET /:sid/events/replay?since=<nextSince>
```

## 8. 多语言实现注意

| 项 | 建议 |
|---|---|
| SSE 解析 | 按 `\n\n` 分帧，逐行解析 `id:`/`event:`/`data:`；`data` 单行 JSON（网关不折行） |
| 长连接 | 读超时 ≥60s（网关 10s 心跳）；HTTP/1.1 禁用连接复用超时、HTTP/2 关闭 stream idle timeout |
| 重连 | 指数退避 + 携带 `Last-Event-ID`；`replay.state` 帧用于对齐本地状态 |
| 幂等 | 创建会话/快照带 `Idempotency-Key`，重试安全（24h） |
| 限流 | 429 按 `Retry-After` 退避；`GET /api/me/limits` 可预读配额 |
| 并发 | 全局/每用户 streaming 上限（排队 60s 后 429 `STREAM_QUEUE_TIMEOUT`） |
| 时区 | 所有时间 UTC（ISO8601 / `ts` 为 epoch ms） |

## 9. 结构化配置写入（JSON，不用拼 YAML/Markdown）

配置类端点同时接受**原文**与**结构化 JSON**；结构化通道由网关校验并格式化成 omp 认的格式。
字段清单/正则/示例见 `GET /api/me/config/schema`（前端可直接生成表单）。

### 9.1 Provider / `models.yml`

```http
PUT /api/me/models/config
Content-Type: application/json

{
  "providers": {
    "minimax": {
      "baseUrl": "https://api.minimax.cn/v1",
      "api": "openai-completions",
      "apiKey": "MINIMAX_API_KEY",
      "models": [
        { "id": "MiniMax-M3.1-Flash", "name": "MiniMax M3.1 Flash", "contextWindow": 200000 }
      ]
    }
  }
}
```

- 落盘为 2 空格缩进 YAML；`GET /api/me/models/config?format=json` 读回同构对象。
- 单 provider：`GET/PUT/DELETE /api/me/models/providers/:provider`（PUT=整体替换，其他 provider 不动）。
- 凭据仍可用 `POST /api/me/models/credentials {provider,apiKey}`。
- 原文 `PUT`（`text/yaml`）继续可用；**结构化写入会重写文件，注释不保留**。

### 9.2 Agent 定义

```http
PUT /api/me/agents/release-auditor
Content-Type: application/json

{
  "description": "Check release readiness and report concrete blockers.",
  "tools": ["read", "grep", "glob", "bash"],
  "model": "@slow",
  "thinkingLevel": "high",
  "prewalk": false,
  "advisor": "@advisor",
  "instructions": "You audit releases. Report blockers as a bulleted list."
}
```

- `POST /api/me/agents` 创建（`name` 放 body；同名已存在 → 409 `ALREADY_EXISTS`）；PUT 的 name 取自路径，body.name 如给出必须一致。
- 全局侧：`GET/PUT/DELETE /admin/global/agents[/:name]`（X-Admin-Id，与用户级同构双通道）。全局定义在会话创建时合成进各用户 workspace `.omp/agents/`（用户同名定义跳过合成 = 用户覆盖全局）；`GET /api/me/agents` 清单带 `scope: user|global` 标签。
- `GET /api/me/agents/:name?format=json` → 规范字段 + `frontmatter` 原对象 + `instructions`。
- 未建模字段会被 400；需要完全自由格式时用原文通道：
  `{"content": "---\nname: x\ndescription: ...\n---\n..."}`（或 `text/markdown` PUT）。
- `tools: []` = 显式空 allowlist；`spawns: "*"` = 允许全部。

### 9.3 兼容与边界

- 老客户端把 YAML/Markdown 原文标成 `application/json` 不会被误判：仅「JSON 类型 + 正文以 `{`/`[` 开头」走结构化；
  `?format=json|yaml|markdown` 可显式覆盖。
- `GET /api/me/models/config?format=json` 含明文 apiKey（与原文 GET 一致，仅全权身份）；
  `GET /api/me/providers` 只给 `hasApiKey`，可安全用于展示。
- 校验错误码：`INVALID_CONFIG` / `INVALID_PROVIDER` / `INVALID_AGENT` / `INVALID_FRONTMATTER` / `INVALID_JSON`。
