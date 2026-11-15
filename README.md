# la-sequnce-omp

**多租户 omp 会话引擎网关** —— 基于 omp SDK（`@oh-my-pi/pi-coding-agent`，进程内嵌，无 RPC/子进程），
把单机编码 agent 变成可多用户、多会话、可管理、可观测的**服务**。

```
React（assistant-ui + a2ui）
   │ REST + SSE
Python 业务后端（用户/认证/业务，权限在这里）
   │ X-User-Id + svc-token（内网）
omp gateway（本仓库：Bun + Hono + omp SDK）
   └─ 进程内 AgentSession × N（每会话私有 AgentRegistry）
```

- 设计与全部语义：[`docs/DESIGN.md`](docs/DESIGN.md)（§1 定位 / §5 快照 / §6 事件契约 / §18 管理权限）
- **运维手册（SOP）**：[`docs/SOP.md`](docs/SOP.md)（部署 / 接入 / 日常运维 / 故障速查 / 环境迁移 / 发布检查表）
- 机器可读契约：运行时 `GET /openapi.json`（193 个操作，含摘要、请求体、错误码）；事件：[`contracts/gateway-events.v1.schema.json`](contracts/gateway-events.v1.schema.json)
- 测试：`cd gateway && bun run test`（28 个文件串行，约 295 项：离线全量 + 真实模型 e2e 自动跳过/执行）

## 快速上手

### Docker（推荐）

镜像内置 Bun（网关）+ Node 22/npm + Conda `omp`（python/uv）三套运行时；
**工作区根目录由宿主机挂载进容器**，会话产出与状态都在挂载卷里，宿主机可直接读写。

```bash
cd gateway && docker build -t omp-gateway:latest .
WORKSPACE_ROOT=/srv/omp-workspace GATEWAY_SERVICE_TOKENS=change-me \
  docker compose up -d
```

### 本机

```bash
cd gateway
cp .env.example .env          # 至少设置 GATEWAY_SERVICE_TOKENS
bun install
bun dev                       # http://127.0.0.1:8787
```

最小调用链（上游视角）：

```bash
curl -X POST http://127.0.0.1:8787/api/sessions \
  -H "Authorization: Bearer $TOKEN" -H "X-User-Id: u_42" \
  -d '{"model":{"provider":"minimax","modelId":"MiniMax-M3.1-Flash"}}'
# → 订阅 GET /api/sessions/:sid/events (SSE) → POST .../prompt
```

## 核心语义（详见 DESIGN）

| 域 | 语义 |
|---|---|
| 多租户 | 每 user_id 私有 `agentDir`（models.yml/mcp.json/skills/extensions/凭据）；API key 不进 process.env |
| 会话 | 1:1 workspace；归档只读；删除=trash 30 天→物理清除；IdleCuller 空闲回收、按 sessionFile 秒级复活 |
| 快照 | JSONL 持续自动保存 + 命名快照（总是物化）；restore=fork（新 sid）/rollback（同 sid 换文件，仅 idle） |
| 事件 | gateway-events v1.2（规范化，26 类含 todo/goal/队列/压缩/重试面板事件）；先订阅后 prompt；Last-Event-ID 重连 + replay.state |
| 并发 | 全局/每用户 streaming 上限，超限 FIFO 排队（429+Retry-After） |
| 作用域 | skill/MCP/tool 三层：project > user > global（用户同名覆盖全局） |
| 管理 | 用户级 `/api/me/*`；全局级 `/admin/global/*`（上游注入 `X-Admin-Id`，网关无权限体系只认标识） |
| 通知 | webhooks（HMAC-SHA256 签名 + 可选 host 白名单）+ Prometheus `/metrics` |
| 审批 | 用户级 `tools.approvalMode`（四模式）+ 按工具 policies + grants；SSE `tool.confirm_required` → `POST /:sid/approvals/:id` |
| 网页控制台 | 命令面板/模型目录/todo/上下文/模式面板/细粒度中断/队列/标题/分叉树/会话检索（DESIGN §21） |
| 集成面 | 分页 total · 配额 `GET /api/me/limits` · SSE `?types=` 过滤 · 可选 CORS · 错误码契约 |

## 多语言集成（python / go / ts / React）

网关对外只有 HTTP/SSE；集成端不需要 omp SDK，也不需要网关客户端代码。
**四件事全部以会话（sid）为作用域**（详见 `contracts/integration-guide.md`）：

| 能力 | 会话级端点 |
|---|---|
| 提示词注入 | 创建期 `{appendSystemPrompt, contextFiles}`；运行期 `POST /:sid/inject {text, mode:context\|user, deliverAs, triggerTurn, wait}` |
| 取状态 | `GET /:sid/bootstrap`（一次拿全）/ `GET /:sid/status`（轻量轮询）/ `GET /:sid/integration`（自描述） |
| 收事件 | SSE `GET /:sid/events?types=`（先订阅后 prompt）/ JSON `GET /:sid/events/replay?since=` |
| 收回调 | `POST /:sid/webhooks`（会话级，推荐）/ `POST /api/me/webhooks`（用户级跨会话汇总） |
| 生命周期钩子 | `POST /:sid/hooks`（会话级）/ `POST /api/me/hooks`（用户级）——`notify` 通知、`decide` 同步决策（21 事件：input/tool_call/tool_result/context/before_agent_start/session_before_*/session_stop…） |
| 业务工具 | `PUT /api/me/tools/http/:name`（用户级）/ `PUT /:sid/tools/http/:name`（会话级）——业务 HTTP 端点注册为 agent 工具（JSON Schema 参数 + HMAC 回调） |
| 会话文件 | `POST /api/sessions/validate`（JSONL 校验）/ `POST /api/sessions/import`（导入）/ `GET /:sid/session-file`（原始下载） |
| 条目/工具面 | `GET /:sid/entries?type=&offset=&limit=`、`PUT/DELETE /:sid/entries/:id/label`；`GET /:sid/tools/info`（参数/来源/active） |
| 上下文文件 | `GET/PUT/DELETE /api/me/context-files/:name`（AGENTS/RULES/APPEND_SYSTEM/SYSTEM）；`GET /:sid/context-files`（来源 + applied）；创建期 `{appendSystemPrompt, systemPrompt, contextFiles, noContextFiles}` |
| Provider 面 | `GET /api/me/providers`（结构化视图，不泄明文）/ `PUT /api/me/providers/settings {disabledProviders}`；`GET /api/me/models?find=` |
| 角色与 Agent | `GET/PUT /api/me/model-roles {roles, cycleOrder}`；`GET/PUT/DELETE /api/me/agents/:name`（frontmatter 校验）；`GET /:sid/agents/definitions` |
| MCP 明细 | `GET /:sid/mcp/servers`（状态/传输/工具）/ `POST /:sid/mcp/servers/:name/reconnect` / `GET /:sid/mcp/servers/:name/resources` / `PUT /api/me/mcp/settings {disabledServers}` |

补充：
1. `POST /:sid/prompt` 与 `/inject` 均支持 `wait:true` 同步等待 turn 终态（无 SSE 能力的集成端）
2. 审批准入：SSE `tool.confirm_required` → `POST /:sid/approvals/:approvalId`
3. 停止：`POST /:sid/interrupt {target}`；面板数据：`/commands` `/models` `/todos` `/context` `/modes` `/session-tree`
4. 契约：`contracts/integration-guide.md`、`error-codes.md`、`frontend-mapping.md`、`gateway-events.v1.schema.json`
5. 集成硬化：分页 `total`、配额 `GET /api/me/limits`、SSE `?types=` 过滤、可选 CORS（`GATEWAY_CORS_ORIGINS`）

## 权限模型（拍板）

网关自身**没有权限体系，只有用户标识**。权限由上级管理：
- 用户操作：上游认证后注入 `X-User-Id`；
- 全局管理：上游注入 `X-Admin-Id`（网关只验格式 + 审计 actor）；
- 前端直连 share-token（view/control）仅限单会话分享，永不触及配置/管理面。

## 仓库布局

```
gateway/          # 网关（本 README 的主体）
  src/core/       # 集成层：SDK 物化（UserContext/SessionFactory/SnapshotService/events 规范化…）
    store/        #   数据层按领域拆分（db/tenants/sessions/usage/snapshots/…），tenant-store 只做 barrel
    config/       #   models.yml ⇄ JSON、agent frontmatter ⇄ JSON、schema 自描述
    hooks/        #   事件清单 / 跨模块 bridge / 订阅缓存 / 分发合并
    session/      #   SessionCtx（SSE 缓冲/审批）与活跃会话注册表
  src/routes/     # 网关层：HTTP 语义（归属/配额/审计），永不直接持有 SDK 对象
    config/       #   用户级配置面（skills/approval/models/providers/webhooks/…）
    session/      #   会话核心面（create/crud/conversation/model/sharing/events + shared 守卫）
    session-sdk/  #   SDK 全能力桥（state/control/history/agents/approvals/jobs/capabilities/lifecycle）
    session-integration/ # 集成门面（facade/hooks/webhooks/business-events/http-tools）
    workspace/    #   文件树/文件读写 + git/worktree
    console/      #   控制台面板（panels）与写操作（actions）
  src/jobs/       # IdleCuller · TrashPurger · SnapshotPruner · Backup
  test/           # 单元 + 集成 + e2e（聊天/编码/SDK 能力/全旅程/审批/控制台/迁移）
  Dockerfile      # Bun + Node/npm + Conda 三运行时；工作区根目录挂载点 /workspace
contracts/        # 事件契约 schema + 前端映射契约 + 集成指南 + 错误码
docs/DESIGN.md    # 设计定稿（33 节；§31 结构拆分 / §32 环境迁移）
docs/SOP.md       # 运维手册（部署 / 接入 / 运维 / 迁移 / 排障）
docker-compose.yml# 工作区根目录挂载 + 限额与备份参数
```
