# OMP 多租户会话引擎网关 · 设计定稿 v3.1

> Hono + omp SDK（`@oh-my-pi/pi-coding-agent`，进程内嵌，纯 SDK 无 RPC）。
> 身份由上游（Python 业务后端）注入；网关不管用户，只做引擎。
> v3.1 = v3 + 集成规划 + 审阅修订（P0/P1 全部合入）+ SDK spike 验证结论（§14）。

## 1. 定位与四层拓扑

```
React（assistant-ui + a2ui）
   │ 同源 BFF：REST + SSE
Python 业务后端（FastAPI：用户/业务/SSE 代理/事件协议转换）
   │ 内网：X-User-Id + service-token
omp 网关（Bun + Hono + omp SDK）        ← 本文档
   └─ 进程内 AgentSession × N
```

- 网关是可信内网服务，绝不对公网暴露；前端永远不直连网关。
- Python 后端即"上游"：持有用户体系，按 user_id 注入身份。
- 分片预留：所有状态按 user_id 落盘；Python 侧维护 `user→shard` 路由表抽象（M1 单 shard 常量起步）；网关提供 `/internal/drain` 支持滚动发布排空。

**请求契约**：`X-User-Id: <^[a-zA-Z0-9_-]{1,64}$>`（必填，网关校验格式与资源归属，不校验真实性）+ `Authorization: Bearer <SERVICE_TOKEN>`（必填，恒时比较；支持双 token 重叠轮换窗口）。

## 2. 数据模型

### gateway.db（bun:sqlite）

```sql
tenants(user_id PK, status 'active'|'disabled'|'deleted', limits_json,
        created_at, updated_at, deleted_at)
-- limits: {maxSessions, maxConcurrent, allowedProviders[]}

workspaces(id PK, user_id, path, created_at)   -- 1:1: workspace_id 恒等于会话 id

sessions(id PK, user_id, workspace_id, parent_id NULL,   -- fork/restore 血缘
         title, status 'active'|'archived'|'deleted',
         session_file, model_provider, model_id, entry_count,
         created_at, updated_at, archived_at, deleted_at, last_live_at)

snapshots(id PK, session_id, kind 'auto'|'manual',
          trigger 'turns'|'interval'|'pre_model_switch'|'pre_restore'|'pre_delete'|'manual',
          name, note, entry_count, turn, model_provider, model_id,
          file_path, materialized BOOL, created_at, expires_at)

audit_log(id PK, at, actor, on_behalf_of, action, resource_type, resource_id, detail_json)
```

### 目录布局

```
data/
├── gateway.db
├── global/{mcp.json, skills/<n>/SKILL.md, extensions/*.ts}   # 全用户共享（admin 维护）
└── users/<user_id>/
    ├── agent/            # 私有 agentDir：models.yml、mcp.json、skills/、extensions/、agent.db、.env
    ├── sessions/         # omp JSONL（活跃+归档）
    ├── snapshots/<sid>/
    ├── workspaces/<wsid>/
    └── trash/
```

## 3. 隔离模型（v3.1：三方作用域）

作用域优先级 **project > user > global**（与 omp 原生优先级一致）：

| 资源 | project（会话 workspace 内） | user（私有 agentDir） | global（共享） |
|---|---|---|---|
| skill | `.omp/skills/`（原生，项目自有） | `agent/skills/`（`loadSkillsFromDir` 逐用户加载） | 同左，全局目录二次扫描 |
| MCP | `.omp/mcp.json`（项目自有，**网关不独占写**） | `agent/mcp.json` | 合并注入（见下） |
| 插件 | — | `agent/extensions/*.ts` | global/extensions 经 `additionalExtensionPaths` |
| 模型 | — | `agent/models.yml` + 私有 ModelRegistry/AuthStorage | — |

**MCP 合成规则（mcp-compose）**：会话创建/变更时三方读取，按 `project > user > global` 逐名去重后写入 workspace `.omp/mcp.json`；若检测到项目自己管理该文件（存在非网关写入标记），退化为"监听变更 + refreshMCPTools"模式，不覆盖项目内容。

**skills 加载机制（M4 修订）**：skills **不走 process 级发现**（settings holder 会让跨用户目录互相泄漏——实证），
由 session-factory 用 `loadSkillsFromDir` 按 [用户目录, 全局目录] 顺序加载（同名单冲突时 first-admitted 保留裸名 → **用户覆盖全局**），
经 `CreateAgentSessionOptions.skills` 直接注入（`providedSkills` 路径）。**变更对新会话生效，活跃会话保留原状**。

**并发与模型**（spike 已验证）：每会话私有 `new AgentRegistry()` 经 `agentRegistry` 字段注入；模型切换 `session.setModel(model)`（收 `Model` 对象，先从该用户 registry 解析），仅 idle 允许（流式中 409）；`modelRegistry.authStorage` 必须与传入的 authStorage 同实例。

## 4. 会话生命周期

```
内存态: idle ⇄ streaming（仅 active 会话进 SessionRegistry）
DB: active ⇄ archived（归档只读，写操作 409）
    DELETE ?confirm=<sid> → deleted（trash，30d）→ TrashPurger 物理删除
```

- **IdleCuller**（60s）：idle && 无 SSE 订阅 && 超 TTL → `beginDispose()+dispose()`，文件保留，下条消息按 sessionFile 重建（MCP 重连数秒）。
- **孤儿 turn 检测**：网关启动扫 JSONL，发现未闭合 turn 补发合成 `turn.aborted{reason:"gateway_restart"}` 并落盘。
- **drain 模式**：`POST /internal/drain` → 拒新会话、等活跃 turn 结束（或超时快照退出）→ 健康检查失败摘流量。
- workspace 与会话同生命周期：会话删除（trash）时 workspace 一并随行，无共享计数。
- 优雅关停：全部 beginDispose → await dispose → `postmortem.cleanup()`（@oh-my-pi/pi-utils）。

## 5. 快照与恢复（M4 已实现）

- Tier 1 持续自动保存 = JSONL 追加（omp 原生，崩溃安全）。
- Tier 2 checkpoint：**总是物化**——复制会话 JSONL 的**完整行**（丢弃截断尾行）到 `users/<uid>/snapshots/<sid>/<snapId>.jsonl`，`entry_count` 记录行数。零 turn 会话（无文件/空文件）→ 409 `SNAPSHOT_EMPTY`。
- 自动触发（turn 边界 `agent_end && isTerminal`，SessionCtx.snapshotHook fire-and-forget）：
  - `turns`：每 5 个 turn；`interval`：距上次 auto ≥15min 的下一个 turn 边界；ring 保留最近 **K=20**（Pruner 滚动删）
  - `pre_model_switch`（切模型前）、`pre_restore`（rollback 前）、`pre_delete`（进 trash 前）——失败静默不阻断主流程
  - 手动 `POST /:sid/snapshots {name?,note?}`（kind=manual，TTL **90 天**）
- API：`GET /:sid/snapshots[/:id]`（元数据+entry_count）、`POST/DELETE`、`POST /:sid/snapshots/:id/restore {mode}`：
  - **fork（默认，安全）**：`createGatewaySession({forkFrom: snapshotFile, copyWorkspaceFrom: 源workspace})` → 新 sid + `parent_id` 血缘 + 自己的 workspace
  - **rollback（破坏性，仅 idle）**：先自动 `pre_restore` 快照（可反悔）→ 快照完整行写为新会话文件（omp 命名约定）→ dispose 旧 live → `resumeSessionFile` 同 sid 重建 → DB `session_file` 更新
- SnapshotPruner（10min 周期）：auto ring 滚动（K=20）、manual/过期 TTL 删除、孤儿快照文件清理（目录扫描无 DB 行即删）。

## 6. 事件契约 gateway-events v1

网关把 omp `AgentSessionEvent` **规范化**后经 SSE 转发，下游（Python/前端）不感知 omp 内部事件名。

| 类别 | 事件 |
|---|---|
| 会话 | `session.status {status, turn?}`、`session.status_changed {from,to}` |
| 消息 | `message.started {role,messageId}`、`text.delta {messageId,delta}`、`message.completed {messageId}` |
| 工具 | `tool.started {callId,name}`、`tool.completed {callId,result}`、`tool.confirm_required {approvalId,tool,args{full,compact},timeoutSec}`（tool=请求方 kind：tool-approval/ui-confirm；真实工具名在 args.full 首部） |
| 轮次 | `turn.completed {isTerminal,usage}`、`turn.aborted {reason}` |
| 运维 | `model.changed {provider,modelId}`、`snapshot.taken {snapshotId,trigger}`、`notice {level,text}` |
| 回放 | `replay.state {…}`（重连首帧：当前 status/model/进行中 turn 摘要） |

**SSE 协议（v3.1 修订）**：
1. 每事件带递增 `id:`（会话级单调序号）。
2. 重连：客户端带 `Last-Event-ID` → 网关先推 `replay.state` 状态快照帧，再回放**消息/工具类**事件（从 JSONL/事件缓冲），ops 类不回放（以 replay.state 现值替代）→ 续实时流。
3. **先订阅后发送**：客户端必须先建 SSE（可带 Last-Event-ID）再 POST prompt；prompt 响应亦可返回起始事件游标。禁止反向顺序（会丢事件）。
4. **prompt = 准许即 202**：`POST /:sid/prompt` 在 SDK 准许（onPromptAdmitted）即返回 `{admitted:true}`，**不等 turn 结束**（turn 结果经 SSE `turn.completed`/`message.completed` 与 usage 落库观察）；admission 前的失败仍同步映射（空文本 400、无模型 409 MODEL_UNAVAILABLE 预检、流式队列 429）。审批开启时客户端必须在 202 后于 `timeoutSec` 窗口内决策 `tool.confirm_required`。
4. 订阅者写背压超时断开；多客户端可同订阅（只读镜像）；以 `turn.completed{isTerminal:true}` 为轮次完成信号。

## 7. API 全量

```
# 会话（上游转发：X-User-Id + svc-token）
GET    /api/sessions?status=&page=&per_page=   POST /api/sessions {title?,model?,tools?,thinkingLevel?,enableMcp?,enableLsp?,appendSystemPrompt?,additionalDirectories?}
GET    /api/sessions/:sid                    PATCH（title / archived⇄active）
DELETE /api/sessions/:sid?confirm=<sid>          # 1:1：workspace 随会话进 trash
GET    /api/sessions/:sid/events             # SSE（gateway-events v1）
GET    /api/sessions/:sid/messages           # 历史消息（JSONL → 规范消息结构）
POST   /api/sessions/:sid/prompt {text,images?,streamingBehavior?} | steer | abort | compact
POST   /api/sessions/:sid/model {provider,modelId}   GET .../models
GET    /api/sessions/:sid/tree · GET .../files?path= # 只读，限 workspace 内

# 快照
GET/POST/DELETE /api/sessions/:sid/snapshots[/:id]
POST   /api/sessions/:sid/snapshots/:id/restore {mode:"fork"|"rollback"}   # fork=新 sid+workspace 拷贝；rollback=同 sid 换文件（仅 idle）

# 用户资源与全局管理（完整清单以 /openapi.json 为权威）
GET/PUT /api/me/models/config · POST /api/me/models/credentials · POST /api/me/models/test · GET /api/me/projects
GET/PUT /api/me/mcp · GET/PUT/DELETE /api/me/skills/:name · GET/PUT/DELETE /api/me/plugins/:name
GET/POST /admin/global/{mcp,skills,plugins,agents}（X-Admin-Id 标识，DESIGN §18）

# 内部契约（仅上游）
POST   /internal/users/:uid/provision · GET /internal/users/:uid/summary
PATCH  /internal/users/:uid/limits · DELETE /internal/users/:uid?confirm=<uid>（级联清理，合规必需）
GET    /internal/users/:uid/{usage,webhooks} · POST /internal/users/:uid/webhooks · DELETE /internal/webhooks/:id
GET    /internal/trash · POST /internal/trash/sessions/:sid/restore · POST /internal/trash/users/:uid/restore
POST   /internal/drain

# 运维
GET /healthz · /readyz · /metrics · /openapi.json
```

通用：错误体 `{error:{code,message,details}}`；`Idempotency-Key`（建会话/建快照幂等，24h 窗口）；分页 `page/per_page`；`X-Request-Id` 全链路透传；全变更进 audit_log（actor=upstream 或 X-Admin-Id, on_behalf_of）。
**API 权威来源**：`GET /openapi.json`（路由内省生成，83 路径/97 操作）；本节为概要。

## 8. 运行时组件

```
src/
├── index.ts               # Hono app + Bun.serve + 优雅关停
├── config.ts              # DATA_ROOT/SERVICE_TOKENS/PORT/TTL/K/默认 limits
├── middleware/auth.ts     # svc-token + X-User-Id → c.set("userId")
├── core/
│   ├── paths.ts           # 目录布局 + ensureUserScaffold
│   ├── tenant-store.ts    # tenants/sessions 表（bun:sqlite）
│   ├── user-context.ts    # 每 user_id SDK 对象缓存（agentDir/Settings/AuthStorage/ModelRegistry + reload）
│   ├── session-registry.ts# 活跃表/订阅者/限额/IdleCuller/全局 streaming 上限
│   ├── session-factory.ts # ★ createAgentSession 参数组装（隔离落点）
│   ├── snapshot-service.ts# 物化/forkFrom/rollback/Pruner
│   ├── mcp-compose.ts     # 三方合并 project>user>global
│   ├── agent-compose.ts    # 全局 agents 合成进 workspace .omp/agents（manifest 记账）
│   └── events.ts          # gateway-events v1 规范化
├── routes/{sessions,snapshots,models,extensions,internal,ops}.ts
├── jobs/{idle-culler,trash-purger,snapshot-pruner}.ts
└── ext/audit.ts           # 网关内置 extension 文件（走 additionalExtensionPaths）
```

限额执行：tenants.limits（maxSessions/maxConcurrent/allowedProviders）+ 全局 streaming 并发上限（超限排队）。成本归集：`turn.completed{usage}` 供 Python 记账，网关不算钱。

### 依赖策略（组合根 + 细粒度切面）

omp 是 monorepo，锁步发版。网关依赖策略：

| 包 | 用途 | 方式 |
|---|---|---|
| `@oh-my-pi/pi-coding-agent` | **唯一运行时组合根**：createAgentSession/SessionManager/Settings/ModelRegistry/AgentRegistry/discoverAuthStorage | 运行时 |
| `@oh-my-pi/pi-catalog` | `Model` 类型（根未 re-export）、Provider 描述符 | 类型 |
| `@oh-my-pi/pi-ai` | `AuthStorage` 源头类型 | 类型 |
| `@oh-my-pi/pi-agent-core` | `AgentEvent` 运行时事件类型 | 类型 |
| `@oh-my-pi/pi-utils` | postmortem/dirs/env 工具 | 运行时 |
| 其余（tui/natives/wire/stats/mnemopi/snapcompact/bench） | 非网关切面 | 不直接依赖（经组合根传递） |

**版本纪律**：所有 `@oh-my-pi/*` pin 同一版本（当前 18.20.2）、一起升级——类型来自 A 包、对象来自组合根，版本错位会导致类型/运行时不一致。类型层直依赖的价值已实证：tsc 抓出了文档猜测的全部字段错误（见 §14）。

## 9. 分层铁律

- 网关层（routes/）：HTTP 语义、归属检查（资源 user_id === header user_id，失配 404 防枚举）、限额、审计。**永不直接持有 SDK 对象**。
- 集成层（core/）：SDK 对象物化与生命周期，纯库可单测，不做认证判断。
- Python：身份/业务/协议转换；网关事件 → 前端协议的转换器是纯函数并做契约测试。

## 10. 安全

公网不可达；svc-token 恒时比较 + 双 token 轮换窗口；对外入口剥离 X-User-Id；归属失配 404；trash/global 永不进任何会话的 additionalDirectories 白名单；凭据只进每用户 agent.db/models.yml，不进 process.env 与日志；导出 zip 剥离 apiKey + 一次性链接；上游删用户必须回调 DELETE /internal/users/:uid（合规契约）；全局插件 = 全员共享代码，admin 写入 + 供应链 review；加固选项 `restrictToolNames + toolNames` 白名单、逐会话 enableMCP/enableLsp。

## 11. 里程碑

| 阶段 | 内容 | Demo |
|---|---|---|
| M0 | ✅ 契约冻结（gateway-events v1 schema + /openapi.json） | 假事件流跑通前端 |
| M1 | ✅ auth/懒 provision/单会话 prompt+SSE/规范化层/drain 骨架 | 两用户各自流式聊天 |
| M2 | ✅ UserContext 缓存/私有 AgentRegistry 并发/限额/全局 streaming 上限（排队）/用量统计/workspace 管理/pi-web 对标批次一 | 一用户多会话并发 |
| M3 | ✅ 归档/软删/trash+Purger/IdleCuller/resume/孤儿 turn(restore-interrupted)/重连协议/历史消息/jobs 端点/trash 找回 | 生命周期全链路 |
| M4 | ✅ 快照（总是物化）/forkFrom+fork{entryId} 恢复/rollback/Pruner/文件浏览 | 快照时间线 + fork |
| M5 | ✅ mcp-compose 三方合并/customDirectories(注入式)/扩展管理 API/credentials/setModel/test | 用户装自己的 MCP/skill |
| M6 | ✅ 审批流（用户级 tools.approvalMode + initializeExtensions UI 桥 + confirm_required SSE + approvals REST；真实模型双路径 e2e）——详见 §19 | 审批闭环 |
| M7 | ✅ 审批策略细化：`GET/PUT /api/me/approval {mode,policies}`（cfgToolsApproval 落盘）/ grants 读写（approval-cache.db）/ 审计 requested+timeout（§20） | 策略矩阵 |
| M8 | ✅ revive 实现（persistedReviverFactory 装配）/ chat 自动复活 / kill detach+tombstone / `POST /:sid/mcp/reload`（§20） | Agent Hub 全控 |
| M9 | ✅ 集成契约交付：`tool.started` 增补 args（v1.1）+ 事件→assistant-ui/a2ui 映射契约（contracts/frontend-mapping.md）+ SSE 重连语义；客户端与 UI 实现归集成方（网关不产出客户端代码） | 端到端产品 |
| M10 | ✅ sqlite 定时备份（VACUUM INTO+轮换）/ GATEWAY_OTEL / webhook 白名单（注册期 403+投递期双保险）；粘性扩展与凭据治理为部署/运维面（§20 留档） | 上线就绪 |
| M11 | ✅ 网页控制台数据面：命令面板/模型目录/todo/context/modes/中断/队列/标题/分叉树 + 事件 v1.2（§21） | 网页即 TUI |
| M12 | ✅ 多语言集成门面：会话级提示词注入 / bootstrap/status / 事件 JSON 回放 / 会话级回调 + 同步等待（§22） | 集成端即用 |

## 12. 契约冻结与 M3 生命周期（已实现）

**契约**：`GET /openapi.json` —— 从根路由表内省生成的 OpenAPI 3.1 骨架（paths/methods/路径参数 `:x`→`{x}`/security/`x-gateway-events` 事件清单 + 重连协议）；`contracts/gateway-events.v1.schema.json` —— SSE 事件信封 JSON Schema（2020-12，含逐事件负载与协议语义），Python/前端以此做契约测试。

**异步任务端点**（bash 后台/task 子代理）：`GET /:sid/jobs`（tree+snapshot）、`GET /:sid/jobs/:jobId`（inspect：命令/pid/退出/输出）、`POST /:sid/jobs/:jobId/cancel`。

**孤儿 turn 恢复**：`POST /:sid/restore-interrupted` → `AgentSession.restoreInterruptedTurn()`（SDK 原生：未闭合工具调用配"结果未知"、中断 turn 按 /retry 重放）——仅 idle，替代手写扫描。

**TrashPurger**（`jobs/trash-purger.ts`，10min 周期 + `purgeOnce(dataRoot)` 可注入）：
- 会话：`status=deleted` 且 `deleted_at` 超 `GATEWAY_TRASH_TTL_DAYS`（默认 30 天）→ 物理删 JSONL + workspace 目录 + 快照目录 + 清 sessions/snapshots/usage 行。
- 租户：`status=deleted` 同期超时 → `rm -rf users/<uid>` + 清该用户全部行（tenants 行保留为审计墓碑）。
- 测试直接对服务器数据根执行 purgeOnce 验证文件与行消失。

## 13. 风险登记


双跳 SSE 缓冲（Python 逐 chunk + 心跳）；omp 事件 schema 漂移（规范化层 + 契约测试）；断线语义（断开=解绑订阅，停止=显式 abort，重连=Last-Event-ID+replay.state）；a2ui 形态待 M6 spike；Windows dev natives；单进程共享命运（分片预留 + drain）；sqlite 备份（backup API 定时；workspace 备份非网关职责）。

**新增已知风险（审阅 2026-11-15）**：
- webhook URL SSRF：网关向任意 http(s) URL POST——内网部署 + URL 由可信上游注册（v1 接受；如需收紧加目标白名单）。
- prompt body 无显式大小上限（Bun 默认 128MB）——图片经 base64 校验，建议 Python 侧限流。
- rollback 会话文件命名（`<stamp>_<uuid>.jsonl`）与 omp 原生格式略有差异——open/list 语义不受影响。
- **models.yml 必须显式声明 `models:`**：provider 段不声明时模型从内置目录解析，MiniMax 的 API 映射会失败（stopReason:error）——已写入管理 API 契约。
- ~~子代理 revive 需 task reviver factory（公共面未导出）~~ **已解除（2026-11-15 复核）**：`task/persisted-revive` 与 `registry/agent-lifecycle` 均经 exports map 公开，`AgentLifecycleManager.setPersistedSubagentReviverFactory` + `ensureLive/release` 可直接装配（§20 M8）。

## 14. SDK spike 结论（2026-11-15，pi-coding-agent@18.20.2 d.ts 实测）

**M1 完成状态（2026-11-15 夜，§14）**：51 tests / 0 fail / 162 assertions / tsc 0 error。
- **单元（35）**：事件映射矩阵（真实形状）、mcp-compose 三方合成（覆盖/自管/幂等）、SessionCtx（流式状态机/环形缓冲/重放/订阅者剔除/usage 充盈/model_changed 补齐）、tenant-store（限额合并/状态机/血缘/审计）、auth（双 token/uid 字符集）。
- **集成（13，spawn 真实服务）**：health/ready/metrics、401 矩阵、X-Request-Id 回显、建会话目录骨架、无模型降级（400/409/202）、跨租户 404+SSE error、SSE replay.state+Last-Event-ID、同用户双会话并发、归档/复活/删除、internal（provision/summary/limits 409/allowlist 403/级联删除按用户收敛）、drain 503、audit 落库。
- **e2e（3，真实 MiniMax）**：prompt→text.delta 流式→message.completed(provider/model/usage)→turn.completed(usage 充盈)；setModel→model.changed 补齐+404；同用户两会话并发独立完成。
- **测试抓出并修复**：touchSession SQL 缺 `= ?`；steer idle 不同步校验模型（202 入队异步失败，已按真实语义固化进测试）；`Bun.file().exists()` 对目录返回 false。

| 假设 | 结论 |
|---|---|
| `createAgentSession({ agentDir })` | ✅ `agentDir?: string`（"Global config directory. Default: ~/.omp/agent"） |
| 私有注册表 | ✅ 字段名 **`agentRegistry?: AgentRegistryApi`**（非 registry）；`new AgentRegistry()` |
| 会话内切模型 | ✅ `AgentSession.setModel(model: Model, role?, options?)`——收 **Model 对象**，先经用户 registry 解析 |
| 用户级 models.yml | ✅ `new ModelRegistry(authStorage, modelsPath?)`（另有 `ModelRegistry.create` 推荐用于启动路径） |
| 会话管理 | ✅ `SessionManager.create(cwd, sessionDir?)` / `open` / `list` / `inMemory` / **`forkFrom(sourcePath, cwd, sessionDir?)`**（快照恢复直接用） |
| 全局 skill 注入 | ✅ `Settings.init({ cwd, agentDir, overrides })`，`overrides["skills.customDirectories"]`（设置 id 已确认存在） |
| 会话 API | ✅ `subscribe(listener)→unsubscribe`、`prompt(text,opts)`、`steer`、`followUp`、`abort(opts)`、`beginDispose()`、`dispose(opts)` |
| 模型列表 | ✅ `modelRegistry.getAvailable(kind?)` |

仍待实现时验证：compaction 是否纯追加（M4 前置）；`.omp/mcp.json` 项目自管时的 watch 行为；Windows 开发环境下 natives 构建（部署目标 Linux）；**authStorage 是否完全随 agentDir 隔离**（M1 冒烟中 MODEL_UNAVAILABLE 的提示文案引用了进程级 `~/.omp\agent\agent.db`——可能是固定文案，也可能 discoverAuthStorage 未完全生效，需用真实凭据复验）。

**AgentSessionEvent 真实形状**（tsc 实证，与文档猜测的差异）：
- `message_update.text_delta`：`{contentIndex, delta, partial: AssistantMessage}`——messageId 取自 `partial.id`；
- `tool_execution_start/end`：`toolCallId`/`toolName`/`args`/`result`（非 callId/name）；
- `model_changed`：**无负载**（`{type}` 而已），新模型需从 `session.model` 补读；
- `notice`：字段为 `message`（非 text）；
- `agent_end`：无顶层 `usage`（在 `telemetry` 里）。

### 流式并发闸门（StreamingGate，M2，已实现）

- **双上限**：全局 streaming 槽位（`GATEWAY_MAX_GLOBAL_STREAMING`，防单点 OOM）+ 每用户 streaming 槽位（tenants `maxConcurrent`，provider 注入热更新）。
- **超限排队而非拒绝**：FIFO 等待队列；为防队头饿死，在能同时满足双上限的等待者中按序取第一个。排队超时（`GATEWAY_STREAM_QUEUE_TIMEOUT_MS`，默认 60s）→ 429 `STREAM_QUEUE_TIMEOUT` + `Retry-After`，上游退避重试（配 Idempotency-Key 幂等）。
- **槽位语义** = 一个正在流式的会话。prompt/steer 在 idle 会话开新 turn 前持槽；终态 `agent_end`（SessionCtx.onTerminal 一次性触发）/ 会话 dispose（markDisposed）/ 最大持有（`GATEWAY_STREAM_MAX_HOLD_MS` 防泄漏 backstop）任一释放。会话已在流式中的 steer/followUp 排队进 omp，不新增并发 turn、不占槽。
- **指标**：`omp_gateway_stream_slots_held`、`omp_gateway_stream_queue_waiting`。
- **e2e 实证**：maxGlobal=1 下两会话并发 prompt，流式窗口实测不重叠（真实模型排队串行）。
- **SSE 保活修正**：Bun.serve 默认 10s idleTimeout 会掐断长静默 SSE（长工具执行期）——已设 `idleTimeout: 255` + keep-alive 缩至 10s。

## 15. SDK 全能力桥（M2.5，已实现）——Python 完整驱动网关

原则：**AgentSession 的编程面逐一映射为 `/api/sessions/:sid/*`**，Python 不感知 omp。全部经归属守卫 + 流式闸门；事件侧补 `thinking.changed`。

| SDK 能力 | 端点 | 说明 |
|---|---|---|
| `getQueuedMessages/queuedMessageCount/getContextUsage/...` | `GET /:sid/state` | 一次拿全：model/thinkingLevel/available/queue/tools/contextUsage/messageCount |
| `get messages` | `GET /:sid/messages?since=` | AgentMessage 原始结构（role/content/usage/stopReason） |
| `get/setActiveToolsByName/getAllToolNames` | `GET/PUT /:sid/tools` | 运行时工具集变更（系统提示同步重建） |
| `thinkingLevel/getAvailableThinkingLevels/setThinkingLevel` | `GET/PUT /:sid/thinking` | `{level, persist?}`；事件 `thinking.changed` |
| `compact(instructions?)` | `POST /:sid/compact` | 仅 idle；持流式槽 |
| `followUp(text)` | `POST /:sid/follow-up` | 显式排队消息 |
| `sendCustomMessage(payload,{deliverAs,triggerTurn})` | `POST /:sid/messages/custom` | 扩展协议通道（payload 为字符串或 `{customType,content,...}`） |
| `SessionManager.forkFrom` | `POST /:sid/fork` | 新会话 + `parent_id` 血缘 + **自己的 workspace（源 workspace 完整拷贝）**；空会话（无 JSONL）降级为新建+血缘 |
| `setModel(model, role)` | `POST /:sid/model`（已支持 `role`） | 角色回退链切换 |
| `cycleModel(direction)` / `cycleThinkingLevel()` | `POST /:sid/cycle-model` · `/:sid/cycle-thinking` | Ctrl+P / thinking 循环的 HTTP 形态 |
| `getSessionStats()` | `GET /:sid/stats` | 消息/工具计数 + tokens 全量 + cost/credits |
| `resetSessionContext()` | `POST /:sid/reset` | /new 语义：清空上下文，文件保留；仅 idle |
| `handoff(instructions?)` | `POST /:sid/handoff` | 总结移交；仅 idle + 持槽 |
| `removeQueuedMessage(text, queue)` | `POST /:sid/queue/remove` | 撤回排队消息（steering\|followUp） |
| `setSessionName(name)` | `POST /:sid/name` | SDK 层命名（独立于网关 title） |
| `prompt/steer/followUp 的 images` | 三端点 `body.images` | `{data: base64, mimeType}[]` 校验后透传 |
| `discoverSkills(cwd, agentDir, settings)` | `GET /:sid/skills` | 该会话可见的 skills |
| `result.mcpManager` | `GET /:sid/mcp` | connectedServers + 工具名列表 |
| `result.lspServers` | `GET /:sid/lsp` | LSP 启动信息 |
| 创建选项 | `POST /api/sessions` body | `tools`(allowlist)、`thinkingLevel`、`enableMcp/enableLsp`、`appendSystemPrompt`、`additionalDirectories`（用户根守卫） |
| `fork(entryId)` / `branch(entryId)` | `POST /:sid/fork {entryId?}` · `POST /:sid/branch {entryId}` | **原地分支**：SDK 切到新文件，网关 live 换绑到新 sid（旧 sid 保留原文件可复活），branch 额外返回编辑器草稿（pi-web "Edit from here"） |
| `exportToHtml` | `POST /:sid/export` | workspace `exports/` 落盘，返回相对路径+bytes |
| `formatSessionAsText` | `GET /:sid/dump` | 文本转写 |
| `freshSession()` | `POST /:sid/fresh` | provider 流重置（保对话；与 reset 互补），仅 idle |
| `discoverSkills`（用户面） | `GET /api/me/skills` | 该用户可见 skills |
| 插件清单 | `GET /api/me/plugins` | agent/extensions 文件清单 |
| 文件扁平索引（pi-web file-index） | `GET /:sid/files/index?q=` | 30s 缓存 + 写操作失效；前缀>子串>子序列打分 |
| raw 预览流 | `GET /:sid/file/raw?path=` | content-type 映射 + Range(206)，≤25MB；图像/PDF/音视频直接预览 |
| multipart 上传 | `POST /:sid/files/upload?path=` | FormData `files[n]`；basename 净化防穿越 |
| git worktree | `GET/POST/DELETE /:sid/git/worktrees` | list(--porcelain)/add(-b)/remove；路径限用户根 |
| 会话列表增强 | `GET /api/sessions` | 内联 `usage` 汇总、`contextPercent`、`lastMessage` 预览（JSONL 尾读）、`live` |
| 用户 mcp.json | `GET/PUT /api/me/mcp` | 写后 reload UserContext |

### 16.1 分享链接 / Agent Hub / webhooks（批次二，已实现）

**分享链接（collab"链接即权限"语义落地）**：
- `POST /:sid/share-link {access: view|control, ttlSeconds?}` → `gwshare_<base64url>`（sha256 入库，明文仅返回一次）；`GET /:sid/share-links`；`DELETE /:sid/share-link/:id`。
- 认证回落：svc-token 失败时接受 `X-Share-Token` → 解析为 `userId + shareAccess + shareSid`（绑定单会话）。
- 守卫：view 仅 GET/HEAD；control 额外放行对话写端点（prompt/steer/abort/follow-up/messages-custom）；绑定会话之外 404；`/internal` 面一律 403（requireFullAuth）；列表等无 sid 路径 403。

**Agent Hub API**：
- `GET /:sid/agents`（名册，排除主代理；来源 `AgentRegistry.list()`）、`GET /:sid/agents/:aid`、`GET /:sid/agents/:aid/transcript`（AgentRef.sessionFile 限用户根内，≤4MB）。
- `POST /:sid/agents/:aid/chat` → `AgentSessionHandle.prompt`（流式中自动转 steer；仅 live 子代理，parked/killed 409 AGENT_NOT_LIVE）；`POST /:sid/agents/:aid/kill` → `handle.abort()` + 名册标记 `aborted`（完整 release/park 语义随 task API）；`POST /:sid/agents/:aid/revive` → **501**（需 cold-reviver factory）。
- 事件：`agentRegistry.onChange` → SSE `agents.changed`（名册快照）。

**trash 找回（内部契约，M3）**：`GET /internal/trash`（已删会话+已删用户清单）、`POST /internal/trash/sessions/:sid/restore`（恢复 active + 清 `deleted_at`）、`POST /internal/trash/users/:uid/restore`（tenant 恢复 + 重建目录骨架）；purger 已物理清除后返回 404。

**webhooks（pi-web push 对标）**：
- 表 + `core/webhooks.ts` 分发器：`SessionCtx.publish` → 匹配用户钩子（events 含 `*` 或事件 type）→ POST JSON `{sessionId, event}` + `x-omp-signature: HMAC-SHA256(secret, body)`；5s 超时不重试；钩子缓存 10s。
- `POST /internal/users/:uid/webhooks {url, events?, secret?}`（secret 缺省生成，仅返回一次）、`GET` 列表（脱敏）、`DELETE /internal/webhooks/:id`。
- 集成测试含真实接收器：投递 + 签名验证 + 注销后停发。

**模型探针 / 项目聚合 / diff 细化**：
- `POST /api/me/models/test {provider, modelId, prompt?}`：独立内存会话发探针 → `{ok, ttftMs, durationMs, error?}`（不落会话）。
- `GET /api/me/projects`：workspace 的 `.git/config` origin 派生仓库键（5min 缓存），聚合 active+archived 会话。
- `GET /:sid/git/diff?stat=1&base=<ref>`：`--stat` 摘要与任意 base（ref 表达式校验 + flag 注入拒绝）。
| 用户 models.yml | `GET/PUT /api/me/models/config` | 文件为权威（模式 A）；对新会话生效 |
| 凭据注入 | `POST /api/me/models/credentials` | 合并 apiKey 进 provider 段 → reload |

**配置变更语义**：`reloadUserContext` 重建该用户 Settings/AuthStorage/ModelRegistry；**新会话立即生效，活跃会话保留原 registry 直至复活**（逐会话切模型走 `/:sid/model`）。
**e2e 实证（Python 视角全流程）**：`PUT models/config` → `POST credentials` → 建会话绑定 MiniMax → prompt 流式 → state/thinking( low)/messages → fork 继承全部历史。

## 16. 用量/Token 统计（M2，已实现）

- **采集**：SessionCtx 在 `turn_end` 备忘 usage（input/output/cacheRead/cacheWrite/totalTokens/cost.total/duration/ttft/provider/model），终态 `agent_end` 时经 usageSink 落库 `usage` 表（sqlite，索引 user+at / session），同时充盈 SSE `turn.completed{usage}`。
- **API**：
  - `GET /api/sessions/:sid/usage` — 会话汇总 + 最近 50 turn 明细
  - `GET /api/me/usage?group=day|model|session&from=&to=` — 用户聚合（LiteLLM/Open WebUI 口径：分桶 + totals）
  - `GET /internal/users/:uid/usage?group=` — 上游计费/展示
  - `/metrics` — `omp_gateway_usage_{turns,input_tokens,output_tokens,cost_usd}_total`
- 口径：每个 agent_end 记一行（含非终态分段）；成本按模型目录价计算（omp 内置），网关不算账只记数。

## 17. Workspace 管理（M2，已实现）

VS Code 式文件管理 + git 基础，挂在 `/api/sessions/:sid/*`，作用于会话 workspace（与 live 进程态无关，dispose 后文件仍在）。**归档会话只读**（写操作 409）；deleted 一律 404。

- **路径守卫**（files.ts resolveInside）：词法逃逸（../、绝对路径）+ null 字节 + **realpath 符号链接逃逸**三重防护；workspace 根不存在时降级词法校验（首写场景）；workspace 根本身不可删。
- **文件 API**：`GET /tree?path=&depth=&max=&all=1`（BFS、dirs-first、跳过 .git/node_modules、深度≤8/条目≤10k 双上限）、`GET /file?path=`（2MB 上限、二进制自动 base64）、`PUT /file?path=`（utf8|base64，5MB）、`POST /file/mkdir`、`POST /file/rename`、`DELETE /file?path=`。
- **git API**（子进程参数数组、无 shell 拼接、15s 超时、2MB 截断）：`GET /git/status`（porcelain `-uall`，空仓库分支解析）、`GET /git/log?limit=`（短 hash）、`GET /git/diff?path=&staged=1`、`GET /git/branches`、`POST /git/commit {message, add:[paths]|"all"}`。非仓库 → 409 NOT_A_GIT_REPO；超时 → 504。


## 18. 管理权限模型与 API（已实现）

**权限模型（拍板）**：网关自身**没有权限体系，只有用户标识**。权限由上级（上游系统）管理：
- 用户级管理：`/api/me/skills|plugins|mcp` 等——上游代用户调用（svc-token + X-User-Id），网关只做归属与净化。
- 全局级管理：`/admin/global/{mcp,skills,plugins,agents}`——上游注入 **`X-Admin-Id` 标识**（内网 svc-token 通道内可信），网关校验"标识存在且格式合法"，**actor 记入审计**（谁在管理由上游负责）。无独立 admin token 体系。
- 分享令牌（view/control）天然无管理权（requireFullAuth 拒绝 me/admin 面）。

**管理 API**：
- skills：`GET /me/skills`（双作用域清单，scope 标签）、`GET/PUT/DELETE /me/skills/:name`；全局侧 `/admin/global/skills[/:name]` 同形。
- plugins：`GET /me/plugins`（双作用域）、`PUT/DELETE /me/plugins/:name`（.ts/.js 源码，≤2MB）；全局侧同形。
- mcp：`GET/PUT /me/mcp`（用户 mcp.json）；全局侧 `GET/PUT /admin/global/mcp`。
- agents：`GET /api/me/agents`（双作用域清单，scope 标签；用户 agentDir/agents + 全局 global/agents）；全局侧 `GET/PUT/DELETE /admin/global/agents/:name`（与用户级同构的双通道校验，config-codec agents 白名单）。全局定义经 **agent-compose**（core/agent-compose.ts）在会话创建时合成进 workspace `.omp/agents/`（manifest `.gateway-composed.json` 记账：fork 重算刷新/清理；目录含非网关 .md 视为自管不碰；用户 agentDir 同名跳过合成 = 借 project>user 优先级实现用户覆盖全局）。对新会话生效。
- 命名净化：skill `^[a-z0-9][a-z0-9-]{0,63}$`、plugin `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(ts|js)$`（400 INVALID_NAME）。
- **变更生效语义**：skill/extension/MCP 均在**会话创建时加载**——变更对新会话生效，活跃会话保留原状（契约写明）。
- 实测：管理 CRUD × 两级 × 跨用户可见性 × 同名用户覆盖全局 × admin 鉴权（缺失/错误 403）× 新会话加载/删除消失（integration-scoping.test.ts，11 用例，含全局 agent 合成/覆盖/清理，SDK discoverAgents 验证）+ agent-compose 单元 5 用例。

## 19. 审批流（M6，已实现）

**正道模型（对照 omp `docs/approval-mode.md`）**：审批 = 用户级设置 + UI 通道桥，不做 tool_call 扩展拦截。

- **开关（用户级）**：`GET/PUT /api/me/approval` `{enabled:boolean}`。开启时经 `settings.writeValue(cfgToolsApprovalMode, "always-ask", "global")` 持久化到**该用户 agentDir 的 config.yml**（实测确认："global" 层锚定 Settings 实例自身的 `#agentDir`，settings.ts:814——多租户无交叉写入）；关闭时 `unsetGlobalValue` 恢复默认 yolo。`always-ask` 语义：read 自动放行，write/exec 全部弹审批（MCP 工具按 write 档）。
- **会话装配（session-factory）**：`approvalEnabled = cfgToolsApprovalMode.get(uctx.settings) === "always-ask"`；`hasUI: approvalEnabled`（SDK 契约：无 UI 的 prompt 一律拒绝——文档明确）；`bindProcessState: false`（多租户硬约束，见 §14 修订）。
- **UI 桥（两层）**：①`result.setToolUIContext(ui, approvalEnabled)` 喂 ToolContextStore（工具上下文的 ctx.ui/hasUI，如 ask 工具闸）；②`initializeExtensions(session, {mode:"print", uiContext})`（官方嵌入参照 rpc-mode.ts:1758，路径 `@oh-my-pi/pi-coding-agent/modes/runtime-init`）——**关键：工具审批门读 runner.hasUI()/getUIContext()（wrapper.ts:443/458，#uiContext !== noOpUIContext），headless 下 createAgentSession 不初始化 runner，不调 initializeExtensions 审批门恒拒绝（"requires approval but no interactive UI available"）**；这同时让扩展 session_start 正常触发。桥实现：`approve(prompt) → "once"|"deny"`（走 ctx.requestApproval）；`confirm` 同路（kind=ui-confirm）；`select/input → undefined`、`notify` no-op（缺方法会 TypeError，SDK 契约要求宿主提供）。
- **网关侧流转**：`ctx.requestApproval(tool, args, timeoutMs=120s)` → SSE `tool.confirm_required`（approvalId/tool/args/timeoutSec）→ `POST /api/sessions/:sid/approvals/:approvalId` `{approve:boolean, reason?}` → 超时自动拒绝（unref 定时器）。`GET .../approvals` 列 pending；重复决定 404。扩展字段 `tools.approval.<tool>: allow|deny|prompt`（文档 §User overrides）留作后续按工具策略。
- **已知边界**：开关变更对**新会话**生效（approvalMode 在 createAgentSession 时读取一次）；真实模型 e2e（e2e-approval.test.ts）覆盖放行/拒绝双路径。

### 19.1 API 核对结论（2026-11-15，d.ts + docs 全量对照）

23 项 SDK API 用法逐一对过类型定义与本地文档快照，全部一致；核对中发现并修复 3 处：

1. **`bindProcessState` 缺省为 true**（sdk.ts:1999）——顶层会话持有进程级 setting effects + discovery provider toggles（dispose 交还上一个持有者），多用户并发时跨用户漂移。修复：网关所有 createAgentSession（含 model-test 探针）传 `false`。
2. **ModelRegistry 少传 `options.settings`**——模型可用性/上下文窗口策略未接用户 settings。修复：构造时传入（与 SDK 默认路径一致）。
3. **UI 桥只有 approve**——补 confirm/select/input/notify 存根（见上）。

5. **POST /:sid/prompt 语义修正（准许即 202）**——session.prompt() 的 Promise 在整个 turn 结束才 settle，旧实现等它导致 HTTP 请求悬挂整 turn；审批开启时客户端拿不到 202、永远来不及在 120s 审批窗内决策（e2e 实测根因：pending 在决策时已被超时清空）。修复：Promise.race([onPromptAdmitted 信号, turn])——admission 即返 202，turn 后台继续（流式槽位由 terminal 事件释放）；admission 前失败（409 MODEL_UNAVAILABLE 等）仍走 catch 映射；后台 turn 失败经 SSE 观察（附 catch 防 unhandledRejection）。

4. **extension runner 从未初始化（审批 e2e 失败根因）**——headless createAgentSession 不调 runner.initialize，工具审批门 `runner.hasUI()`（= `#uiContext !== noOpUIContext`）恒 false，`always-ask` 下 bash 直接 "requires approval but no interactive UI available"。修复：会话创建后调 `initializeExtensions`（rpc-mode 同款）注入 UI 上下文；附带让扩展 session_start 在网关会话里真正触发。

另：writeSkill 的 description 改 JSON 双引号标量（裸 YAML 标量遇 `": "` / `" #"` 解析碎裂），listSkillsIn 读取时剥引号。

## 20. 后续功能设计（2026-11-15 定稿；M6 已闭环，169/169）

> 依据：SDK 18.20.2 d.ts 实测 + 文档快照。排序原则：纯网关可独立交付的先做（M7/M8），
> 需要联调的归拢到 M9，生产化收尾 M10。

### M7 审批与工具策略细化（✅ 已实现）

**目标**：把 M6 的"一刀切 always-ask"细化为文档化的三层策略模型（approval-mode.md §User overrides）。

1. **用户级策略面**：`GET/PUT /api/me/approval` 扩展为
   `{enabled, mode, policies}`——`mode ∈ always-ask | always-ask-cached | write | yolo`
   （默认 yolo；`enabled:true` 等价 `mode:"always-ask"`，向后兼容）；
   `policies: {"bash":"prompt","read":"allow","mcp__<server>_<tool>":"deny"}`（键=工具名或
   `mcp__<sanitized_server>_<sanitized_tool>`，值 allow|deny|prompt）。
   落盘：`settings.writeValue(cfgToolsApprovalMode, mode, "global")` +
   `settings.writeValue(cfgToolsApproval, policies, "global")`（SDK 原生 settings，语义与
   CLI `/settings` 完全一致；policies 不能绕过工具自身 deny/prompt policy 与安全门）。
2. **Grants 管理（always-ask-cached 的记忆清理）**：
   `GET /api/me/approval/grants`（读 `<agentDir>/approval-cache.db` grants 表——文档明确
   "deleting rows or the file works too"，直接 sqlite 读为官方认可路径）；
   `DELETE /api/me/approval/grants`（= `/forget-approvals`：清库 + 各会话内存 grants）。
   会话内存 grants 从 `ExtensionRunner.#sessionApprovals` 读不到（私有）——v1 只管持久层，
   会话级 grants 随会话 dispose 自然消失（契约注明）。
3. **审批审计补全**：`approval.requested`（SSE publish 时）与超时自动拒绝均落 audit_log
   （现仅 `approval.decide`）；审计行带 `{sessionId, toolKind, decidedBy: user|timeout, ms}`。
4. **不做会话级 mode/policy**：SDK 无 per-session approvalMode 选项（settings 是唯一通道，
   per-session settings 实例会重蹈 overrides 全局污染）——契约保持"用户级，变更对新会话生效"。

**验收**：policies 生效矩阵（allow/deny/prompt × read/write/exec 工具）、grants 清理后
重新询问、审计三事件齐、全量回归。

### M8 资源热更新与子代理控制（✅ 已实现）

1. **Agent Hub 收尾（revive 501 → 实现）**：SDK 公共面已齐——
   `new AgentLifecycleManager(registry)`（绑定会话私有 registry；注意 executor 收尾绑定
   `AgentRegistry.global()`，私有 registry 下 adoption 由我们接管）+
   `createPersistedSubagentReviverFactory({session, authStorage, modelRegistry, settings,
   enableLsp, eventBus, subagentEventBus})`（factory 需要的全部上下文 createGatewaySession
   都持有；imports 路径 `@oh-my-pi/pi-coding-agent/task/persisted-revive` 与
   `.../registry/agent-lifecycle`，exports map `./task/*`、`./registry/*` 已公开）+
   `setPersistedSubagentReviverFactory(factory, idleTtlMs)`。
   - `POST /:sid/agents/:aid/revive` → `lifecycle.ensureLive(id)`（parked/killed 均可复活，
     transcript 在盘；killed 复活=新 parked generation）→ 200 `{agent}`。
   - `POST /:sid/agents/:aid/chat` 升级：先 `ensureLive`（ parked/killed 自动复活——文档
     "messaging a parked or killed subagent revives it"），再 handle.prompt。
   - `POST /:sid/agents/:aid/kill` 升级：`lifecycle.release(id, undefined, {tombstone:true})`
     （终止行 + kill marker 持久化，替代裸 handle.abort）。
   - 空闲 park：`agentIdleTtlMs`（默认沿用 task 设置）——网关侧仅透传。
2. **MCP 热更新（仅项目级自动，用户级保持新会话生效）**：SDK 已自带
   `cfgMcpEnableProjectConfig.listen → mcpManager.reconcileProjectConfig + refreshMCPTools`
   （sdk.ts）——workspace `.omp/mcp.json` 手工编辑会被 live 会话自动跟踪（实测确认项）；
   `PUT /me/mcp`（用户级 agentDir/mcp.json）保持"新会话生效"契约。
   `POST /:sid/mcp/reload` → `mcpManager` reload + `session.refreshMCPTools`（透传 SDK）。
3. **skills 热更新**：注入式 skills（`skillsReloadable=false`）不重构——保持新会话生效；
   待 SDK 暴露注入式 rediscovery（`rediscoverSkills(host)` 需要 host 实现注入侧）再评估。

### M9 集成契约（✅ 已交付；客户端与 UI 实现归集成方）

> 定位（2026-11-15 拍板）：网关**只提供 HTTP/SSE 契约与文档**，不产出任何客户端代码
> （原 Python 客户端生成器已移除）。集成方按 `/openapi.json` + 事件 schema 自行生成。

1. **契约入口**：`GET /openapi.json`（134 操作，含 paths/security/事件清单）+
   `contracts/gateway-events.v1.schema.json`（v1.2，26 事件）+
   `contracts/frontend-mapping.md`（事件→UI 映射、a2ui 卡片、面板→端点对照）。
   SSE 双跳的网关侧语义：断开=解绑订阅、重连=Last-Event-ID 回放、先订阅后 prompt。
2. **事件 → assistant-ui 映射（契约表）**：
   `text.delta→append`；`tool.started→tool-call part（进行中）`；`tool.completed→tool-call
   part（结果）`；`message.completed→assistant message 落定`；`turn.completed(isTerminal)→
   run finish`；`thinking.changed→thinking part`；`tool.confirm_required→审批卡片`。
   **事件增补（additive）**：`tool.started` 加 `args`（a2ui 卡片需要工具输入渲染 diff/命令；
   schema v1.1，向后兼容）。
3. **a2ui 工具卡片**：前端把 `bash/edit/write/read/task` 等工具的 `{name,args,result}` 映射
   为 a2ui 组件（bash→终端卡、edit/write→diff 卡、read→文件预览卡、task→子代理卡联动
   Agent Hub）；网关不再加专端点（数据已足）。
4. **审批 UI 流**：`tool.confirm_required {approvalId, args.full}` → 卡片展示 full 文本 +
   approve/deny → `POST /:sid/approvals/:id` → SSE 观察工具真实执行/拒绝理由；超时倒计时
   用 `timeoutSec`。
5. **管理面**：全局层 `/admin/global/{skills,plugins,mcp,agents}` CRUD 页 + `X-Admin-Id` 透传；
   用户层 `/api/me/*` 同构复用。
6. **文件/git 面板**：`tree/file/raw/upload/index` + `git status/log/diff/branches/commit/
   worktrees`（端点已齐，纯前端工作量）。

### M10 生产化（✅ 网关侧已实现；粘性扩展/凭据治理为部署运维面）

1. **水平扩展**：v1 = 会话粘性（上游按 sid 一致性哈希路由到实例）+ 已有 `/internal/drain`
   排空；会话态（内存 registry/AgentSession）不外置。PG 化 tenant-store 仅评估不做。
2. **sqlite 备份**：定时 `backup API`（风险登记既有项）到 `GATEWAY_BACKUP_DIR`。
3. **OTEL**：`createAgentSession({telemetry: {}})` 开关 `GATEWAY_OTEL=1`（SDK no-op tracer
   安全）；网关 HTTP 中间件补 request spans。
4. **webhook 白名单**：`GATEWAY_WEBHOOK_HOSTS_ALLOWLIST` 收紧 SSRF（风险登记既有项）。
5. **凭据治理**：models.yml 明文 apiKey → 迁移 secrets（`!cmd` 读外部命令/文件）或
   auth-broker；`GET /me/models/config` 增加 mask 开关（上游已约定响应不脱敏，历史可查）。
6. **版本化升级策略**：`@oh-my-pi/*` pin 同版本升级演练 + 规范化层契约测试防事件漂移。

### 明确不做（再次登记）

- cron 定时唤醒 / webhook 入站触发（用户拍板回退）；会话路由层；collab host 移植；
  自建 E2E relay；用户认证（上游职责）。

## 21. 网页控制台数据面（M11，已实现）——不接 SDK 也能用尽 omp

**目标**：React(assistant-ui + a2ui) 只依赖 HTTP/SSE 即可完成 omp TUI 的全部日常操作。
本节的端点全部落在 `src/routes/session-console.ts`（写端点审计），事件在 v1.2 增补。

### 21.1 端点矩阵（以“TUI 面板 → HTTP”对照）

| TUI 面板/动作 | 端点 | 备注 |
|---|---|---|
| `/` 命令菜单 | `GET /:sid/commands` | slashCommands（文件式含 argumentHint/side）+ customCommands（TS/MCP prompts）+ templates；**不回传命令体**（体积），执行仍走 prompt 的 `/xxx` 展开 |
| 模型选择器 | `GET /:sid/models` | 用户可见模型目录（cost/contextWindow/能力位）+ 当前模型 + thinkingLevels/effortSelectors |
| 全局模型目录 | `GET /api/me/models` | providers 去重 + `?provider=` 过滤 + `?refresh=1` 重发现 |
| 思考档位 | `GET/PUT /:sid/thinking` | 已有（M2.5） |
| Todo 面板 | `GET/PUT /:sid/todos` | PUT=`setTodoPhases`（SDK 记 `user_todo_edit`，重载保留） |
| 上下文条 | `GET /:sid/context` | getContextUsage + getContextBreakdown（`?contextWindow=` 覆盖） |
| 状态栏/模式 | `GET /:sid/modes` | plan/goal/vibe/prewalk/checkpoint/lastRewind/usageLimit/serviceTier + isCompacting/isRetrying/isBashRunning/isEvalRunning/isGeneratingHandoff |
| Plan 模式 | `GET /:sid/plan` | 状态 + 参考文件路径 |
| 维护状态 | `GET /:sid/maintenance` | autoCompaction/autoRetry/cacheWarming/promptCache |
| 分叉历史 | `GET /:sid/session-tree` | sessionManager.getTree()（entry 裁剪 + 深度上限 40 + leafId） |
| 停止按钮组 | `POST /:sid/interrupt {target}` | retry/compaction/handoff/branch-summary/bash/eval/all（对应 TUI 各 Esc 通道） |
| 队列整清 | `DELETE /:sid/queue` | dropQueuedMessages + clearQueue（返回被丢弃项） |
| 自动标题 | `POST /:sid/title/generate` | generateTitle（无消息 409 NO_MESSAGES；成功后写回 title） |
| 会话级 skills 明细 | `GET /:sid/skills` | 增强：skills + promptSkills + warnings + settings（manualSkills/hide 的差异可见） |
| 会话检索 | `GET /api/sessions?q=`（标题 LIKE）/ `GET /api/sessions/search?q=`（正文扫 JSONL，snippet） | 网页“找历史对话”；跨用户隔离，文件名/大小上限 8MB，最多 500 文件 |

### 21.2 事件 v1.2（11 个面板事件，additive）

`todo.reminder` / `todo.cleared` / `goal.updated` / `queue.updated` / `compaction.started` /
`compaction.completed` / `retry.started` / `retry.completed` / `model.fallback` /
`config.warnings` / `rules.triggered`。映射见 `contracts/gateway-events.v1.schema.json`
（26 事件）与 `contracts/frontend-mapping.md`（含面板 → 端点对照）。高频事件
（text.delta/omp.raw）不进 webhook；面板事件全部进 webhook。

### 21.3 明确的分层边界

- **命令执行**不新增端点：`POST /prompt {text:"/compact ..."}` 由 SDK 的 `runCommands` 展开（TUI 同款语义）；
  网关只提供菜单数据（名称/描述/参数提示），避免重复实现命令语义。
- **plan/goal/vibe 的状态写入**不做通用端点：这些模式的进入/退出由 SDK 命令（slash）驱动，
  网关暴露状态读取；若后续需要程序化控制，按 SDK 的 `setGoalModeState`/`setCheckpointState` 单独补。
- **UI 组件**（卡片/倒计时/树渲染）归前端；契约见 frontend-mapping.md。

**验证**：`test/console.test.ts`（24 用例：面板形状/写端点/守卫/会话检索/v1.2 事件矩阵/schema 一致性）。

### 21.4 集成面硬化（同轮实现）

| 能力 | 实现 | 说明 |
|---|---|---|
| CORS | `GATEWAY_CORS_ORIGINS`（逗号分隔，支持 `*`） | 浏览器直连/分享页场景；预检在认证前短路（204），白名单外的 origin 不回 CORS 头。默认架构（BFF 代理）无需开启 |
| 分页元数据 | `GET /api/sessions` → `{sessions, total, page, perPage}` | `total` 用 `countSessions(uid,status,q)` 与列表同条件计数（含 `?q=` 标题过滤） |
| 配额面板 | `GET /api/me/limits` | 限额（maxSessions/maxConcurrent/rpm/monthlyBudgetUsd）+ 本月用量/预算余额 + RPM 滑动窗口（used/limit/resetInSec） |
| SSE 事件过滤 | `GET /:sid/events?types=text.delta,tool.*` | 逗号分隔，后缀 `*` 通配；`replay.state`/`error` 恒放行；被过滤事件不占用连接背压 |
| 错误码契约 | `contracts/error-codes.md` | 全部 code → status → 处理建议（认证/分享/会话/模型/SDK 操作/资源/SSE 传输层），与代码 `jsonError` 一一对应 |

## 22. 多语言集成门面（M12，已实现）——提示词注入 / 状态 / 事件 / 回调全部会话级

**定位**：集成端（python/go/ts 等）只依赖 HTTP/SSE，不需要 omp SDK 或网关客户端代码。
四件事**全部以会话（sid）为作用域**；仅用户级跨会话汇总与创建期选项例外。
契约文档：`contracts/integration-guide.md`（另见 error-codes.md / frontend-mapping.md）。

### 22.1 提示词注入（三层，均为会话级）

| 层 | 端点/字段 | 语义 |
|---|---|---|
| 创建期·系统提示词 | `POST /api/sessions {appendSystemPrompt}` | 追加到默认系统提示词末尾（不替换） |
| 创建期·上下文文件 | `POST /api/sessions {contextFiles:[{path,content}], noContextFiles}` | AGENTS.md 式上下文进系统提示词；**只进提示词不落盘**；单文件 ≤256KB、合计 ≤1MB、≤20 个（400/413） |
| 运行期·上下文注入 | `POST /:sid/inject {text, mode:"context", deliverAs, triggerTurn, customType}` | `sendCustomMessage`；默认**不触发 turn**（不耗预算）；`deliverAs ∈ steer/followUp/nextTurn/aside`；`triggerTurn:true` 才开新 turn（走 RPM/预算检查） |
| 运行期·用户消息 | `POST /:sid/inject {mode:"user", deliverAs}` | 走 prompt 流程（idle 起 turn/streaming 转 steer） |
| 运行期·系统提示词 | `mode:"system"` → **409 NOT_SUPPORTED** | SDK 无运行时 setter；明确失败而非静默忽略（改提示词=新会话） |
| 模板/命令 | `POST /:sid/prompt {text:"/<name> ..."}` | SDK `runCommands` 展开（slash/模板/MCP prompts） |

**同步模式**：`inject` 与 `prompt` 均支持 `wait:true` + `waitTimeoutMs`（≤600s）——
SessionCtx.waitTerminal 持 HTTP 到 turn 终态，返回 `{waited,timedOut,streaming,latestSeq}`；
`timedOut=true` 表示等待超时但 turn 继续（可经 SSE/回放续取）。给无 SSE 能力的集成端用。

### 22.2 状态

| 端点 | 用途 |
|---|---|
| `GET /:sid/bootstrap` | 一次拿全：session/state（模型/思考/队列/工具/上下文用量）/modes/approvals/commands/events 游标 |
| `GET /:sid/status` | 轻量轮询：status/model/thinkingLevel/pendingApprovals/queueCount/latestSeq |
| `GET /:sid/integration` | 自描述：本会话全部集成端点 + 契约文档路径 |

### 22.3 事件

- SSE `GET /:sid/events?types=`（实时，Last-Event-ID 重连）
- JSON 回放 `GET /:sid/events/replay?since=&limit=&types=`（轮询/断线补齐；环形缓冲 500 条，返回 nextSince/truncated）
- 事件全集 26 类（schema v1.2）

### 22.4 回调（**会话级**）

| 作用域 | 端点 | 匹配 |
|---|---|---|
| 会话级（推荐） | `GET/POST /:sid/webhooks`、`DELETE /:sid/webhooks/:id` | 只收该会话事件；跨用户/跨会话 404 |
| 用户级（跨会话汇总） | `GET/POST /api/me/webhooks`、`DELETE /api/me/webhooks/:id` | `session_id IS NULL` → 收该用户全部会话事件 |

数据模型：webhooks 表加 `session_id TEXT`（NULL=用户级；启动时 ALTER TABLE 迁移旧库）；
投递匹配 `listWebhooksForDispatch(userId, sessionId)`；缓存键 `${userId}\0${sessionId}`（避免串方案）。
HMAC-SHA256 签名（`x-omp-signature`）+ `x-omp-session` 头；高频事件不投递；失败 2s 后重试一次。

**验证**：`test/integration-facade.test.ts`（16 用例：注入形状/超限、system 模式 409、
context 不触发 turn、bootstrap/status/replay 结构、会话级/用户级订阅隔离、自描述）。

## 23. 集成端钩子（M13，已实现）——omp hooks 的 HTTP 桥

**背景**：omp 官方 hooks 只有 TS 回调（`pi.on`），**没有 HTTP/回调钩子**（docs/hooks 明确）。
网关补这一层：集成端注册 URL，网关在生命周期节点同步/异步调用，集成端返回决策。

### 23.1 双作用域（用户级 + 会话级）

| 作用域 | 端点 | 匹配 |
|---|---|---|
| 会话级 | `GET/POST /api/sessions/:sid/hooks`、`DELETE /:sid/hooks/:id` | 只对该会话 |
| 用户级 | `GET/POST /api/me/hooks`、`DELETE /api/me/hooks/:id` | 该用户**所有**会话（session_id NULL） |

注册字段：`{event, url, mode: notify|decide, matcher?: {tool}, timeoutMs, onTimeout: allow|deny, secret?}`。
`secret` 仅创建响应返回；投递带 `x-omp-signature`（HMAC-SHA256）、`x-omp-hook-event`、`x-omp-hook-id`。

### 23.2 事件面（21 个，对齐官方可变更 + 网关侧通知）

**决策型（14，mode=decide；同步等响应）**
| 事件 | 集成端可返回 | 合并语义 |
|---|---|---|
| `resources_discover` | `{skillPaths?, promptPaths?, themePaths?}` | 累积去重 |
| `input` | `{text?}` 改写 / `{handled:true}` 拦截 / `{block:true}` 拒绝 | 链式 + handled 终止 |
| `user_bash` / `user_python` | `{result}` 替换执行 | 首个获胜 |
| `tool_call` | `{block?, reason?, input?, additionalContext?}` | block 首个获胜；input 末个获胜 + 链式 |
| `tool_result` | `{content?, isError?, additionalContext?}` | 逐字段链式 |
| `context` | `{messages}` 替换本次模型调用上下文 | 末个获胜 + 链式 |
| `before_agent_start` | `{message?, systemPrompt?}` | message 累积；systemPrompt 链式 |
| `session_before_switch` / `session_before_branch` / `session_before_compact` / `session_before_tree` | `{cancel?, …}` | cancel 首个获胜 |
| `session.compacting` | `{context?, prompt?, preserveData?}` | 末个获胜 |
| `session_stop` | `{continue:true, additionalContext}` / `{decision:"block", reason}` | 首个非空 continuation 获胜 |

**通知型（7，mode=notify；异步投递，失败 2s 后重试一次）**
`session_start` / `session_shutdown` / `turn_end` / `agent_end` / `session_compact` /
`tool_approval_requested` / `tool_approval_resolved`

**超时兜底**：decide 钩子不可达/超时 → `onTimeout`（allow|deny）；`deny` 对 tool_call/input 即 block，
对 `session_before_*` 即 cancel（fail-closed，与官方 tool_call 语义一致）。

### 23.3 实现要点（踩坑记录）

1. **扩展模块图隔离**：SDK 的扩展加载器在独立模块图中 import 扩展，扩展再 import 网关模块会得到
   **另一个模块实例**（实测 `sessionMap.size=0`）。修复：`globalThis` + `Symbol.for("omp.gateway.hooks.v1")`
   共享桥（sessionMap + dispatch 实现），网关主体先加载并安装实现，扩展只调用。
2. **`input` 事件不经 SDK prompt 路径**：官方 `input` 只在交互式输入（TUI/RPC）触发，`session.prompt()`
   不 emit。修复：`POST /:sid/prompt` 与 `/inject` 在准入前由网关分发 `input` 钩子（可改写/拦截）。
   `user_bash`/`user_python` 同理（网关无"用户 !/$ 命令"，仅注册不触发）。
3. 钩子扩展经 `additionalExtensionPaths` 注入每个会话（`src/ext/gateway-hooks.ts`）。

**验证**：`test/integration-hooks.test.ts`（8 用例：事件清单 21/注册校验/双作用域隔离/超时兜底）；
`test/e2e-hooks.test.ts`（真实模型：tool_call 拦截 bash 不执行、input 改写用户输入）。

## 24. 集成端 HTTP 工具（M13，已实现）——SDK customTools 的 HTTP 形态

**背景**：SDK `customTools` 让宿主注册工具给 agent 调用；网关把它变成 HTTP 契约，
业务系统无需写 TS 即可把自己的函数暴露给 agent（与 MCP 并列的轻量路径）。

### 24.1 双作用域

| 作用域 | 端点 | 可见性 |
|---|---|---|
| 用户级 | `GET/PUT /api/me/tools/http[/:name]`、`DELETE` | 该用户全部会话 |
| 会话级 | `GET/PUT /api/sessions/:sid/tools/http[/:name]`、`DELETE` | 仅该会话（同名覆盖用户级） |

注册：`{description, parameters(JSON Schema), url, label?, secret?, timeoutMs?, approval?}`。
名称 `^[a-z][a-z0-9_]{1,63}$` 且不得撞内置工具（`INVALID_NAME`）。

### 24.2 执行协议

```http
POST <business-url>
content-type: application/json
x-omp-signature: <hmac-sha256(secret, body)>
x-omp-tool: <name>
x-omp-tool-call-id: <toolCallId>
x-omp-session: <sid>
```
```json
{ "toolCallId": "…", "name": "order_status", "args": { "orderId": "A-1001" }, "sessionId": "…", "userId": "…" }
```
响应（二选一）：`{"text":"…","isError":false}` 或 `{"content":[{"type":"text","text":"…"}]}`。
超时/不可达 → 工具结果 `isError:true`（模型可见失败原因，不中断 turn）。

### 24.3 注入路径（热更新）

- 创建会话：`createAgentSession({ customTools })` —— **extension-owned**，不被 MCP refresh 清除；
  受限会话（toolNames allowlist）同时传 `allowRestrictedCustomTools: true`。
- 运行期新增/删除：`session.refreshMCPTools([...mcpTools, ...httpTools])` —— manager-owned；
  **MCP reload 后必须重放**（`POST /:sid/mcp/reload` 已内置）。
- 合并：用户级 + 会话级，同名会话级优先。

**验证**：`test/http-tools.test.ts`（6 用例：双作用域隔离/校验/内置名冲突/真实模型调用业务端点并回填）。

## 25. 会话格式与工具面（M14，已实现）——对齐 docs/session-format + docs/tools

### 25.1 会话 JSONL：校验 / 导入 / 原始导出

| 端点 | 语义 |
|---|---|
| `POST /api/sessions/validate` | dry-run 校验（不落库）：逐行 JSON → 可选 title 记录 → header(session) → entries(type/id/timestamp/parentId) → id 唯一 → parent 解析 → 无环 → 引用（firstKeptEntryId/targetId/toolCallId）。返回 `{valid, errors[], warnings[], stats}` |
| `POST /api/sessions/import` | 上传 JSONL 导入为会话：校验 → 写用户会话目录（`<stamp>_<header.id>.jsonl`）→ 建 workspace → DB 行 → 201；重复 id 409；非法 400 INVALID_SESSION_FILE |
| `GET /api/sessions/:sid/session-file` | 下载原始 JSONL（`application/x-ndjson`，≤20MB，备份/迁移用） |

**安全**：`header.id` 必须匹配 `^[A-Za-z0-9_-]{8,128}$`（防路径穿越）；文件 ≤20MB；跨用户 404。

**模型自洽（关键）**：文件缺 `model_change` 时导入自动补一条（用户首个可用模型），否则 SDK revive 会抛
`Could not restore model`。若用户无可用模型：导入仍成功，但 live 端点返回 **409 MODEL_UNAVAILABLE**
（三个 `live()` 统一映射 revive 失败，不再是裸 500）。

### 25.2 Entry 面增强

- `GET /:sid/entries?type=message,compaction&offset=&limit=` —— 类型过滤（对齐 session-format 的 entry 清单）+ 分页 + 每项带 `label`
- `PUT /:sid/entries/:entryId/label {label}` / `DELETE` —— `sessionManager.appendLabelChange`（label entry；网页书签/标重点）
- `GET /:sid/tools/info` —— `getAllToolInfos()`：name/description/parameterNames/requiredParameters/source（builtin|mcp）/active

**验证**：`test/session-format.test.ts`（9 用例：合法/非法校验矩阵、导入+重复+下载、跨用户守卫、
entries 过滤、标签增删、tools/info 形状）。

## 26. 上下文文件与提示词注入（M15，已实现）——对齐 docs/context-files

### 26.1 发现规则（与官方对照）

| 文件 | 官方位置 | 网关处理 |
|---|---|---|
| `AGENTS.md` / `RULES.md` | 项目 cwd 向上 + 用户 agentDir | 项目级由 SDK 自动发现（cwd=workspace）✅；**用户级 agentDir 不被 SDK 发现**（实测，仅读进程级 `~/.omp/agent`）→ 网关**显式注入** |
| `APPEND_SYSTEM.md` | 同上 | 用户级由网关拼进 `appendSystemPrompt`（在调用方 append 之前） |
| `SYSTEM.md` | 同上 | **不自动应用**（完整替换系统提示词风险高）；需显式创建选项 `systemPrompt` |
| 兼容生态（CLAUDE.md/.agent/.codex/.gemini/.github 等） | 各有目录 | 由 SDK 自动发现（受 `disabledProviders` 设置）；网关不干预 |

**多租户边界**：项目级 = workspace（1:1），SDK 从 workspace 向上发现，天然隔离；
用户级 = `users/<uid>/agent/<name>`，由网关显式注入（见 26.2）。

### 26.2 网关注入实现（session-factory）

```
loadUserContextFiles(agentDir):
  AGENTS.md / RULES.md  → contextFiles: [{path, content}]   （与调用方 contextFiles 合并，用户级在前）
  APPEND_SYSTEM.md      → appendSystemPrompt（"用户级\n\n调用方" 拼接）
  SYSTEM.md             → 忽略（仅显式 systemPrompt 选项可替换）
```
`noContextFiles: true` 只禁项目自动发现；显式注入的用户级文件仍加载（官方语义一致）。

### 26.3 API

| 端点 | 语义 |
|---|---|
| `GET /api/me/context-files` | 用户级四文件清单（agentDir）+ 支持名 + 放置提示 |
| `GET/PUT/DELETE /api/me/context-files/:name` | 读写删（`AGENTS.md`/`RULES.md`/`APPEND_SYSTEM.md`/`SYSTEM.md`；PUT ≤256KB；变更对新会话生效） |
| `GET /:sid/context-files` | 会话实际上下文来源：网关扫描 `files[{scope:user\|project, name, path, bytes, applied}]`（applied=内容命中系统提示词）+ SDK `skills` 来源 + `promptBlocks` |
| `POST /api/sessions {appendSystemPrompt, systemPrompt, contextFiles, noContextFiles}` | 创建期注入（systemPrompt 完整替换 ≤256KB，与 append 互斥且 append 优先） |

**验证**：`test/context-files.test.ts`（7 用例：四文件 CRUD/非法名/超限、跨用户隔离、
创建期选项组合、会话级来源 applied 判定）。实证 probe：项目 AGENTS.md/RULES.md 由 SDK 发现；
用户级 agentDir 文件必须网关注入（否则多租户下用户规范不生效）。

### 26.4 附：测试运行方式（同轮修复）

Bun 默认并行执行测试文件，22+ 集成测试各自 spawn 网关会导致偶发子进程启动失败（ECONNREFUSED）。
新增 `scripts/test-all.mjs`：**逐文件串行** `bun test <file>` 并汇总；`package.json` 的 `test` 使用它，
`test:parallel` 保留原行为（快但可能偶发失败）。

## 27. Provider 面与设置隔离修复（M16，已实现）——对齐 docs/providers

### 27.1 严重隔离缺陷修复（本轮最重要）

**实证**：`Settings.init()` 是**进程级单例**（settings.ts:857 `if (globalInstancePromise) return globalInstancePromise`）——
首次调用的 `agentDir` 决定 config.yml 路径，之后所有用户拿到的都是**同一实例**。后果：
`tools.approvalMode`、`disabledProviders` 等所有用户级设置**跨用户串用**，且 `writeValue("global")` 写进第一个用户的 config.yml。

**修复**：`user-context.ts` 改用 `Settings.loadIsolated({cwd, agentDir, overrides: {}})`（不碰全局单例、仍是可写实例）。
影响面：审批开关、provider 禁用、压缩/重试等全部用户级设置恢复真隔离。**修复后 273 tests 全绿**。
（此前 M7 审批测试未暴露，是因为单用户场景。）

### 27.2 Provider 结构化视图

`GET /api/me/providers` —— 集成端无需解析 YAML：
- `providers[]`：`id / configured(models.yml 显式) / builtin / available(有凭据且未禁用) / disabled /
  baseUrl / api / auth / hasApiKey / declaredModels / availableModels / models[≤50]`
- `counts{total,configured,available,disabled}`、`disabledProviders[]`、`note`
- 解析：models.yml（`Bun.YAML.parse`）+ `modelRegistry.getAvailable()`（SDK 可用性规则反推）+ `cfgDisabledProviders`
- 安全：**不返回 apiKey 明文**；apiKey 若为环境变量名由 SDK 请求时解析

`GET/PUT /api/me/providers/settings` `{disabledProviders: string[]}` —— 写该用户 config.yml（`cfgDisabledProviders`），
内存即时生效（ModelRegistry 持同实例）；不 rebuild user context（否则读到未落盘旧文件）。

`GET /api/me/models?find=<term>` —— 对齐 `omp models find`（provider/id/name 子串），可与 `provider=` 组合。

### 27.3 明确不做（本轮）

- **OAuth `/login`·`/logout`**：需要浏览器/设备码交互与凭据托管，属产品决策（此前拍板 v1 用 models.yml/credentials）。
  现状：`POST /api/me/models/credentials` 写 models.yml apiKey；provider 无凭据时 `available=false` 可诊断。
- **model roles**（`/docs/roles` 的 default/smol/slow/plan…）：未暴露；需要时加 `GET/PUT /api/me/model-roles`。
- **headers/compat/fallback 链/`!cmd` 密钥**：不做结构化视图（避免过度建模），直接 `PUT /api/me/models/config` 写 YAML。

**验证**：`test/providers.test.ts`（8 用例：解析/不泄明文/auth:none/counts/无效 YAML 400/
设置读写+隔离/非法 body/find 搜索）。

## 28. 角色 / Agent 定义 / MCP 面（M17，已实现）——对齐 docs/roles + agents-and-roles + subagent-authoring + mcp

### 28.1 模型角色（docs/roles）

内置 10 角色：`default / smol / slow / vision / plan / designer / commit / tiny / task / advisor`；
值支持 `provider/model[:thinking]`、`@role` 别名、`*`(=@default)、逗号分隔有序选择器。

| 端点 | 语义 |
|---|---|
| `GET /api/me/model-roles` | `{roles, cycleOrder(默认 smol,default,slow), roleStorage, note}` |
| `PUT /api/me/model-roles {roles?, cycleOrder?}` | 写 config.yml（`cfgModelRoles`/`cfgCycleOrder`）；角色名 `^[a-z][a-z0-9_-]{0,31}$`、selector 非空 ≤512；对新会话生效 |

会话级已有：`GET /:sid/models`（current/available/thinkingLevels）、`PUT /:sid/model`、`POST /:sid/cycle-model`。
**不做**：`modelTags` 展示元数据（纯 UI 语义）。

### 28.2 Agent 定义（agents-and-roles + subagent-authoring）

定义文件 = Markdown + YAML frontmatter；用户级 `agentDir/agents/<name>.md`，
项目级 `workspace/.omp/agents/`（经 workspace 文件 API 读写）；优先级 project > user > extension > bundled。

| 端点 | 语义 |
|---|---|
| `GET /api/me/agents` | 扫描用户级定义：`name/file/valid/description/tools/model/thinkingLevel/spawns/autoloadSkills/readSummarize/blocking/prewalk/advisor/hasOutputSchema/instructionsChars/updatedAt`（name≠文件名时给 warning） |
| `GET/PUT/DELETE /api/me/agents/:name` | 原文读写删；PUT 校验：frontmatter 存在、`name`+`description` 必填、`name===路径名`、正文非空、≤256KB |
| `GET /:sid/agents/definitions` | 会话可见定义（`getSessionAgents` + `getAdvertisedSessionAgents` 的 advertised 标记）+ 生效 tools/model/thinking/spawns/prewalk/advisor |

frontmatter 字段全量对齐 subagent-authoring：`name/description/tools/model/thinking-level/spawns/autoload-skills/
read-summarize/output/blocking/prewalk/advisor`（camelCase 与 kebab-case 均接受）。
结构化 JSON 读写见 §30（`PUT/POST /api/me/agents` + `GET ...?format=json`）。

### 28.3 MCP 面（docs/mcp）

| 端点 | 语义 |
|---|---|
| `GET /:sid/mcp/servers` | 逐服务器：`status(connected/connecting/disconnected) / transport(stdio\|http\|sse) / command / url / enabled / timeoutMs / source / toolCount / tools[≤10] / hasInstructions` + `connected[]` |
| `POST /:sid/mcp/servers/:name/reconnect` | 单服务器重连（不重新发现）→ 重放 HTTP 工具 |
| `GET /:sid/mcp/servers/:name/resources` | 资源列表（`?refresh=1` 先刷新） |
| `GET/PUT /api/me/mcp/settings {disabledServers?, enabledServers?}` | 用户级 denylist/allowlist（写 agentDir/mcp.json 顶层字段；**disabledServers 优先级最高**，即使导入配置也禁用）；非法 JSON 时不覆盖 |

已有：`GET /:sid/mcp`（连接/工具汇总）、`POST /:sid/mcp/reload`、`GET/PUT /api/me/mcp`（原始配置）。
**不做**：OAuth reauth/unauth（与 provider OAuth 同属产品决策）、`/mcp remove --scope project`（用 workspace 文件 API）。

**验证**：`test/roles-agents.test.ts`（11 用例：角色读写/校验/隔离、agent CRUD/frontmatter 校验/隔离、
MCP 设置读写、会话级 definitions 与 servers 结构）。

## 29. 代码结构重构（设计模式，M18）——消除重复与职责过载

### 29.1 坏味道盘点（重构前实测）

| 指标 | 重构前 | 重构后 |
|---|---|---|
| 会话守卫 `live()` 副本 | 3 份（sdk/console/integration 各一，逻辑须同步改） | **0**（全部走 `createSessionAccess().resolve`） |
| HMAC 签名实现 | 6 处（webhooks/hook-engine/http-tools） | **1**（`core/signature.ts`） |
| `whsec_` 密钥生成 | 7 处散落路由 | **1**（`generateSecret()`） |
| session-factory 行数/职责 | 308 行 / 11 个步骤 | **170 行（纯编排）** + `session-assembly.ts`（8 个具名步骤） |
| events 规范化 | 209 行 switch | 映射表 `EVENT_MAPPERS`（新增事件=加一行） |
| 用户设置读写样板 | approval/model-roles/providers 各写一遍（含"写后勿 reload"语义） | `core/settings-facade.ts` 统一 |

### 29.2 应用的模式

| 模式 | 落点 | 解决的问题 |
|---|---|---|
| **Façade**（门面） | `session-access.ts`、`settings-facade.ts`、`signature.ts` | 把"归属校验 → 复活 → 错误映射"和"取 UserContext → 导入 cfg → 读写"收敛成单一入口 |
| **Factory**（工厂） | `createSessionAccess(deps)` | 依赖注入（ownedSession/getOrRevive/jsonError），路由不再各自拼装 |
| **Builder**（建造者） | `session-assembly.ts`：`prepareWorkspace` → `loadExtensionLayers` → `buildCreateOptions` → `installUiBridge` → `installHookBridge` → `wireAgentHub` | 工厂只编排；每个步骤独立可读/可测（10 步装配不再是单体函数） |
| **Strategy Map**（策略表） | `EVENT_MAPPERS`（events.ts） | 替代长 switch；新增 omp 事件零侵入 |
| **Utility/Service** | `signPayload` / `generateSecret` / `SIGNATURE_HEADER` | 签名算法与头名单点定义（契约：HMAC-SHA256(secret, rawBody) → hex） |

### 29.3 顺带修复的真问题

`disposeSession` 之前**未注销钩子桥映射**（`registerHookSession` 只在创建时写、进程内 Map 永不清理，复活/归档累积泄漏）。
重构时补 `unregisterHookSession(ctx.ompSessionId)`。

### 29.4 明确不做

- **tenant-store（991 行）按领域拆文件**：收益主要是文件组织，风险（跨表事务/迁移顺序）大于收益，保留单文件 + 分区注释。
- **`jsonError` 全量替换为 DomainError + onError**：184 处调用，语义已统一（code+status），替换无功能收益。
- **webhooks/hooks/http-tools 三套 CRUD 抽象为通用注册器**：字段/校验/表结构差异大，抽象会引入配置复杂度（"错误的抽象"）。

**验证**：重构后 `bun scripts/test-all.mjs` 全量通过（串行 27 文件）；tsc 0 error。

## 30. 结构化配置 DTO（JSON ⇄ YAML/Markdown，M19）

### 30.1 问题

集成端（Python/Go/TS）提交 models.yml 与 agent 定义时只能发原文：在 JSON 里塞多行 YAML/Markdown
字符串（`"providers:\n  minimax:\n..."`），转义易错、没有字段校验、前端也无法直接生成表单。
示例（旧写法）：

```json
{ "body": "providers:\n  minimax:\n    baseUrl: https://api.minimax.cn/v1\n    api: openai-completions\n..." }
```

### 30.2 方案：Codec 层（`core/config-codec.ts`）

路由只做 content-type 分流与文件 IO；**校验 + 序列化集中**在一处（与 §29 的分层原则一致）。

| 资源 | JSON DTO | 落盘格式 |
|---|---|---|
| `models.yml` | `{ providers: Record<providerId, ProviderConfig> }` | `Bun.YAML.stringify(doc, null, 2)` → 2 空格块状缩进（可直接当 models.yml 用） |
| `agents/<name>.md` | 字段白名单 + `instructions` | YAML frontmatter（camelCase，SDK `parseAgentFields` 直接读取）+ 正文 |

关键兼容点：历史客户端（测试、早期 Python 示例）把 YAML/Markdown 原文也标成 `application/json`，
因此仅当 **JSON content-type 且正文以 `{`/`[` 开头** 才走结构化，否则按原文处理；
`?format=json|yaml|markdown` 可显式覆盖。原文 PUT 行为完全不变。

校验边界（结构化通道）：

- provider id：`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`；`models[].id` 必填且 provider 内唯一；
  `contextWindow/maxTokens/maxContextWindow` 正整数；`headers` 为 string map。
- Agent：未知字段 400（防拼错）；`name`（PUT 取路径/POST 取 body）与 `description`、`instructions` 必填；
  `thinkingLevel`/`autoloadSkills`/`readSummarize` 三个带 kebab-case 别名，同时给出即 400；
  `spawns:"*"` 原样保留；`tools:[]` 表示显式空 allowlist。
- 未建模的 provider/model 字段**透传**（与 models.yml 前向兼容）；Agent 需要未建模字段时走
  `{content:"<完整 markdown>"}` 原文通道。

### 30.3 端点

| 端点 | 语义 |
|---|---|
| `GET /api/me/models/config` | 原文 YAML（不变） |
| `GET /api/me/models/config?format=json` | 结构化视图 `{format,config,note}`；语法错误 → 400 `INVALID_YAML` |
| `PUT /api/me/models/config` | `application/json` = 结构化整体替换；其余 = 原文 YAML |
| `GET /api/me/models/providers/:provider` | 单 provider 配置（未配置 404；apiKey 明文，仅全权身份） |
| `PUT /api/me/models/providers/:provider` | **整体替换**该 provider（省略字段即删除）；其他 provider 不动 |
| `DELETE /api/me/models/providers/:provider` | 删除该 provider；未配置 404 |
| `GET /api/me/config/schema` | 自描述：provider/model 字段清单、providerId 正则、agent 字段表（含别名）、示例 |
| `GET /api/me/agents/:name?format=json` | `{name,description,tools,model,thinkingLevel,...,instructions,frontmatter}` |
| `PUT /api/me/agents/:name` | `application/json` = 结构化；`text/markdown` = 原文（不变） |
| `POST /api/me/agents` | 结构化创建（`name` 取自 body；`{content}` 时取自 frontmatter；同名 409 `ALREADY_EXISTS`） |

### 30.4 取舍

- **结构化写入会重写文件**，注释/锚点不保留；要保留原格式走原文 PUT。响应里的 `format` 字段便于集成端判断。
- **不做 JSON Schema 全量镜像 models.yml**：兼容字段极多且 SDK 对未知字段本就透传，白名单会随 SDK 版本腐烂；
  只校验高频字段 + 提供 `config/schema` 自描述。
- **不做 YAML AST 级编辑**（保留注释的结构化写入）：收益低，原文通道已覆盖。

**验证**：`test/providers.test.ts` 新增 4 用例（结构化整体写/单 provider CRUD/校验/schema）、
`test/roles-agents.test.ts` 新增 3 用例（结构化 agent/POST+content/校验）；tsc 0 error。

## 31. 结构拆分（M20）——按能力边界拆模块，组合根只做 mount

### 31.1 拆分结果（实测行数）

| 原文件 | 拆分前 | 拆分后 |
|---|---:|---|
| `routes/session-sdk.ts` | 1083 | 组合根 43 + `session-sdk/*` 8 模块（最大 237） |
| `core/tenant-store.ts` | 991 | barrel 21 + `core/store/*` 11 模块（最大 201；M21 死代码清理后 10 模块） |
| `routes/config-resources.ts` | 950 | 组合根 33 + `routes/config/*` 10 模块（最大 252） |
| `routes/sessions.ts` | 820 | 组合根 68 + `routes/session/*` 5 模块（最大 188） |
| `core/config-codec.ts` | 609 | barrel 16 + `core/config/*` 6 模块（最大 271） |
| `routes/session-integration.ts` | 556 | 组合根 24 + `session-integration/*` 5 模块（最大 222） |
| `core/hook-engine.ts` | 493 | barrel 10 + `core/hooks/*` 5 模块（最大 226） |
| `routes/workspace.ts` | 356 | 组合根 16 + `workspace/*` 3 模块（最大 194） |
| `core/session-registry.ts` | 344 | barrel 7 + `core/session/*` 2 模块（最大 310） |
| `routes/session-console.ts` | 328 | 组合根 18 + `console/*` 2 模块（最大 231） |
| `routes/session/lifecycle.ts` | 319 | 组合根 11 + `create.ts` / `crud.ts` |
| `routes/agent-config.ts` | 301 | 组合根 21 + `agent-config/*` 3 模块（最大 163） |

源码文件 42 → 113，总行数基本不变（无逻辑改动）。拆分后**单文件上限 310 行**，且 300 行级文件只剩
`session-ctx.ts`（SSE 缓冲/turn 元数据/审批状态机本身是一个内聚状态机）。

### 31.2 结构模式

```
routes/<domain>/
  <feature>.ts        # Capability Module：只注册自己那组路由
  shared.ts           # Shared Context Factory：Façade + 守卫 + 错误体
<root>.ts             # Composition Root：use(auth) → mount 各模块
```

| 模式 | 落点 | 约束 |
|---|---|---|
| **Composition Root** | `sessions.ts`、`config-resources.ts`、`session-sdk.ts`、`session-integration.ts`、`workspace.ts`、`session-console.ts`、`agent-config.ts` | 只做中间件 + mount；不写业务逻辑 |
| **Barrel / Façade** | `tenant-store.ts`、`config-codec.ts`、`hook-engine.ts`、`session-registry.ts` | 对外导出保持不变，调用方零改动 |
| **Shared Context Factory** | `createSdkShared` / `createIntegrationShared` / `createConsoleShared` / `createWorkspaceShared` / `session/shared.ts` | 每个域只建一次 `live` Façade；能力模块从 `shared` 取守卫 |
| **Capability Module** | `session-sdk/{state,control,history,agents,approvals,jobs,capabilities,lifecycle}` 等 | 一个文件一个能力面；依赖只允许 core + 同目录 `shared.ts` |
| **Domain Store** | `core/store/{tenants,sessions,usage,snapshots,idempotency,shares,integration-hooks,http-tools,webhooks}` | 每个模块只依赖 `db` + 自己的类型；跨域查询留在所属域（session-events 模块在 M21 死代码清理中移除：业务事件为内存环形缓冲语义，不落库） |

### 31.3 新增功能的落点规则

1. **会话端点** → 放进 `routes/session-sdk/*` 对应能力文件（或新建能力文件），从 `shared` 取
   `live/jsonError/withTurnSlot`；**禁止再写第三份 live()**。
2. **用户级配置端点** → `routes/config/<domain>.ts` 新模块 + 组合根加一行 mount。
3. **数据表/查询** → `core/store/<domain>.ts` 新模块 + barrel 加一行 export；SQL 只出现在 store 层。
4. **钩子事件语义** → `core/hooks/cache.ts`（载荷/匹配）与 `dispatch.ts`（合并分支）分开改，不混在一起。
5. **单文件目标 ≤300 行**；超过时先问"能不能按能力面拆"，而不是按函数机械切。

### 31.4 明确不做

- `session-import.ts`（253 行）保持单文件：校验（`validateSessionJsonl`）与导入路由共享
  `ValidationResult`，强内聚；再拆会引入无意义的类型搬运。
- `core/files.ts` / `core/git.ts` 按"文件系统 / git 子进程"边界组织，是底层适配器，不再按行拆。
- `core/store/db.ts` 的建表 SQL 保持单个 `db.exec`：按表拆文件会打乱迁移阅读顺序，收益低。

**验证**：纯结构重构，291 pass / 0 fail（26 文件串行）；tsc 0 error。

### 31.5 静态检测工具链（M20 补充）

| 工具 | 配置 | 门禁 |
|---|---|---|
| tsc `strict` + `noUnusedLocals/noUnusedParameters` | `tsconfig.json` | `bun run typecheck` |
| **Biome 2.6**（linter + formatter） | `biome.json`（lineWidth 120；`noExplicitAny`/`noConsole` 关闭——Hono/SDK 互操作层有意为之） | `bun run lint` / `bun run lint:fix` |

规则基调：recommended 全开；坏味道清理时逐条修复而非压制（仅 `noExplicitAny` 等架构性豁免进配置，
不写行内 ignore）。首次接入修复量：格式化 25 文件；lint 148 处（safe/unsafe 自动修复 124，
手工修复 24：`noImplicitAnyLet`×12 显式类型、`noAssignInExpressions`×9（SSE 帧解析 while→for 循环、
桥初始化拆行）、switch fallthrough→`return fail(...)`、forEach 回调加花括号、恒真三元删除）。

### 31.6 注释规范

| 场景 | 写法 |
|---|---|
| 文件头 | `/** */` 置于 import 之前：一段话说清模块职责、关键约束/不变式、指向 DESIGN 节号；不逐行罗列内容 |
| 导出符号 | 一句话 JSDoc 摘要；`@param`/`@returns` 只在含义不直观时写（简单 getter/CRUD 不写） |
| 行内注释 | 只解释**为什么**（并发/隔离/兼容性/SDK 行为/踩过的坑），不复述代码 |
| 分节 | `// ---- 名称 ----`（沿用现状） |

禁则：不写"本文件实现了…"式开场白；不写"注意/首先/其次/总之/值得注意的是"等填充词；
不用 emoji；不为 getter 和一行函数写注释；注释与代码不一致时以代码为准并当场改注释。


## 32. 环境迁移设计（M21 设计 / M22 实现）——"搬数据库文件 = 搬整个环境"

> **实现状态（M22，2026-11-15）**：INV-1/INV-2/§32.8 端点已全部落地并过 e2e
> （`test/env-migration.test.ts`：A 实例导出 → 不同 dataRoot 的 B 实例导入 → 全量对账）。
> 实现要点与本节的差异：
> - bundle = **目录**（`gateway.db` + `users/` + `global/` + `manifest.json`），tar 交给外部（rsync/scp/zip）；
> - 导出目录 `GATEWAY_EXPORT_DIR`（默认 dataRoot 同级 `gateway-exports/`），导入白名单 `GATEWAY_IMPORT_DIRS`
>   （默认含导出目录；跨机时指向共享存储或把 bundle 拷入）；
> - 导出后**自动恢复接单**（`?keepDrained=1` 保留 drain）；导入成功后自动恢复接单并返回 `.bak` 备份目录；
> - `db` 以 ESM live binding 导出（`reopenDb()` 换绑），store 层**禁止模块级 prepared statement**；
> - 旧库 0→1 迁移：boot 时把 `sessions.session_file` / `snapshots.file_path` 的绝对路径归一化为相对路径。

### 32.1 问题定义

网关的全部状态分两层，都住在 `GATEWAY_DATA_ROOT` 下：

| 层 | 内容 | 载体 |
|---|---|---|
| 索引层 | 租户/会话元数据/用量/快照索引/钩子与回调订阅/HTTP 工具/幂等键/审计 | `gateway.db`（SQLite） |
| 内容层 | 会话 JSONL、workspace 文件、快照文件、agentDir（models.yml/agents/skills/extensions/approval-cache.db/agent.db） | `users/<uid>/…` 与 `global/` |

用户的诉求：**未来换机器/换目录时，"迁移数据库"即完成整个环境迁移**。这要解决三件事：

1. **绝对路径问题（当前阻断项）**：DB 里存的是绝对路径——
   `sessions.session_file`（`routes/session/create.ts`、`session-import.ts`、`touchSession`）与
   `snapshots.file_path`（`snapshot-service.ts` 的 `dest`）都写入 dataRoot 下的绝对路径。
   dataRoot 一换，全部失效。
2. **原子对应问题**：只拷 `gateway.db` ≠ 迁移（内容层在树里）；只拷树 ≠ 迁移（DB 里有索引）。
   两者必须作为一个**可迁移单元**成对搬移，且导出瞬间要一致。
3. **driver 可替换问题**：未来可能换 PG。换引擎不能改变"可迁移格式"。

### 32.2 设计原则与可迁移单元

**可迁移单元（portable unit）= dataRoot 整棵树**，其中 `gateway.db` 以 `VACUUM INTO`
一致性快照的形式随树打包。三条不变式：

- **INV-1（路径自包含）**：DB 内所有指向 dataRoot 内文件的路径一律存 **POSIX 相对路径**
  （相对 dataRoot，`/` 分隔）。读取端经统一 codec 解析到当前 dataRoot——树搬到任何机器、
  任何 `GATEWAY_DATA_ROOT` 都直接可用。
- **INV-2（成对原子）**：导出物（bundle）内 `gateway.db` 快照与文件树取自**同一静默窗口**，
  manifest 记录对账计数；导入端校验后才切换。
- **INV-3（格式与引擎解耦）**：SQLite bundle 是**权威可迁移格式**；未来 PG 只是运行时引擎选项，
  PG 模式下 import/export 仍物化为 SQLite bundle（PG→bundle 导出、bundle→PG 导入），
  INV-1/INV-2 不随引擎改变。

**明确不做：文件 BLOB 化进 DB**。会话 JSONL/workspace 放 DB 里看似"一个文件迁全部"，但：
体积失控（workspace 含 git 历史）、流式读写/Range 下载退化、SDK 与文件工具（read/grep/git）
都要求真实路径、备份等于整库拷贝。DB+树的组合在 INV-1~3 下已达成同等迁移体验。

### 32.3 路径规范化层（path codec，INV-1 的实现）

`core/paths.ts` 新增两个纯函数，**DB 读写路径的唯一通道**：

```
toStorePath(absPath)   → "users/u1/sessions/xxx.jsonl"   // 绝对路径 → 相对（校验必须位于 dataRoot 内）
fromStorePath(rel)     → <dataRoot>/users/u1/…           // 相对 → 当前绝对（POSIX 斜杠 → path.join）
```

**写入点改造清单**（全部经 codec）：

| 位置 | 现状 |
|---|---|
| `routes/session/create.ts` `session_file: session.sessionFile` | 绝对 |
| `routes/session-import.ts` 落盘后 `session_file: file` | 绝对 |
| `routes/session-sdk/history.ts` fork/branch/rollback `touchSession({session_file})` | 绝对 |
| `core/snapshot-service.ts` `file_path: dest` | 绝对 |

**读取点**（`fromStorePath` 解析）：`routes/session/shared.ts` `getOrRevive`、
`session-sdk/history.ts`（transcript/export/snapshot restore/materialize）、
`routes/internal.ts`（trash 找回/级联）、`jobs/trash-purger.ts`、`session-export`。

**旧库兼容**：`PRAGMA user_version` 从 0 升 1 时做一次性归一化——扫描
`sessions.session_file` / `snapshots.file_path`，绝对路径且位于当前 dataRoot 内 → 改写为相对；
位于外部的（历史遗留/自定义位置）保持原样并打 config warning。此后 boot 检查
`user_version > 代码支持` → 拒绝启动（`SCHEMA_VERSION_MISMATCH`）。

另：`workspaces` 表有 `path` 列但**从未写入**（1:1 原则下路径恒由 `userWorkspace(uid, sid)` 派生），
设计上标注为死列，不做迁移。

### 32.4 导出（`POST /internal/maintenance/export`）

`/internal/*` 已有 X-Admin-Id 门禁，导出含凭据（models.yml apiKey、hook/webhook secret 明文），
**仅限全权管理面**，响应不含任何 secret。

流程（幂等，可重复执行）：

```
1. 前置：POST /internal/drain（已 drain 则跳过）；等待活跃会话归零（轮询 registry，超时 409 GATEWAY_NOT_DRAINED）
2. 一致性：VACUUM INTO <bundle>/gateway.db          ← 与 M10 备份共用 store/db.ts 的 backupToFile
3. 打包：<bundle>/users/ + global/ 原样拷贝（会话已静默，文件不再变化）
4. manifest.json：{ formatVersion:1, dbSchemaVersion(=user_version), gatewayVersion,
   exportedAt, sourceRoot(仅信息), counts:{users,sessions,snapshots,hooks,webhooks,httpTools},
   sha256(gateway.db) }
5. 可选压缩：directory bundle 为默认；?tar=1 时用系统 tar（Win10+/Linux 自带）出单文件
6. 返回 202 {bundlePath, manifest}（异步大树的进度留 job 端点，M3 模式）
```

为什么 drain 而不仅靠 VACUUM INTO：快照只保证 **DB** 一致；JSONL/workspace 是会话进程在写的普通文件，
必须等会话静默（INV-2）。空闲回收（IdleCuller）+ `disposeSession` 让"等归零"在实际部署中是分钟级。

### 32.5 导入（`POST /internal/maintenance/import {path, confirm}`）

```
0. 前置：本实例 drain 且无活跃会话（否则 409 GATEWAY_NOT_DRAINED）；confirm:"REPLACE" 必填
1. 校验 manifest（存在/formatVersion/dbSchemaVersion/sha256 对账）→ 400 MANIFEST_INVALID
2. 原子切换：旧树改名 <dataRoot>.bak-<ts> → bundle 内容就位（gateway.db 改名生效，
   删除伴随 -wal/-shm）→ boot 迁移（user_version）→ 会话计数对账
3. 失败回滚：删除半成品，.bak 改回
4. 成功：undrain 交由运维决定（返回当前 drain 状态），200 {counts, restoredFrom}
```

导入端点同时服务两个场景：换机部署（bundle 传到新机再调）与同机回滚（指向旧 bundle）。
`path` 限定在 `GATEWAY_BACKUP_DIR`（或新配置 `GATEWAY_IMPORT_DIR`）内，防目录穿越。

### 32.6 DB driver 抽象（未来 PG 的预留边界）

**现在不实现 PG**。M20 的领域拆分已把数据层收敛到 `core/store/*`（10 模块 + barrel），
未来引入 PG 的路径：

1. `store` 函数签名 async 化（~55 个）+ 路由层 await（机械改动，边界清晰）；
2. `db.ts` 收敛为唯一 driver 触点——当前 `routes/internal.ts`（2 处裸连接）与
   `jobs/trash-purger.ts` 的直接 `new Database` 一并改为从 store 引入 helper（本设计落地时顺带完成）；
3. DDL 双份（`strftime→now()`、`AUTOINCREMENT→GENERATED`、备份 `VACUUM INTO→pg_dump`）；
4. `GATEWAY_DB_DRIVER=sqlite|postgres` + `GATEWAY_DATABASE_URL`；
   approval-cache.db / agent.db 是 SDK 拥有的 SQLite 文件，**不属于** driver 抽象范围，随树迁移。

INV-3 保证：无论引擎，"迁移 = 搬 bundle"，运维手册不因 driver 而分叉。

### 32.7 运维手册（目标态）

| 方式 | 步骤 | 适用 |
|---|---|---|
| A. 树直拷 | 停旧机 → `rsync dataRoot` → 新机设 `GATEWAY_DATA_ROOT`（路径可不同）→ 启动 | 冷迁移/同构部署 |
| B. bundle | 旧机 export → 传输 → 新机 import（先 drain） | 热迁移/定期演练 |
| C. 容灾 | 既有 `GATEWAY_BACKUP_DIR` 定时 VACUUM INTO 保留；export 与其共用快照函数 | 备份恢复 |

### 32.8 端点与错误码增量

| 端点 | 语义 |
|---|---|
| `POST /internal/maintenance/export` | drain → 快照 + 树打包 + manifest → 202 {bundlePath, manifest} |
| `POST /internal/maintenance/import {path, confirm}` | 校验 → 原子切换 → 200 {counts}；失败自动回滚 |

新错误码：`MANIFEST_INVALID`(400)、`SCHEMA_VERSION_MISMATCH`(400，import 与 boot 双向检查)、
`GATEWAY_NOT_DRAINED`(409)、`BUNDLE_INCOMPLETE`(400，sha256/计数对账失败)。

### 32.9 验证计划

- **e2e 迁移用例**（新 `test/env-migration.test.ts`）：实例 A 造环境（用户/会话含 turn/快照/钩子/webhook/HTTP 工具）
  → export → 用**不同的 dataRoot 路径**起实例 B → import → 断言：会话列表与详情、revive 后 prompt 链路、
  usage 汇总、钩子/回调订阅、trash 全部一致。
- **单元**：path codec round-trip（含 Windows 反斜杠）；旧库绝对路径 boot 归一化；`user_version` 前向拒绝。
- **回滚演练**：import 中途注入失败（manifest 篡改）→ 断言 .bak 恢复、实例可用。

## 33. 容量评估：10 并发用户（M21 分析）

### 33.1 结论

**10 用户并发不需要架构改动**——默认配置（全局流式槽 50 / 每用户 maxConcurrent 5 / maxSessions 50）
本就按此量级设计，多租户隔离（私有 agentDir/AgentRegistry/Settings 隔离实例）与并发闸门已就位。
实测见 33.3。需要做的只有两个小加固 + 一个常驻验证测试。

### 33.2 逐维度评估

| 维度 | 现有机制 | 10 用户占用 | 评估 |
|---|---|---|---|
| 流式并发 | StreamingGate：全局 50 槽 / 每用户 5；超限 FIFO 排队 60s→429 | 10×2 并发 turn ≈ 20 槽 | 余量充足 |
| SSE 长连接 | 每连接 10s 心跳；断开仅解绑订阅 | 10 用户 × 数会话 ≈ 数十连接 | Bun 单进程数千连接量级，无压力 |
| SQLite 写入 | WAL 单写者；**进程内单线程同步语句天然串行**（无锁竞争）；写入均为索引点查 | usage/audit/touch 每秒几十条封顶 | 无压力 |
| 内存 | live AgentSession 常驻；IdleCuller 回收「无订阅者且 idle>30min」 | 10 用户 × 3-5 会话 ≈ 30-50 live | 正常；大上下文会话多时观察 RSS |
| 冷启动 | 首次请求触发 UserContext 物化（scaffold+settings+registry，异步） | 每用户一次性数百 ms，之后缓存 | 已被实测覆盖（p95 尖峰来源） |
| 事件循环 | 唯一同步阻塞点 = VACUUM INTO（备份/未来 §32 导出） | 10 用户 DB 为 MB 级 → ms 级 | 无感；DB 上 GB 后挪低峰 |

### 33.3 实测（test/load-smoke.test.ts，离线）

10 用户 × 两波并行（第二波在第一波 SSE 未断开时叠加），每用户轨迹：
建会话×2 → SSE 建连+首帧 → bootstrap/status → inject → 文件+git commit → prompt（预期 409）→ 快照 → 删除。

```
140 次计时操作：p50 = 5ms，p95 = 251ms，max = 705ms
healthz/readyz 全程 200；全部 185 个断言通过
```

p95 尖峰 = 各用户首次请求的 UserContext 一次性物化，非并发瓶颈。
该测试进入串行套件（27 文件），作为并发回归门禁常驻。

### 33.4 本轮加固

1. `PRAGMA busy_timeout = 5000`（store/db.ts）：防外部读者（备份拷贝 / §32 导出）短暂持锁时报 SQLITE_BUSY；
2. 并发冒烟测试常驻（见上）。

### 33.5 何时需要重新评估

- **用户数 ×10（≈100）**：触发分片预案（§1 user→shard 路由 + /internal/drain，状态全按 user_id 落盘，多实例无代码改动）；
  或按 §32 路径引入 PG 做共享元数据。
- **DB 上 GB / 备份窗口有感**：VACUUM INTO 挪到子进程或低峰。
- **内存水位告警**：调低 `GATEWAY_SESSION_IDLE_TTL_MS` 或收紧每用户 `maxSessions`（环境变量，无需改码）。

## 34. 契约与文档体系（M22）——OpenAPI 全量操作级描述 + 派生索引

### 34.1 OpenAPI 从骨架到可消费契约

原 `/openapi.json` 只内省出 path+method（无摘要、无参数、无响应模型），集成端无法据此写客户端。
本轮把契约升级为**可直接生成客户端**的形态：

| 维度 | 之前 | 现在 |
|---|---|---|
| 摘要 | 5 档族级兜底（55 个操作是"会话能力面"这类泛化描述） | **193/193 操作级摘要**（覆盖率 100%） |
| 查询参数 | 仅路径参数 | 28 组端点声明查询参数（status/page/types/since/limit/format/refresh/confirm…） |
| 请求体 | 无 | 16 个端点带 JSON Schema（prompt/inject/businessEvent/approvalDecision/createSession/webhookRegister/hookRegister/httpToolRegister/modelsConfigJson/agentDefinition/modelRef/migrationImport 等） |
| 响应 | 统一 `type: object` | **43 个响应模型**（Session/SessionList/SessionState/Bootstrap/EventReplay/ProviderList/WebhookList/HookList/HttpToolList/Snapshot/GitStatus/FileContent/AuditPage/UserSummary/BundleManifest…） |
| 错误码 | 仅 `x-gateway-error-codes` 映射 | 操作级 `responses` 挂专属 code（409 MODEL_UNAVAILABLE / 429 STREAM_QUEUE_TIMEOUT / 413 PAYLOAD_TOO_LARGE…） |
| 标签 | 5 个粗粒度 | **13 个领域标签**（session-core / conversation / observe / panel / agent / workspace / tools / config-models / config-automation / config-discovery / internal / admin / ops） |

数据结构上从"一张大对象"拆成 5 张查表：`SUMMARIES` / `QUERIES` / `BODIES` / `ERRORS` / `RESPONSES`
（+ `RESPONSE_SCHEMAS` 响应模型）。新增路由时补表即可，合约测试守住覆盖率。

### 34.2 自省与门禁

- `x-gateway-coverage`：运行时输出 `{operations, documented, summaryCoverage, queryParams, responseModels, tags}`，
  集成端与 CI 都能直接读覆盖率。
- `test/detailed-endpoints.test.ts` 断言：`summaryCoverage === 1`、`documented === operations`、
  每个操作都有标签与 401 错误面、响应模型存在、查询参数已声明。**新增路由漏登记摘要 → 测试立刻红**。

### 34.3 派生文档

`docs/endpoint-index.md` 由运行时 openapi 派生（`bun run docs:endpoints`）：193 个操作按标签分组，
带说明与查询参数。好处是文档不会与实现漂移——路由一改，重新生成即可。

### 34.4 SOP 补强

`docs/SOP.md` 增加第 8 章**任务手册**（按"要做什么"查步骤）：
新用户开通模型 / 集成端最小闭环 / 暴露业务函数为 agent 工具 / 决策点拦截 /
审计取证 / 扩容限额。每条都是可直接执行的命令序列。

**验证**：`bun run lint` 0 诊断 · `bun run typecheck` 0 error · `bun run test` 296 pass / 0 fail（28 文件）。

## 35. 镜像瘦身（M23/M24/M25）——多阶段构建，3.86GB → 1.65GB

### 35.1 第一轮（M23）：构建期浪费

单阶段镜像 3.86GB，其中约 **1.7GB 是可回收的构建期开销**：

| 项 | 单阶段 | 处置 | 省 |
|---|---:|---|---:|
| bun 依赖下载缓存 `/opt/bun/install/cache` | 514MB | builder 装完即删（与 node_modules 内容重复） | 514MB |
| `chown -R /app/gateway` 层 | 540MB | 改 `COPY --chown`（overlayfs 上 chown 会 copy-up 整棵子树） | 540MB |
| 构建期工具链（build-essential + python3-dev） | 364MB | 只在 builder 阶段装（omp 原生模块是预编译的） | 364MB |
| devDependencies（typescript/bun-types/biome） | ~14MB | builder 全量安装做 typecheck，runtime 只装生产依赖 | 14MB |
| omp 交互式 TUI/浏览器前端依赖 | ~97MB | lucide-react / react / react-dom / puppeteer-core / chromium-bidi —— 网关是 headless 服务，SDK 主链路不 import | 97MB |
| node 的 C++ 头文件 `include/` | 56MB | 编译原生插件才需要，运行期无用 | 56MB |
| 独立 conda `omp` 环境（python 3.12 + pip） | 271MB | 与基础镜像 python 重复；改用 base conda + 独立 uv（uvx 自管 Python 版本） | 271MB |

**结果：3.86GB → 2.14GB（-44%）**。

### 35.2 第二轮（M24）：继承来的层 + 看不见的符号

2.14GB 里已没有"我们自己的浪费"了——剩下的两块是**基础镜像自带的**和**二进制里的调试信息**：

| 项 | 体积 | 处置 | 省 |
|---|---:|---|---:|
| 官方 `continuumio/miniconda3` 自带的 apt 层：mercurial / subversion / python3.13 / libglib2.0 / libsm6 / libxext6 / libxrender1 / procps / wget | 208MB | 改为 `debian:trixie-slim` + **同一份 Miniconda 安装包**（版本 + sha256 固定） | ~160MB |
| conda 的二进制与共享库带 `-g` 构建：DWARF + `.symtab`（libpython 与 python 本体各 28MB、libstdc++ 12MB…） | 103MB | `strip --strip-unneeded` | 103MB |
| node 22 官方二进制自带 `.symtab`(13MB) + DWARF(2MB) | 15MB | 同上 | 15MB |
| conda `share/doc` + `share/man`（其中 gettext 一家 13MB） | 25MB | 纯文档 | 25MB |
| `@oh-my-pi/*/dist/types`（1577 个 `.d.ts`） | 20MB | 运行期走 `package.json` 的 `import` 条件（指向 `src/*.ts`）；typecheck 已在 builder 完成 | 20MB |
| puppeteer-core 移除后残留的传递依赖（devtools-protocol / @puppeteer / webdriver-bidi-protocol） | 5MB | 一并删 | 5MB |
| npm 自带 docs + man | 2.7MB | `npm help` 用不到 | 2.7MB |

**结果：2.14GB → 1.79GB（再 -16%）**；累计 **3.86GB → 1.79GB（-54%）**。
压缩拉取体积 579MB → 494MB，解压后 1.5GB → 1.3GB。

两项关键判断的**依据**（不是"看起来没用"）：

- **换 base 安全**：conda 版本（26.7.1）、python（3.14.7）、包管理器行为与官方镜像完全一致——同一份 installer，sha256 固定。
  差异只在不再预装 conda 官方示例用的 GUI / 版本控制依赖；顺带摆脱该镜像的停更告示（Deprecation）。
- **strip 安全**：动态链接器只查 `.dynsym`（strip 不动它），DWARF/`.symtab` 只供 gdb 与符号化。
  剥离后实测：python C 扩展（`_ssl`/`_sqlite3`/`_ctypes`/`_hashlib`）导入正常、`pip install`（网络 + SSL）成功、
  `conda list` 正常、node/npm/bun/uv 版本与执行正常。

### 35.3 第三轮（M25）：装完就没人执行的残留

这一轮的原则：**只删"没有任何代码路径会执行它"的文件**，凡是会话里可能用到的工具/库一律保留
（`xgettext`、`sqlite3` CLI、`tkinter`、pip 源编译所需的 `include/` 全部留着）。

| 项 | 体积 | 是什么 | 为什么可以直接删 |
|---|---:|---|---|
| `/opt/conda/_conda` | 59MB | Miniconda 安装器自带的 standalone conda（PyInstaller 打包的完整 python+conda 副本） | 不在 conda 的包清单里（安装器残留）；conda 本体不调用它。删后实测 `conda --version` / `conda list` / `conda create -n x --dry-run`（真拉 repodata 求解）全部正常 |
| `share/info` + `share/locale` | 7.5MB | GNU info 文档、命令行消息翻译 | 前者纯文档；后者在 `LANG=C.UTF-8` 下永不命中（只影响多语言提示） |
| `idlelib` | 4MB | IDLE 图形编辑器 | 容器内无显示，本来就不可能运行 |
| `lib-dynload/_test*`、`xxlimited*`、`pcre2test`、`nghttpx` | 4.3MB | CPython 自测扩展、pcre2 测试程序、nghttp2 演示代理 | 对应的库本体都保留，删掉的只是测试/演示可执行体 |
| `site-packages/**/tests` | 2.5MB | 各 Python 包的测试套件 | 运行期不会被 import |

**结果：1.79GB → 1.65GB（再 -8%）**；累计 **3.86GB → 1.65GB（-57%）**。压缩拉取 494MB → 430MB，
解压后 1.3GB → 1.2GB。

**另一条已经确认"不能动"的**：`pi-natives` 的 modern/baseline 两份 `.node` 是 **AVX2 / 非 AVX2 的 CPU 变体**，
不是平台变体。删掉 baseline 不会"变慢"——native 加载失败时 `native/index.js` 走 `missingNativeClass()`，
PTY / shell / 高亮会直接不可用。要保住"任何 x86-64 Linux 主机都能跑"，这 124MB 必须留。

### 35.4 结构

```
base (debian:trixie-slim)  ──┬─→ builder：全量依赖 → typecheck → 生产依赖 + 剔除 → strip node
   + Miniconda（同层 strip）  └─→ runtime：bun/node 二进制 + conda + uv + 生产依赖（COPY --chown）+ src
```

### 35.5 两条 overlayfs 铁律（本轮踩到的坑）

1. **whiteout 不减体积**：在被删文件所在层之后的层里 `rm`，只往文件系统加 whiteout，字节仍留在下层。
   所以"剔除"必须与"创建"同层（或在更早的层）。
2. **copy-up 会加倍**：在后续层**原地修改**文件（`chown -R`、`strip`、追加写）会把整个文件复制进新层，
   旧副本仍在下层。本轮实测：strip 放在独立 `RUN` 时镜像**反而涨到 2.2GB**（1.3GB 合并视图 + 两层各存一份
   的 333MB ELF）；并进 conda 安装那一层后降到 1.79GB。

结论：凡是"装完再改"的优化，都必须塞进创建该文件的那一个 `RUN` 里。

### 35.6 验证

- 容器验收 **15/15**（健康/会话/注入/bootstrap/文件读写/openapi/导出导入往返）
- **真实模型会话**：prompt 202 → `bash` 工具真实调用 → `turn.completed` → 回复 `omp-ok`
- **镜像内跑完整测试套件**：`255 pass / 41 skip / 0 fail`（296 项，28 文件）——41 项是需要真实模型凭据的 e2e，自动跳过
- 四套运行时在登录 shell 下均可达：python 3.14.7 / conda 26.7.1 / pip 26.2.1 / uv 0.13.8 / uvx / node 22.14.0 / npm 10.9.2 / bun 1.4.4 / git 2.47.3

### 35.7 剩余体积的构成（1.65GB）与"故意不动"的清单

| 项 | 体积 | 为什么不动 |
|---|---:|---|
| pi-natives-linux-x64 的 modern + baseline 两份 `.node` | 248MB | 两份都已无符号可剥（text 75MB + rodata 31MB/份）。loader 按 AVX2 选 `modern`，并在 `TypeNotFound` 等场景回退 `baseline`（`loader-state.js`）——删 baseline = 老 CPU/异常主机直接不可用 |
| conda（python 3.14 + conda/pip/rattler/libmamba） | ~333MB | 要求保留 `conda` 命令语义；换 micromamba 会改命令面 |
| node 22 + npm | 117MB | npm 生态 MCP server 需要（`npx`） |
| bun | 107MB | 网关运行时 |
| uv / uvx | 38MB | Python 侧包管理 |
| omp CLI 打包产物 `dist/cli.js` | 19MB | `rpc-client` 与 legacy 插件兼容路径会解析它；删掉等于砍 RPC 与旧插件兼容 |
| Debian 系统层（git 25MB + perl 55MB + glibc/ssl…） | ~185MB | git 依赖 perl；删 perl 会坏 `git add -p` / `send-email` / `svn` |


## 36. 包管理器镜像源（M26）——启动期注入，内网可部署

内网部署时只有 **conda / pip / npm** 镜像；uv 的默认索引与 Python 解释器下载（GitHub release）都不可达。
而网关跑的是**会话**：agent 会在会话里 `pip install`、`npx`、`uvx`、`conda install`。
所以镜像源必须是**运行时**可配的，不能烘进镜像。

### 36.1 落地位置

| 落地 | 覆盖 | 备注 |
|---|---|---|
| `~/.config/pip/pip.conf` | pip（含 venv 内的 pip） | 必须有 `[global]` 段头——缺了 pip 报 `File contains no section headers` 并拒载（实测踩到） |
| `~/.npmrc` | npm / npx | `registry=` |
| `~/.config/uv/uv.toml` | uv / uvx | uv **不读** pip.conf，要单独写：`[[index]]`、`python-install-mirror`、`python-downloads`、`system-certs`、`allow-insecure-host` |
| `~/.condarc` | conda | `channels` + `default_channels`（后者让 `defaults` 这个别名也指向镜像，否则会回落到 repo.anaconda.com） |
| `~/.config/omp/env.sh` | 登录 shell | uv 只认环境变量；`/etc/profile.d/zz-omp-env.sh` 在末尾 source 它，`docker exec bash -l` 与 agent 的 bash 工具看到同一套 |

入口是 `docker/omp-entrypoint.sh`，以 `exec "$@"` 收尾——进程结构仍是 tini → bun（单进程），
SIGTERM 优雅关停与退出码不受影响。

### 36.2 三个设计判断

1. **启动期而不是构建期**：这些源只作用于会话里现装的包；构建期烘死的只有网关自己的 node_modules 与 conda base。
2. **文件 + 环境变量双写**：文件覆盖"不继承 env 的登录 shell / 子进程"，env 覆盖"只认环境变量的 uv"。
3. **一律可选**：任一变量未设置就完全不落文件（默认行为与公网部署一致，验收 15/15 不受影响）；
   配置文件权限 `600`，因为源地址里可能带 token。

### 36.3 与 uv 有关的两个坑（实测）

- `UV_NATIVE_TLS=1` 在 uv 0.13.8 已弃用（告警建议 `UV_SYSTEM_CERTS`）→ 改写 `system-certs = true`，无告警。
- `uv python install` 的下载源是 GitHub release：内网必须 `UV_PYTHON_INSTALL_MIRROR` 或 `UV_PYTHON_DOWNLOADS=never`。
  `uvx --python 3.14 …` 用镜像自带的 conda python，无需下载（实测装上并运行了 pygments）。

### 36.4 验证

- 内网全配：四个配置文件内容/权限正确；`pip download` 首行显示内网 index；`npm view` 命中镜像；
  `uvx --python 3.14` 成功；`uv python install 3.12` 快速失败并提示 `Python downloads are not allowed`。
- 完全不配：五个配置文件均不存在，容器 `readyz` 正常、验收 15/15。

## 37. 运行期权限模型（M27）——workspace 777，凭证仍在边界内

镜像要作为 **omp 运行时**交给会话用，宿主机还要能直接读改会话产出。宿主机 uid 与容器内
uid（1000）不一致是常态，所以权限不能靠"uid 对齐"，只能靠显式模式。

| 对象 | 模式 | 谁需要写 |
|---|---|---|
| `/workspace`（宿主挂载根） | **777**（镜像内 chmod；启动脚本再兜一次，改不动只告警） | 宿主机 + 容器 |
| `<dataRoot>`、`users/<uid>`、`users/<uid>/workspaces/<sid>` | **777** | 同上（session workspace 由 `prepareWorkspace` 显式 chmod） |
| 容器内新建的文件（agent 写出的代码/文档） | **666**（`OMP_UMASK=0000`） | 宿主机 + 容器 |
| `<dataRoot>/users/<uid>/agent`（凭据、models.yml） | **700**（代码显式设置） | 只有容器用户 |
| `.omp-*` 配置（pip.conf/.npmrc/uv.toml/.condarc/env.sh） | 600 | 只有容器用户 |

要点：

1. **umask 只在启动脚本里设**（`OMP_UMASK`，默认 `0000`），所以"容器新建的东西宿主机都能改"是默认行为；
   想收紧用 `OMP_UMASK=0027`（文件 640 / 目录 750），根目录仍 777。
2. **凭证边界不随 umask 打开**：SDK 的 `agentDir` 是显式 `0o700`，`chmod` 式显式模式不受 umask 影响——
   世界可写的是工作产出，不是 API key。
3. **SQLite 的 DB 仍是 644**（SQLite 自己按 0644 建文件）：别人能读、不能写；
   要改它就等于能删它——而挂载根 777 已经意味着这一点，所以这不是新的暴露面。
4. **Docker Desktop 的挂载本来就是 777**（Windows/macOS 由 VM 映射），这条规则主要照顾 Linux 宿主；
   宿主目录是 `root:755` 时容器内 chmod 会 EPERM，脚本告警，需宿主侧执行一次 `chmod 777`。

### 37.1 777 的含义边界：共享挂载卷，不是控制宿主机

777 说的是**挂载点这棵目录树内的文件共享**，不是"容器能操作宿主"。两件事要分开看：

**（1）777 给了什么**——宿主机上的任意用户都能读写这棵目录里的会话产出。

bind mount 的两端是同一个 inode，所以容器内 `chmod 0777 /workspace` 会**同步改到宿主目录的模式**。
这正是目的：宿主侧的工具（另一个 uid 的脚本、同步程序、编辑器）不用跟容器内 uid 1000 对齐就能直接改会话产出。

**（2）777 没给什么**——宿主本身的任何控制权。隔离由 Docker 提供，与文件模式无关：

| 隔离项 | 实测值 |
|---|---|
| 特权模式 | `Privileged=false` |
| 额外 capability | `CapAdd=[]`；会话进程 `CapEff=0x0`（连 `CAP_DAC_OVERRIDE` 都没有，所以文件模式就是硬边界） |
| 宿主挂载点 | 只有 `/workspace` 一个（bind，rw）；无 `/var/run/docker.sock`、无 `/host`、无 `/proc/1/root` |
| PID 命名空间 | 独立（容器内只看得到自己的进程） |
| 会话用户（uid 1000）在容器内可写的位置 | 仅 `/workspace`（= 宿主挂载卷）、`/opt/conda`、`/opt/node`、`/home/omp`（后两者是刻意让 agent 能装包）；`/`、`/etc`、`/root`、`/var`、`/usr`、`/app` 都不可写 |

也就是说：**777 让宿主机与容器共享一棵目录的内容，不让容器越出这棵目录**。要进一步收紧，
把 `WORKSPACE_ROOT` 挂到更小的子目录即可（只有那棵子树是共享面）。

## 38. 知识库（KB）模块（M28）——管理面进网关，查询走 omp 原生

> 抽象自 la-sequence-script 的 Python 知识库服务（FastAPI + SQLite + LanceDB + MCP）。
> 目标态：管理面（上传/文档树/删除）进网关 Bun 进程；查询不建任何检索服务——语料放全局
> skill 目录，agent 原生 grep/read；向量路（LanceDB/embedding/hybrid 融合）整体取消；
> 截图/取图/MinIO 由 skill 自带 Python 脚本承担，网关零 PDF 渲染、零 minio SDK。

### 38.1 上游契约：MinerU ParseOutcome zip（一包一文档）

上传物是 `mineru.parser.task_outputs.build_task_output` 的 default 档位产物：

| 文件 | 内容 | 入库处置 |
|---|---|---|
| `markdown.md` | 全文 Markdown，图片以 `images/` 相对路径引用 | 改名 `<文档名>.md`，即检索语料本体 |
| `middle_json.json` | 结构化中间结果（表格 HTML、block 树、页码、bbox） | 透传保留，`kb_shot.py` 的 bbox 来源 |
| `structured_content.json` | 面向 RAG 的结构化内容 | 透传保留（本模块不消费） |
| `images/page_N_table_M.jpg`、`page_N_image_M.jpg` | MinerU 已裁剪的表/插图 | 透传保留，**取图已经由 MinerU 完成** |

原始 PDF 不在 zip 里，走独立补传接口（§38.4）；`source.pdf` 缺位只影响截图能力，不影响查询。
docx/html/latex 档位不在本模块范围内（只用 default 档位）。

### 38.2 目录布局（全部在 dataRoot 内）

```
data/global/skills/kb-<slug>/        # 全局 skill，新会话即时可发现
  SKILL.md                           # 网关生成：查询策略 + 脚本用法（§38.9）
  kb.json                            # {_managedBy:"omp-gateway", type:"kb"} 管理标记
  docs/<doc>/
    <doc>.md                         # 语料本体；images/ 相对引用原样有效
    images/*.jpg                     # MinerU 裁剪图
    middle_json.json                 # 截图脚本的 bbox 来源
    structured_content.json          # 透传保留
    source.pdf                       # 可选（补传接口写入）
  scripts/kb_shot.py                 # 截图（pymupdf，§38.7）
  scripts/kb_asset.py                # 取图/资产上传 MinIO（§38.7）
  assets/                            # MinIO 未配置时脚本的本地输出目录
data/global/kb/<slug>.db             # bun:sqlite 元数据（§38.3）
```

- KB 数据全部落在 dataRoot 内 → §32.2 的迁移 bundle（= 整套 dataRoot）天然覆盖，
  当年「kb 服务数据放同级独立目录」的顾虑随独立服务一起消失。
- **部署面把「全局资源层」单独挂出来（M31/M32）**：compose 用两层挂载把网关私有状态与
  全局资源层分离成独立宿主机目录，便于单独备份/迁移/共享（NFS），代码路径与 skill 发现不变：

  | env | 默认 | 容器内 | 内容 |
  |---|---|---|---|
  | `GATEWAY_DATA_ROOT_HOST` | `./gateway-data` | `/workspace/.omp-gateway` | `gateway.db`（+WAL）等网关私有状态 |
  | `GLOBAL_ROOT` | `./global` | `/workspace/.omp-gateway/global` | **所有会话可见的全局资源**：`skills/kb-<slug>/`、`skills/data-query/`、`kb/<slug>.db`、`kb/qmd/{config,cache}`、`wren/<name>/`、`mcp.json`、`agents/`、`extensions/` |

  - 命名演变（M32）：该挂载最初叫 `KB_ROOT`（当时 global 层只有知识库），数据查询层接入后
    层内还有 `data-query` skill、`wren/` 项目与全局 `mcp.json`——名字会误导，故改名
    `GLOBAL_ROOT`。**它挂的是 global 整层，不是「知识库专属目录」**。
  - 为什么是两层而不是再往下挂 `global/skills` 与 `global/kb`：Docker 为子挂载自动创建的
    **父层**属主是宿主 root、权限 755，容器内 uid 1000 既写不进也无法 chmod——数据根不是
    挂载点时 `gateway.db` 直接 `SQLITE_CANTOPEN`，`global` 不是挂载点时 `ensureGlobalScaffold`
    失败（两者都实测踩到）。因此每一层要挂的目录**自身必须是挂载点**。
  - 备份 = 打包整个 `./global`（知识库部分即 `skills/kb-*` + `kb/`；其中 `<slug>.db` 含
    `-wal/-shm`，热备建议先停容器或让 WAL checkpoint）；迁移 = 拷到新宿主。
  - 权限：Docker 自动创建的空挂载源目录属主是宿主 root(755) → entrypoint 启动时从数据根
    往下逐层 `mkdir -p` + `chmod 0777`（bind mount 同步改宿主），改不动且不可写只告警
    （知识库/数据查询接口 500，其余能力不受影响）；也可在宿主机预创建并 chmod 777。
- `kb.json` 两处用途：① `/admin/global/skills` 的 CRUD **拒绝**操作带 kb.json 的目录
  （`kb-` 前缀 + manifest 是网关托管保留区，防误删语料）；② `composeKbForWorkspace` 的
  网管判定依据——fork 拷贝（fs.cp）把 junction 解引用成真目录后，靠 kb.json 仍识别为网管快照。
- **skill 发现机制勘定（实现期确认）**：omp SDK 在显式传入 `options.skills` 时**跳过项目级发现**
  （`pi-coding-agent/src/sdk.ts:2155/2430`）——kb skill 经 `loadScopedSkills`（扫 global/skills）
  注入 options.skills 即到位，**无需也不要改 loadScopedSkills**；junction 不承担 skill 发现，
  只为语料/脚本在工作区文件可达。
- 命名：slug 走 skill 名规 `^[a-z0-9][a-z0-9-]{0,63}$`，skill 名恒为 `kb-<slug>`；
  文档名 = zip 文件名词干净化 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`（作目录名与主键）。

### 38.3 kb.db schema（每 KB 一个库）

```sql
groups(id INTEGER PK, parent_id INTEGER NULL, name TEXT NOT NULL,
       path TEXT NOT NULL UNIQUE)              -- 物化路径 'A/B/C'，ensure_group 逐级建
docs(name TEXT PK,                            -- = zip 词干
     group_id INTEGER NULL REFERENCES groups(id),
     md_sha256 TEXT NOT NULL,                 -- sha256(markdown.md)，变更检测
     pages INTEGER NOT NULL DEFAULT 0,        -- middle_json.pdf_info 页数
     images INTEGER NOT NULL DEFAULT 0,       -- images/ 文件数
     has_pdf INTEGER NOT NULL DEFAULT 0,      -- source.pdf 是否已补传
     created_at TEXT, updated_at TEXT)
```

老 store.py 的 `blocks/sections/refs/terms/vectors` 全部不建：检索语料就是 md 本身，
block 级倒排/IDF 打分/章节图这些为「服务端检索」服务的结构随检索服务一起退役。

### 38.4 管理面 API（`/admin/kb/*`，X-Admin-Id，组合根挂 admin.ts）

| 端点 | 说明 |
|---|---|
| `POST /admin/kb` | 建 KB：`{slug, title?}` → skill 骨架 + SKILL.md 模板 + kb.db |
| `GET /admin/kb` | KB 列表（扫 `global/skills/kb-*` 的 kb.json） |
| `POST /admin/kb/:slug/upload` | multipart：zip（一包一文档）+ 表单 `group=A/B/C`（缺省归根）；zip-slip 防护（沿用 ingest.py 词法检查）；解压落 `docs/<doc>/`，`markdown.md`→`<doc>.md`；同名重传 = 先清旧目录再落（覆盖更新） |
| `POST /admin/kb/:slug/pdf` | multipart：pdf + 表单 `doc=<文档名>` → `docs/<doc>/source.pdf`，`has_pdf=1` |
| `GET /admin/kb/:slug/pdf/:doc` | 前端取原始 PDF（整文件返回，`application/pdf`） |
| `GET /admin/kb/:slug/tree` | 分组树 + 文档卡片（pages/images/has_pdf/group path） |
| `DELETE /admin/kb/:slug/doc/:doc` | 删文档（目录 + db 行联动） |
| `DELETE /admin/kb/:slug` | 删 KB（整 skill 目录 + kb.db；workspace 残留 junction 由下次合成重算清理） |

- 上传体上限独立声明：`KB_UPLOAD_MAX_MB`（默认 2048），不借用 `/api` 的 20MB 全局面限制。
- 所有写操作 `audit()`（沿用 admin.ts 现行审计）。

### 38.5 会话期合成（照 agent-compose 范式）

`prepareWorkspace` 增加 `composeKbForWorkspace`：

1. 对每个 `global/skills/kb-<slug>`（含 kb.json），在 workspace `.omp/skills/kb-<slug>` 建
   **junction/symlink** 指向 skill 目录绝对路径（Windows junction 免特权；Linux 符号链接），
   语料与脚本在工作区文件可达，agent 的 grep/read/bash 直接作用于该路径。
2. manifest `.omp/skills/.kb-composed.json` 记账（仿 `.gateway-composed.json`）：KB 删除后
   下次建会话重算清理（stale）；存在网关未管理的 kb-* 条目（非链接且不含 kb.json）→ 整体跳过。
3. skill 本体经 `loadScopedSkills` → options.skills 注入（见 §38.2 勘定）——junction 与发现
   互不依赖；fork 拷贝把链接解引用成真目录时，含 kb.json 的快照保留不重建（自含语料仍可用）。
4. 语义与全局资源一致：**变更对新会话生效，活跃会话保留原状**。

### 38.6 查询面：omp 路由的 grep × qmd 双路组合（M29 建面 / M35 改组合）

- **双路组合**（M35 修订，SKILL.md 教给 agent；判断权在 omp）：
  - **grep 工具**（omp 内置，pi-natives 原生 ripgrep 引擎，不依赖系统 `rg` 二进制）：
    词面可预测的锚点（寄存器/参数名、命令、缩写、错误串、表格编号）→ 直接定位行号，毫秒级，永远可用；
  - **qmd**（lex/vec/hyde 混合排名）：语义/换说法问题（自然语言描述、因果/流程类）→ 定位文档/章节；
  - **路由判断由 agent 按问题形态做**，不是固定先后；三种组合套路（qmd 定域→grep 定行 /
    grep 破冰→qmd 扩面 / 双路并行）写进 `references/retrieval.md` 决策矩阵。
  - M29 的"qmd 优先、grep 兜底"退役：单文档知识库里 qmd 只给文档级结果，行号始终靠 grep——
    把 grep 降级为兜底会诱导 agent 在 grep 就能秒答的场景先绕道 qmd。
- **可用性降级链**（M29 引入，继续有效）：qmd MCP 工具（`collections=["kb-<slug>"]` 定域，
  返回 `qmd://kb-<slug>/docs/...` URI → 映射 `.omp/skills/kb-<slug>/docs/...`）→ CLI
  （`qmd --index kb search/vsearch`）→ 纯 grep（qmd 缺失/索引未建时，能力不缺只是没有增强排名）。
- 引用仍带文档名 + 页码（MinerU 命名 `page_N` 即 PDF 第 N 页，md 与图名天然带页码语义）。
- 无自建检索服务、无打分管线——旧 search.py 的 rg 语料/行映射/IDF×TF/融合全部退役。
- 老 `/kb/search`、`/kb/agent`（CrewAI）不迁移：需要检索能力的业务方自己起 omp 会话
  （决策层在调用方，与旧设计 §1 拍板一致）。

### 38.7 出图：skill 自带 Python 脚本，网关零渲染

| 脚本 | 功能 | python 依赖 |
|---|---|---|
| `kb_shot.py --doc <名> --page N [--table M \| --image M \| --bbox x0,y0,x1,y1]` | 从 `source.pdf` 按 middle_json 的 bbox 高保真重渲染 → PNG（MinerU 裁剪质量不够时的兜底） | pymupdf |
| `kb_asset.py --doc <名> --image <images/ 下相对路径>` | 已有裁剪图 → MinIO 上传 → 输出公网 URL（内容寻址 key：sha256 前 16，跨文档同图去重） | minio |

- 输出统一 JSON 到 stdout：`{"url": "https://…"}` 或 `{"path": "<assets/ 下本地路径>"}`，
  SKILL.md 教 agent 解析并引用。
- **MinIO 未配置**（`KB_MINIO_ENDPOINT` 缺省）→ 两个脚本都落 `assets/` 本地路径；
  agent 在 workspace 里可直接引用该路径。
- `pymupdf`/`minio` **构建期烘进镜像**（Dockerfile runtime 层 `pip install`，内网构建经
  build-arg `PIP_INDEX_URL` 传镜像源；compose 已透传）——会话内 `python scripts/kb_shot.py`
  开箱即用。`KB_SKILL_PY_DEPS=1` 保留为 entrypoint 运行时兜底（旧镜像/精简构建）；
  网关进程自身零 PDF/minio 依赖。运行时 apt 层另加 `jq`（agent 解析结构化 JSON 高频用）。

### 38.8 env（容器启动配置，脚本直读）

| 变量 | 说明 | 缺省行为 |
|---|---|---|
| `KB_MINIO_ENDPOINT` | MinIO 写入端点（内网，如 `minio:9000`） | 脚本落本地 `assets/` |
| `KB_MINIO_ENDPOINT_PUBLIC` | 输出 URL 拼接端点（外网）——上传走内网 ENDPOINT、报告贴的 URL 用这个基址重写 | 缺省 = ENDPOINT（URL 内网化，外网不可达） |
| `KB_MINIO_ACCESS_KEY` / `KB_MINIO_SECRET_KEY` | 凭证 | — |
| `KB_MINIO_BUCKET` | 桶名，自动建桶 + 公共读 policy | `kb-assets` |
| `KB_MINIO_SECURE` | "1" → https 连接 MinIO | http |
| `KB_UPLOAD_MAX_MB` | upload/pdf 路由 body 上限 | 2048 |
| `KB_SKILL_PY_DEPS` | =1 时 entrypoint 兜底安装 pymupdf+minio（镜像已内置，通常直接命中「已就绪」） | 不装 |
| `KB_QMD_BIN` | qmd 可执行文件路径 | `qmd`（PATH 查找） |
| `KB_QMD_INDEX` | qmd 命名索引名（白名单校验） | `kb` |
| `KB_QMD_MCP` | =1：entrypoint 起 qmd MCP daemon + 网关注册全局 mcp.json | 不启用 |
| `KB_QMD_EMBED_BASE_URL` / `KB_QMD_EMBED_API_KEY` / `KB_QMD_EMBED_MODEL` | 远程 embedding 三件套（OpenAI 兼容；ark doubao / 自建 ollama），qmd patch 消费 | 未配置 = 本地 GGUF |
| `KB_QMD_EMBED_BATCH` | 远程 embedding 批大小 | 16 |
| `QMD_CONFIG_DIR` / `XDG_CACHE_HOME` | qmd 配置与缓存根（compose 指到 dataRoot 内） | qmd 默认（~/.config、~/.cache） |

网关不解析 KB_MINIO_*（零 minio SDK）：docker-compose 注入 → 容器 env → 会话 bash
子进程直接继承 → 脚本读取。entrypoint 另做一条连通性告警（沿用 §37 的告警风格，只告警不阻塞）。

### 38.9 SKILL.md 模板（网关生成，标准 skill 形态）

按 skill-creator 规范（metadata → body → references 三层渐进披露）：

```
global/skills/kb-<slug>/
├── SKILL.md                  ~55 行：何时用/不用、三步检索流程、引用示例、目录结构、参考文件索引
├── kb.json                   管理标记
├── references/               按需读取（不预读）
│   ├── retrieval.md          双路对照/路由判断/三种组合套路/grep 工具参数/qmd MCP+CLI/无响应处置/迭代准则
│   ├── pagination.md         双页码语义（印刷页 vs PDF 物理页）、pages.txt 三列用法、middle_json
│   └── imaging.md            kb_shot/kb_asset 用法、输出 JSON 形状、MinIO/本地交付
├── scripts/{kb_shot,kb_asset}.py
├── docs/                     语料（检索对象）
└── assets/                   出图输出
```

- **frontmatter**：`name: kb-<slug>`（与目录名一致、kebab）；`description` 是唯一常驻上下文的触发信号，
  写足「做什么 + 什么场景必须用」并含同义表述（标准号/章节号/「第几页」/「这张表」），略偏 pushy
  （模型倾向于**少**触发 skill）。
- **body 精简**：只留决策级信息（何时用/不用、三步流程、引用格式字面示例、文件索引）；细节
  （工具参数、页码换算、脚本参数）全部下沉 references，主体按需读取，避免每次触发都占上下文。
- **模板静态**：不含 KB 内文档清单（避免入库/删文档后失同步）。文献示例用占位（`<文档名>`）而非真实清单。
- **升级路径**：`refreshAllKbSkills()`（网关启动时）对存量 KB 重写 SKILL.md + references + scripts，
  内容一致不落盘；改模板必须重启网关才生效。

### 38.10 分期

- **M28-a**：paths 常量（`globalKbDir()`）+ kb.db + zip 透传入库 + `/admin/kb` 全部端点 + tree
- **M28-b**：`composeKbForWorkspace` + SKILL.md 模板生成（skill 发现经 options.skills，无需改 loadScopedSkills）
- **M28-c**：`kb_shot.py` / `kb_asset.py` + entrypoint 依赖安装与告警 + compose env / .env.example
- **M28-d**：openapi.ts 四表登记（`docs:check` 门禁）+ 单测（ingest/tree/命名净化）+
  集成测试（integration-scoping 式：新会话 workspace 可见 KB skill、语料可 grep）+ 文档同步
- **M29**：qmd 检索层（§38.12）——provider patch + 网关 spawn 封装与入库钩子 + MCP daemon
  与全局注册 + SKILL.md 三级检索策略 + env/compose/Dockerfile + kb-qmd 测试

### 38.11 退役对照（la-sequence-script → 本网关）

| 老件 | 去向 |
|---|---|
| store.py blocks/sections/refs/terms/vectors | 不迁移（md 即语料，检索靠 agent） |
| ingest.py doclib.db 解析 | 重写为 ParseOutcome zip 透传（上游格式已换代） |
| search.py / vector.py / agent.py / mcp_server.py | 退役，omp 原生取代 |
| screenshot.py | → `scripts/kb_shot.py` |
| storage.py（MinIO 单例） | → `scripts/kb_asset.py` |
| `/kb/tree` `/kb/groups` | → `GET /admin/kb/:slug/tree` |
| `/kb/pdf/{sha}` 补传 | → `POST /admin/kb/:slug/pdf`（按文档名） |

### 38.12 qmd 检索层（M29）——BM25+向量混合，索引随入库构建

> 检索引擎引入 [tobi/qmd](https://github.com/tobi/qmd) v2.8.3（MIT）：BM25(FTS5) + 向量语义
> 搜索 + RRF 融合，collection 管理/增量索引/900-token 智能分块/指纹失效重嵌入全由它承担。
> 查询面见 §38.6（MCP 工具 > CLI > grep 三级）。

**索引布局与生命周期**：

- 单一命名索引 `kb`（`--index kb`），每个知识库一个 collection：`kb-<slug>` →
  `global/skills/kb-<slug>/docs`。配置与缓存指进 dataRoot（compose 注入
  `QMD_CONFIG_DIR`/`XDG_CACHE_HOME` → `global/kb/qmd/{config,cache}`），随迁移 bundle 走。
- **入库即构建，update 同步 / embed 异步**（M30，全部 best-effort，qmd 缺失/失败只告警）：
  - `createKb` → `collection add`；`ingestZip`/`deleteDoc` → **同步** `qmd update`（BM25 秒级，
    上传响应返回时关键词检索已含新文档）；
  - 紧接着 `scheduleKbQmdEmbed(slug)`：**后台单飞异步** `qmd embed`（向量分钟级；同 KB 并发
    触发复用同一任务，不排队）。理由：585 页实测 embedding 约 100s，若同步等在上传请求里，
    会撞上游 60s 超时并诱发重试重复上传——改造后上传响应 1m43s → **6.3s**。
  - `ingestPdf` 不触发重建（PDF 不进文本语料）；
  - `deleteKb` → `collection remove`。
  - 状态可见：`GET /admin/kb/:slug/index-status`（`state: idle|running|ok|failed|skipped|unavailable`
    + startedAt/finishedAt/error + `inFlight`）；`?probe=1` 额外读一次 `qmd status` 给出
    `{needsEmbedding, vectorIndex}`（进程内状态重启即失，probe 是真相源）。
  - 网关封装 `core/kb/qmd.ts`（spawn argv 数组，无 shell，slug 先过 assertSlug；
    `KB_QMD_BIN` 解析，找不到全函数 no-op）。
- **embed 三件套保护**：`KB_QMD_EMBED_BASE_URL/API_KEY/MODEL` 齐才跑 embed，否则跳过
  （BM25 即刻可用）——防止未配置时意外触发本地 GGUF 模型下载挂起。

**远程 embedding provider patch**（qmd 原生只支持本地 GGUF，不支持 API）：

- patch 交付 `gateway/docker/qmd-patch/apply.mjs`（幂等、可 `--revert`，Docker 构建期对
  全局安装执行；provider 源码内嵌）。改三处 LLM 工厂缝：`dist/llm.js getDefaultLlamaCpp()`、
  `dist/index.js`、`dist/cli/qmd.js` 的 `new LlamaCpp(...)` → 远程装饰器（三件套配置时），
  未配置时行为与原生完全一致。
- 装饰器：`embed/embedBatch` → `POST {BASE}/embeddings`（仅 http(s)、120s 超时、批
  `KB_QMD_EMBED_BATCH` 默认 16、并发 ≤4、按响应 index 保序、单批重试 2 次后整批复 null
  交 qmd 断点续跑）；`expandQuery` 退化为原查询双路（lex+vec，不用 1.7B 扩展模型）；
  `rerank` 等分（保持 RRF 序，不用 0.6B 重排模型）；`tokenize/detokenize` 启发式分词
  （qmd 分块器硬依赖 `llm.tokenize`——远程模式**绝不触 node-llama-cpp**，构造期零 import）；
  `QMD_EMBED_MODEL=api:<model>` 在工厂缝前设入 → 嵌入指纹与 doctor/status 反映远程模型。
- 首选模型 ark `doubao-embedding-text-240715`（2560 维，OpenAI 兼容 `/embeddings`），
  已端到端验证（中文/跨语言 vsearch 命中）；切自建 ollama 只改三件套 env（继承 la-sequence-script
  老 .env 的设计意图）。sqlite-vec 维度自由，2560 维直接可用。

**全局 tool 注册**（omp 会话原生可见）：

- `KB_QMD_MCP=1` 时：entrypoint 起 `qmd --index kb mcp --http --daemon`（默认 127.0.0.1:8181/mcp；
  共享 daemon 让模型只加载一次，避免 stdio 每会话重复加载）；网关启动
  `ensureQmdMcpRegistered()` 幂等写入 `global/mcp.json`：`mcpServers.qmd = {type:"http",
  url:"http://127.0.0.1:8181/mcp"}`。环回地址是部署方 env 声明的同容器内部服务（非用户可控
  URL），与 `GATEWAY_WEBHOOK_HOSTS_ALLOWLIST` 的内网信任模型一致。
- 未启用 KB_QMD_MCP 时 agent 走 CLI；qmd 缺失则纯 grep 路（§38.6 降级链保证可用性）。

**注意**：开发机 `bun install -g` 的 bin 目录（`~/.bun/bin`）可能不在默认 PATH——集成测试
（`test/kb-qmd.test.ts`，skip-if-absent 设计）与网关 spawn 都依赖 `KB_QMD_BIN`/PATH 能找到 qmd。

#### 38.12.1 实测定论：未配三件套时查询会静默挂死（M29 排障记录）

真实 JEDEC 语料（585 页 / 879 chunks）端到端时踩到并已定位：

| 条件 | `qmd vsearch` / daemon `/query` | 说明 |
|---|---|---|
| 三件套齐（ark doubao） | **1.4–2.5s 正常返回**（中文 73%/69%、混合 query 100%） | patch 生效，provider 直连 API |
| 三件套缺 | **静默挂死 45–130s+**：stdout/stderr 全空、CPU 0% | patch 不启用 → 原生本地 GGUF；node-llama-cpp 原生二进制缺失时**既不报错也不退出**，卡在模型初始化/下载 |

排除项（均实测正常，非 SQLite/代理/委托面问题）：BM25 `search` 0.15s、`get` 0.14s、
provider 独立 embed 158ms、SDK 直连 `searchVector` 231ms、`qmd status` 正常；带/不带
`HTTPS_PROXY` 结果一致（MinerU CDN 下载确需绕代理，与此无关）。

由此落地的两道门禁：
1. **entrypoint**：`KB_QMD_MCP=1` 但三件套不全 → **不启动 daemon**（告警），会话退化为纯 grep 路；
2. **SKILL.md**：提示 agent「`vsearch/query` 无响应立即放弃 qmd 改走 grep 路」——CLI 路径
   不经 entrypoint，只能靠指令层止损。

部署要求：启用 `KB_QMD_MCP=1` 或使用语义检索时，`KB_QMD_EMBED_BASE_URL/API_KEY/MODEL` 必须配齐；
只配 BM25（`qmd search`）不需要三件套。

## 39. 数据查询层（M32）——WrenAI 语义层集成，会话内自然语言问数

> 选型调研（2026-11-17）覆盖 WrenAI/DB-GPT/SuperSonic/SQLBot/vanna（已归档）/Dataherald（已死）/
> Chat2DB/SQLChat/nao 九个候选后定版：**WrenAI 新版**（agent-native 转型后）以 Apache 2.0 +
> 「omp 会话 LLM 生成 SQL、Wren 语义层校验与受控执行」的分工方式成为最优解——SQL 生成智能由
> omp 会话供给（携带完整上下文），Wren 提供治理（dry-plan 验证/行数上限/结构化错误/MDL 语义层），
> 不重复造 agent。SQLBot（单容器 MCP 问数，GPLv3 修改版）为备选；DB-GPT（MIT）为替代预案。

### 39.1 集成形态（方案 A：wrenai 烘进 omp 镜像）

- `wrenai 0.18.x` 为**纯 Python wheel（py3-none-any）**，py3.14 直接可用；Dockerfile runtime
  pip 层追加 `wrenai[mcp,postgres,clickhouse]`（同 `PIP_INDEX_URL` build-arg 源），冒烟 `wren version`。
- 会话内 agent 经 bash 直接用 `wren` CLI（建模/查询/经验沉淀），与 grep/qmd 三通道并存。
- 每个数据源 = 一个 Wren 项目 + 一个 MCP http daemon：`wren serve mcp --transport http
  --host 127.0.0.1 --port <base+i> --project <dir> --quiet`（网关 spawn，端口被监听则复用）；
  项目目录 `<dataRoot>/global/wren/<name>/`（随 GLOBAL_ROOT 卷持久、宿主可读）。

### 39.2 env 契约与启动流程

| 变量 | 说明 |
|---|---|
| `WREN_MCP=1` | 启用数据查询层 |
| `WREN_HOME=/workspace/.omp-gateway/wren` | profiles.yml 持久化（随 gateway-data 卷） |
| `WREN_DATASOURCES=pg,ch` | 数据源名列表（`^[a-z][a-z0-9-]{0,15}$`），每名一个项目+daemon |
| `WREN_DS_CONNECTIONS={"pg":{...},"ch":{...}}` | 连接 JSON（字段以 `wren docs connection-info <ds>` 为准；`datasource` 字段必需） |
| `WREN_MCP_PORT_BASE=8081` | 第 i 个数据源 daemon 端口 = base+i |
| `WREN_BIN` | wren 可执行文件解析（默认 PATH 查找） |

`ensureWrenDatasources()`（网关启动，`ensureQmdMcpRegistered` 之后，全 best-effort）：
① 读注册表 → env 种子合并（仅补缺失名，admin 条目优先）→ 全量 provision（幂等；
daemon 端口已监听则注入密钥 env 复用——v1 修过的无条件注入保留）→
② 写 connection JSON → `wren profile add <name> --from-file`（`--no-validate`：不可达主机的
默认校验会挂 ~2 分钟，校验留给查询期；profiles 支持 `${VAR}` 占位符——**密钥以
`WREN_SECRET_<名>_<字段>` 占位落盘，明文仅进程 env 传递，挂载卷 grep 无泄露**）→
③ 项目骨架 `wren context init --empty`（已存在不覆盖）→ `context set-profile` →
④ 内省 + 生成 models（见 §39.2.1；失败非致命）→ `context build`（空模型集也产出
target/mdl.json）→ ⑤ spawn daemon →
⑥ 注册 `wren-<name>` 进 global/mcp.json（`{type:http, url:http://127.0.0.1:<port>/mcp}`）→
⑦ 物化全局 skill `data-query`（SKILL.md + references/，references 内容 = `wren skills get
onboarding/usage/generate-mdl` 输出——**随安装版本自动匹配**）。

### 39.2.1 数据源管理 admin API（v2：注册表 + 运行时增删改查 + MDL 自动生成）

**注册表（唯一事实源）**：`<dataRoot>/global/wren/datasources.json`（写后 chmod 600）：

```json
{"pg": {"datasource":"postgres","connection":{...},"tables":["public.orders"]|null,
        "port":8081,"createdAt":"...","updatedAt":"...","daemonPid":123,"lastError":null}}
```

- `tables`：null/缺省 = 全部非系统表；数组 = "schema.table" 精确匹配白名单。
- `port`：创建时从 `WREN_MCP_PORT_BASE` 起找第一个「未被注册表占用且未监听」的端口，
  **写入注册表稳定复用**；`daemonPid` 供重启/删除时定点杀进程（容器重启后自然失效）。
- env（§39.2 的 WREN_DATASOURCES/WREN_DS_CONNECTIONS）= **种子**：启动合并仅补缺失名，
  已存在的 admin 条目优先；wren CLI 缺失时不写种子（避免僵尸条目）。

**内省 + MDL 自动生成（零新依赖）**：

- postgres：Bun 内置 `SQL`（`new SQL(连接串)`，连接串由注册表 connection 拼装——部署方/
  admin 提供，非用户输入）；固定常量查询 `information_schema.columns`（WHERE 排除
  pg_catalog/information_schema；无插值 → 无注入面）。
- clickhouse：HTTP POST 固定常量查询 `system.columns`（`httpPort` 缺省 8123，
  X-ClickHouse-User/Key 认证），`FORMAT TabSeparatedWithNames` 解析。
- 其余数据源类型跳过内省（空骨架路径，agent 可手动建模）；duckdb 即此类。
- `tables` 白名单过滤 → 每表一个 `models/<name>/metadata.yml`（wren schema v5 的
  directory-per-model 布局；键名以 `wren skills get generate-mdl` 为准：name /
  properties.description / table_reference{catalog,schema,table} / columns[{name,type}]）。
  **types 原样透传**（目录数据）；catalog 取连接的 database。跨 schema 同表名 → 全部加
  schema 前缀（命名基于全量目录行，与白名单收紧无关，保证模型名稳定）。
- **YAML 手写安全序列化**：所有字符串双引号 + 转义（`\ " \n \r \t`、其余控制字符 →
  `\uXXXX`）——列名/表名是目录数据，绝不进 SQL（目录查询固定常量，满足参数绑定约束）。
- 生成是纯函数（`mdlModelsFromRows(rows, tables, catalog)`），fixture 单测覆盖特殊字符。
- 业务描述/指标由会话 agent 后续 enrich（同文件补 properties.description / 关系 / 知识）；
  v3（M34）起模型生成走**按表指纹的增量**（§39.2.2）：指纹一致不落盘，指纹变化只重写
  columns/table_reference 并保留 agent enrich 的 description；注册表记 `generatedModels`
  与 `catalogHash`，已消失表的自动生成目录随收敛移除，agent 手建 model 永不删除。
  重要语义仍建议沉淀到 knowledge/（rules/ 与 sql/ 不受内省影响）。

**admin 路由**（`/admin/wren/*`，requireAdmin 继承；全部 `audit("admin.wren.*")`；
GET 响应 connection 敏感字段恒为 `******`；变更操作与启动 provision 串行化互斥）：

| 端点 | 语义 |
|---|---|
| `GET /admin/wren/datasources` | 列表（state/daemon 端口与存活/models 数/updatedAt） |
| `GET /admin/wren/datasources/{name}` | 详情 |
| `PUT /admin/wren/datasources/{name}` | 创建/更新（合并 connection/tables）→ 全量 re-provision → 201/200 |
| `DELETE /admin/wren/datasources/{name}` | 杀 daemon → mcp.json 移除 → 项目目录删除 → 注册表移除 |
| `POST /admin/wren/datasources/{name}/rebuild` | 重内省 + 重生成 + build + **daemon 重启**（新 MDL 快照生效，§39.5.1） |
| `POST /admin/wren/datasources/{name}/test` | 仅连接测试（PG `SELECT 1` / CH 内省 LIMIT 1；body 可给未落库载荷） |

- PUT/rebuild 需 wren CLI（503 `WREN_UNAVAILABLE`）；层未启用 409 `WREN_DISABLED`；
  内省失败 → 注册表 `lastError`、GET `state:"error"`、骨架/daemon 照常（非致命）。
- DELETE 的 profiles.yml 残留 profile 条目无害（无项目绑定即不被解析），保留以简化幂等。

**无人值守 schema 同步（v3/M34，§39.2.2）**：用户表结构未定稿、持续演进场景下，网关按
表指纹做 drift 检测并增量更新语义层——自动生成 + 增量、不覆盖 agent 的 enrich。

- **表指纹**（`tableFingerprint`，core/wren/models.ts）：单表的规范化目录行（`column:type`
  按列名排序，行序无关）拼串 → sha256 前 12 位。生成的每个 `models/<name>/metadata.yml`
  在 properties 写入所有权标记：`gateway_generated: true` + `table_fingerprint`。
- **目录哈希**（`catalogHash`）：全部内省行按 `schema.table.column:type` 规范化排序 →
  sha256 前 12 位，存注册表（drift 基线）；与基线相同 → 短路（不 build、不重启 daemon）。
- **增量六情形**（`planModelWrites`，纯函数；PUT/rebuild 的生成同走此路径）：

| 情形 | 行为 |
|---|---|
| 现有 model 指纹 == 当前 | unchanged（**不写文件**，agent enrich 安全） |
| 指纹不同 + `gateway_generated: true` | 重写 columns/table_reference，**保留原 `properties.description`**（非生成占位时） |
| 指纹不同 + 非 gateway_generated（agent 手建） | 跳过（不动） |
| 新表（在 tables 白名单内） | 生成（带标记） |
| 表消失 + gateway_generated | deletes（删除目录） |
| 表消失 + 非 gateway_generated | 保留 |

  现有 model 解析用**行扫描**（只认自己的固定格式，不引 YAML 库）；解析失败（agent 大改
  结构）→ 视为非网关生成跳过。v3 之前的生成文件（无标记 + 占位 description）自动识别为
  网关生成（升级自愈：下次 sync/rebuild 补写指纹；已被 enrich 的旧文件保守视为手建）。
- **调度**：env `WREN_AUTO_SYNC_MIN`（分钟，默认 **1440**=24h；`0`=关闭；非法/超上限回落
  默认）。启动流程：`ensureWrenDatasources()`（provision 成功即基线 catalogHash）→
  `syncAll()` 一次（drift 检查，无变化零 rebuild）→ `startWrenAutoSync()`（`setInterval
  (...).unref()`，首轮延迟一个间隔不抢启动；优雅关停时清除）。
- **sync vs rebuild**：`POST /admin/wren/datasources/{name}/sync`（body 可选 `{"force":true}`）
  按 drift 增量——无变化零成本；`force` 跳过短路（无内省器类型如 duckdb 仅重编译 + 重启
  daemon）。`POST /admin/wren/sync` 全量遍历（单个失败不中断）。`rebuild` 语义保持**无条件
  重建**（内省 + 重生成 + build + daemon 重启全链路）。全部经 `enqueueWrenOp` 与启动
  provision 串行；audit `admin.wren.sync` / `admin.wren.sync_all`。
- **失败降级**：内省/连接失败 → 不改任何模型文件、注册表写 `lastSyncError`（旧模型继续
  服务）、返回 `{changed:false}`；context build 失败 → 不重启 daemon、不基线 catalogHash
  （下次 sync 重试）；daemon 重启超时 → 记 `lastSyncError`（进程保留稍后自愈）。
  GET DTO 新增 `catalogHash` / `lastSyncedAt` / `lastSyncError`（connection 脱敏规则不变）。

### 39.3 建模与查询（分工）

- **建模（agent 驱动，Wren 官方设计）**：会话 agent 按 `wren skills get generate-mdl` 内省
  information_schema → 每表一个 `models/*.yml`（含描述/关系/指标）→ `wren context build` +
  `wren memory index`。YAML 落挂载目录，PR 可审阅；schema 演进同流程重跑。
- **查询（会话内三步）**：`describe_schema`（MDL 上下文）→ 写 SQL → `dry_plan`/`dry_run` 校验
  → `run_sql` 执行（默认 1000 行 cap/硬上限 10000）。CLI 等价 `wren query --read-only --sql`
  （执行前拒绝写入/DDL/多语句/锁）。
- **经验沉淀**：`wren memory store/recall`——NL→SQL 对存 `knowledge/sql/*.md`（Git 可审阅），
  grep 后端零依赖；`[memory]` extra（LanceDB+torch ~800MB）默认**不装**。
- MCP 工具 17 个（run_sql/dry_run/dry_plan/query_cube/get_mdl/list_models/describe_model/
  describe_schema/get_data_source/list_cubes/describe_cube/list_functions/get_instructions/
  recall_queries/get_context/list_knowledge/list_stored_queries），全部 readOnlyHint；
  端点 `http://127.0.0.1:<port>/mcp`（FastMCP streamable-http）。

### 39.4 安全与信任模型

- MCP http **无鉴权**（wren 该版本设计）→ 127.0.0.1 环回绑定 + 同容器（与 qmd daemon 一致）；
  跨容器部署需自行加网关认证。
- DB 凭证：以 `${WREN_SECRET_*}` 占位符进 profiles.yml，明文仅存在于网关进程 env；
  数据库侧建议只读账号（`wren query --read-only` 是执行前防线，非权限替代）。
- 行/列级权限为 Wren 商业版能力；多租户细粒度权限当前靠只读账号 + 视图。

### 39.5 已知限制（实测）

1. daemon 的 MDL 为启动时快照：会话内 `wren context build` 后需重启 daemon 才在 MCP 生效
   （过渡方案：CLI `wren --sql` 每次即时编译）；网关重启复用存量 daemon 同理。
2. `profile add --no-validate`：连接错误首次查询才暴露（daemon 未监听时网关只告警）。
3. daemon 启动即死不会自动重建（需下次网关重启；已知触发路径已修——重启复用 profile 时
   密钥 env 无条件注入）。
4. 镜像体积 +~880MB（wrenai + duckdb/pyarrow 依赖），3.44GB → 4.32GB。
5. ClickHouse 链路未容器实测（本机 Docker Hub 不可达）；PG 全链路已验证（真实数据聚合
   精确命中）。
6. （v3/M34 已修）原「rebuild 覆盖 enrich」不再成立：模型生成按表指纹增量（§39.2.2）——
   **增量保留 enrich** 的 description，agent **手建 model 永不被删**；schema 变化经
   `sync` 无人值守生效，`rebuild` 保留为无条件重建的兜底手段。

## 40. 结构优化（M33）——Wren 挂接拆分 + mcp.json 单点读写

### 40.1 诊断（重构前实测）

| 坏味道 | 证据 | 后果 |
|---|---|---|
| **God File** | `core/wren.ts` 1154 行挤了 12 个职责（env 解析/注册表/连接脱敏/内省/PG+CH 适配/MDL 生成/子进程/daemon/mcp.json/skill/启动编排/admin 队列） | 改一处要读全文；单测只能覆盖纯函数，I/O 面无法隔离 |
| **mcp.json 三处独立读-改-写（真竞态）** | `wren.ts:921/949` + `kb/qmd.ts:309` 各自「读文件 → 改内存 → 写回」 | 启动时 qmd 与 wren 注册并发 → 后写者覆盖前者条目（丢 server） |
| **子进程样板重复** | `runWren` 与 `runQmd` 各写一遍 spawn+超时强杀+stdout/stderr 截断+失败日志 | 行为漂移风险；修复要改两份 |
| **best-effort 告警重复** | 两模块各自 `truncate` + `console.error(...)` 模板 | 日志格式与截断长度可能分叉 |

### 40.2 模式映射

| 模式 | 落点 | 解决的问题 |
|---|---|---|
| **Repository**（仓储） | `core/mcp-registry.ts`、`core/wren/registry.ts` | 各自单点管理一个持久化文件（global/mcp.json、datasources.json），调用方不再直接碰 fs |
| **Adapter**（适配器） | `core/proc.ts`（命令执行）、`core/daemon.ts`（长驻进程）、`core/wren/introspect/{postgres,clickhouse}.ts`（目录查询→`WrenCatalogRow`） | 把平台/驱动差异收进单一实现，业务层只面向统一接口 |
| **Factory**（工厂） | `core/wren/introspect/index.ts:selectIntrospector(datasource)` | 类型分发；未适配类型返回 `null` → 空骨架路径（duckdb 等） |
| **Strategy**（策略） | `Introspector` 接口的两个实现（`introspect` / `testConnection`） | 新增数据源类型 = 新适配器 + 工厂表一行，不动编排 |
| **Template Method**（模板方法） | `core/wren/service.ts:WrenService.provision` | 固定八步骨架（profile→scaffold→introspect→generate→build→daemon→mcp→skill），子步可覆盖；失败降级语义集中在骨架里 |
| **Facade**（门面） | `core/wren/index.ts`、`core/wren.ts` 壳、`WrenService` 的自由函数包装 | 外部 import 路径与签名零改动；路由/入口无需感知拆分 |
| **Command**（命令队列） | `core/wren/operation-queue.ts:enqueueWrenOp` | PUT/DELETE/rebuild 与启动 provision 串行化（注册表/daemon 互斥） |
| **Singleton**（单例） | `mcp-registry.ts` 模块级 promise 链、`defaultWrenService`、env 解析函数 | 进程内唯一队列/实例；并发读-改-写线性化 |

### 40.3 目标结构树（含行数）

```
src/core/
├── proc.ts                 92   # runCommand/resolveBin：spawn+超时+2048 截断（wren/qmd 共用）
├── daemon.ts              125   # DaemonSupervisor：isPortListening/isPidAlive/spawnDaemon/killPid
├── mcp-registry.ts        106   # global/mcp.json 唯一读写点（模块级串行锁 + 深比较幂等）
├── wren.ts                  5   # 兼容壳：export * from "./wren/index.ts"
├── wren/
│   ├── index.ts            15   # Facade：聚合公开面（原 export 名全部可用）
│   ├── env.ts             110   # WREN_BIN/HOME/PORT_BASE、种子解析、三个白名单正则
│   ├── registry.ts        127   # datasources.json Repository（0600）+ 种子合并 + 端口分配
│   ├── models.ts          109   # 纯函数：quoteYamlString/sanitizeModelName/catalogOf/omitsCatalog/mdlModelsFromRows
│   ├── introspect/
│   │   ├── types.ts        26   # WrenCatalogRow + Introspector 接口
│   │   ├── postgres.ts     61   # Adapter：information_schema.columns（排除系统 schema）
│   │   ├── clickhouse.ts   58   # Adapter：system.columns（database 限定 + information_schema 排除）
│   │   └── index.ts        49   # Factory：selectIntrospector / introspectWrenDatasource / testWrenConnection
│   ├── project.ts         115   # 占位符/profile/骨架/writeIfChanged（wren CLI 包装）
│   ├── daemon.ts           99   # ensureWrenDaemon/killWrenDaemonFor/countWrenModels
│   ├── mcp.ts              37   # registerWrenMcpServers/removeWrenMcpServer
│   ├── skill.ts           134   # SKILL.md 模板 + references 物化 + refresh
│   ├── operation-queue.ts  15   # enqueueWrenOp / runWrenAdminOp（Command 队列）
│   └── service.ts         296   # WrenService：八步模板 + deprovision + ensureAll + DTO
└── kb/qmd.ts              219   # 仅保留 qmd 语义；spawn→proc、mcp.json→mcp-registry
```

**拆分原则**：env 只依赖 config/proc；registry 只依赖 env + core/daemon；project/daemon/mcp/skill
只依赖 env/registry/core 底座；service 只做编排（经各子模块，不重复实现）；index 只聚合导出。
纯函数（models）不 import I/O；适配器只依赖 types + 驱动。

### 40.4 兼容层策略（strangler）

- `gateway/src/core/wren.ts` 保留 5 行壳：`export * from "./wren/index.ts";`。历史导入方
  `src/index.ts`、`routes/admin-wren.ts`、`test/unit/wren.test.ts` **零改动**；所有原
  export 名/签名在 `core/wren/index.ts` 原样可用（`WrenService` 为新增能力）。
- qmd 无壳：`core/kb/qmd.ts` 路径与导出集合保持不变（`kbQmdAdd/kbQmdUpdate/kbQmdRemove/
  scheduleKbQmdEmbed/kbEmbedStatus/kbEmbedRunning/kbQmdStatusProbe/ensureQmdMcpRegistered/
  qmdSubprocessEnv/qmdIndexName/qmdBin/qmdDirs`）。
- **何时删壳**：当 `rg 'core/wren\.ts' gateway/src gateway/test` 只剩壳自身时，把上述 3 处
  import 改到 `core/wren/index.ts` 并删除 `core/wren.ts`（建议作为 M34 的机械清理，不夹带
  逻辑改动）。

### 40.5 行为不变清单（回归断言口径）

- 日志前缀仍为 `[gateway:wren]` / `[gateway:qmd]`；stdout/stderr 截断 2048 字符。
- 全部 best-effort：启动挂接失败只告警不阻塞；`WREN_MCP!=1` / `KB_QMD_MCP!=1` no-op；
  qmd 缺失返回 `{ok:false, reason:"qmd not installed"}`。
- 密钥占位符 `WREN_SECRET_<NAME>_<FIELD>`、profiles.yml 零明文；`--no-validate` 保留。
- CH 两段式 `table_reference`（省略 catalog）、内省排除 `system`/两个 `information_schema`、
  跨 schema 同名表的稳定命名均原样保留。
- daemon 端口复用（启动路径）与 PUT/rebuild 定点杀（pid→端口释放等待）不变；
  skill 的 `SKILL_NAME=data-query` 与 `SKILL_GUIDES` 三项不变。
- 唯一有意的可观察差异：`mcp-registry.upsert` 用**内容深比较**判幂等（旧 wren 只比 url）。
  若有人手工给 `wren-*` 条目加了额外字段或写错 `type`，下一次 upsert 会把它规范化为
  `{type:"http", url}`——这是「只增/改给定键、内容一致不落盘」共享契约的要求。

### 40.6 验收数字

| 指标 | 重构前 | 重构后 |
|---|---:|---:|
| `core/wren.ts` | 1154 行（12 职责） | **5 行**（兼容壳） |
| `core/kb/qmd.ts` | 324 行 | **219 行** |
| wren 家族最大单文件 | 1154 行 | **296 行**（`service.ts`） |
| global/mcp.json 写点 | 3 处独立读-改-写 | **1 处**（`mcp-registry.ts`，串行锁） |
| 子进程 spawn 实现 | 2 份 | **1 份**（`proc.ts`） |
| 单测 | 105 pass / 11 文件 | **110 pass / 12 文件**（新增 `test/unit/mcp-registry.test.ts`：并发 upsert 不丢键、幂等不重写、remove 精准删） |

验证命令与结果：`bun run typecheck` 0 error；`bun run test:unit` 110 pass / 0 fail；
`bun run docs:check` 212/212 documented、0 missing；`test/kb.test.ts` + `test/kb-qmd.test.ts`
6 pass / 3 skip（qmd 未安装，skip-if-absent）/ 0 fail；`test/wren.test.ts` 10 skip
（WREN_BIN 未指向本机 venv）。

## 41. Docker 环境复核（M35）——kb/wren/qmd 全落地后的镜像梳理

§35 的"1.65GB"叙事写于 KB/Wren 增强层落地之前；本节是增强层齐备后的全量复核：
Dockerfile / docker-compose / entrypoint / .env.example / .dockerignore / README / SOP /
docker-smoke 八处逐一对照 `src/`（kb、wren、qmd、agent-compose、mcp-registry、proc、daemon）与
DESIGN §32–§40 的契约，修正 10 处，并实测定位一个镜像瘦身的地雷（§41.3）。

### 41.1 镜像层构成实测（全量 4.32GB，增强层默认全烘）

| 层 | 体积 | 内容 |
|---|---:|---|
| pip 层（runtime 3/17） | 988MB | pymupdf + minio（KB 出图）+ wrenai[mcp,postgres,clickhouse] |
| qmd 层（runtime 12/17） | 907MB | bun 全局 @tobilu/qmd + @node-llama-cpp 多平台预编译 662MB + tree-sitter 69MB |
| node_modules | 392MB | 网关生产依赖（pi-* SDK 为主） |
| node 22 / bun | 122 / 107MB | npm 生态 MCP / 网关运行时 |
| conda（两段） | 453MB | python 3.14 + conda/pip |
| debian + runtime apt | ~106MB | git/jq/tini/procps 等 |

### 41.2 修正清单（10 项）

| # | 问题 | 处置 |
|---|---|---|
| 1 | `.dockerignore` 缺 `.mimosa`（安全扫描产物进构建上下文） | 补录 |
| 2 | 层序重排时 `COPY docker/qmd-patch` 被整段丢掉 | 构建期 `MODULE_NOT_FOUND` 当场暴露；教训：重排层必须整链复读，不能只看插入点 |
| 3 | qmd 层（907MB，重下载）排在应用 COPY **之后**——src 一变，BuildKit 缓存链断裂，每次提交重拉 0.9GB | 前置到 USER omp 之后、应用 COPY 之前（§41.4） |
| 4 | 文档里"可裁 ~700MB"只是注释里的手动方案，没有开关 | 落成 `QMD_SLIM` / `WREN_EXTRAS` build-arg，compose 透传（§41.3 / Dockerfile） |
| 5 | compose 与 Dockerfile 各写一份 healthcheck（必然漂移） | 删 compose 侧，注释指向 Dockerfile |
| 6 | compose 缺调优 env 透传（`GATEWAY_SESSION_IDLE_TTL_MS` / `STREAM_*` / `OTEL` / `CORS_ORIGINS`） | 补 passthrough（留空=代码内置值） |
| 7 | 构建期 `NPM_REGISTRY` 与运行期 `NPM_CONFIG_REGISTRY` 要配两次 | compose 插值回退：`NPM_REGISTRY: "${NPM_REGISTRY:-${NPM_CONFIG_REGISTRY:-}}"` |
| 8 | `.env.example` 两处宿主路径写旧值 `./kb/wren`（实际 `./global/wren`）；缺 `WORKSPACE_ROOT` 说明；NPM 变量双角色未注明 | 逐一修正 |
| 9 | README / SOP 体积叙事停在"1.65GB"，KB/Wren 增强层未计入 | 更新为"基础 1.65GB + 增强层 ≈4.3GB + 瘦身开关"分层叙事 |
| 10 | docker-smoke 未覆盖新管理面 | 补 `GET /admin/kb`、`GET /admin/wren/datasources`、无 X-Admin-Id → 403 门禁三项 |

### 41.3 bun install cache 硬链接坑——"同层 rm 不减层体积"的真因（实测）

QMD_SLIM 最初写成"安装后同层 `rm -rf node_modules/@node-llama-cpp/<多平台目录>`"，结果：
容器文件系统里目录确实没了，但 `docker history` / `docker save` / `docker system df` 全部仍报 907MB。

排查排除法：

1. **不是 overlayfs 白名单问题**（§35.5 铁律在同层成立）：最小实验 `dd 100MB + 同层 rm`
   在同一引擎上 327MB → 118MB，同层 rm 机制本身有效。
2. **不是 rm 没执行**：`docker run` 进 slim 镜像 `ls`，多平台目录确已消失。
3. **真因：硬链接**。`bun install -g` 把包文件**硬链接**进 `$BUN_INSTALL/install/cache`
   （实测 863MB；`stat -c '%i %h'` 对比 node_modules 与 cache 侧同一文件：同 inode、`links=2`）。
   层 diff 按**路径**记录文件——node_modules 侧的目录项删了，数据仍被同层 cache 路径引用，
   层体积纹丝不动。

修复：QMD_SLIM 分支同层连 `install/cache` 一起删 → **qmd 层 907MB → 156MB，
镜像总量 4.32GB → 3.21GB（-26%）**。

附带两个小坑：glob `tree-sitter-*` 漏掉 `web-tree-sitter`（改用 `find -name '*tree-sitter*'`）；
硬链接计数会让容器内 `du` 低估层内真实数据量（验证体积要看 `docker history` 的层尺寸，不能只看 `du`）。

推论：**凡是硬链接型包管理器（bun / pnpm）在镜像层内安装后做裁剪，rm 必须包含其 cache 目录**；
`pnpm` 的 store 同理。§35.5 的"同层 rm"铁律补上这条边界。

### 41.4 层序规则（M35 新增）

BuildKit 缓存按层链失效：排在前面的层不变，后面的层才可能命中缓存。据此分两类：

- **重下载层**（apt / bun install / pip / qmd 全局装）：依赖面越窄越好、**尽量前置**——
  qmd 层现在只依赖 bun 二进制 + qmd-patch，src/package.json 每天变也不触发重拉。
- **应用 COPY 层**（node_modules/src/scripts/package.json）：高频变更、零下载成本，**放最后**——
  变更时只重跑本地拷贝（秒级）。

代价：qmd-patch 变更会使后面的应用 COPY 全部重跑——本地拷贝秒级，远比重拉 0.9GB 便宜。

### 41.5 验证（M35）

- 全量镜像构建 EXIT 0（清华 pip 源 + npmmirror）；`bun run typecheck` 0 error；`bun test test/unit` 121 pass / 0 fail。
- 容器验收 **18/18**（docker-smoke：健康/会话/注入/bootstrap/文件/openapi 214 操作/**KB·Wren 挂载与 403 门禁**/导出导入往返）。
- QMD_SLIM=1 变体：qmd 2.8.3 + patch 产物 + python(pymupdf/minio) + wrenai 0.18.0 全部就位，
  tree-sitter 与多平台 llama 预编译消失，cache 目录清空；层 156MB。
- 四套运行时登录 shell 可达：python 3.14.7 / node 22.14.0 / bun 1.4.4 / uv 0.13.8；entrypoint 日志仅预期告警（MinIO 未配置）。

### 41.6 KB 检索策略修订：omp 路由的 grep × qmd 双路组合（M35）

部署方反馈：KB 的检索不该是"qmd 优先、grep 兜底"，而应**由 omp（agent）按问题形态判断**、
把两条路组合使用。落实在 skill 模板层（`core/kb/skill.ts`），不改任何网关代码路径：

- **事实核查**：omp 的 grep 工具 import 自 `@oh-my-pi/pi-natives`（原生 ripgrep 引擎，
  结果字段含 `ripgrepTruncated`）——**不依赖系统 `rg` 二进制**（镜像实测 `command -v rg` 为空），
  会话内开箱即用，镜像无需加包。
- **SKILL.md**：description 与检索流程第 1 步改为"路由 + 定位"——词面可预测（寄存器/参数名、
  命令、缩写、错误串、表格编号）→ grep 工具；语义/换说法（自然语言描述、因果/流程类）→ qmd；
  拿不准 → 双路并行。判断权显式交给 agent。
- **references/retrieval.md**：重写为「双路对照表 → 路由判断 → 三种组合套路
  （A：qmd 定域→grep 定行 / B：grep 破冰→qmd 扩面 / C：双路并行）→ grep 工具参数面
  （pattern/path/case/gitignore/skip）→ qmd MCP/CLI → 无响应处置 → 迭代准则」。
- **改口 M29**：§38.6 标题与三级策略同步改写（"grep 兜底"表述全文退役，见 §38.6/§38.9/§38.12/
  .env.example）；降级链语义不变（qmd MCP → CLI → 纯 grep，能力不缺只是没有增强排名）。
- 修订动机：单文档知识库里 qmd 通常只返回**文档级**一条结果，行号始终靠 grep——把 grep 降级为
  兜底会诱导 agent 在词面秒答的场景先绕道 qmd。
- 存量 KB 经 `refreshAllKbSkills()`（启动时）与入库后 `refreshKbSkillMd()` 自动升级到新模板；
  单测 `test/unit/kb.test.ts` 新增 5 条断言锁住路由语义（含"兜底：grep"表述退役）。

### 41.7 会话工具面收敛（M35）——内网无 GUI 部署关闭联网/浏览器类工具

目标部署环境是**内网 Linux 无 GUI**：omp 默认开启的联网类工具（web_search、read 的 URL
抓取）与浏览器/桌面类工具（browser/computer）在内网里要么不可用（请求挂到超时）、要么
引入无意义的攻击面。收敛机制走 omp 原生设置系统，网关只做注入：

- **事实核查**：omp 设置从 `<cwd>/.omp/settings.json`（project 层）等位置加载；网关建会话时
  `options.cwd = workspaceDir`（session-assembly.ts buildCreateOptions）→ project 层即
  `<workspace>/.omp/settings.json`。相关设置键（pi-coding-agent 设置注册表）：
  `fetch.enabled`（read 抓 URL，默认 true）、`web_search.enabled`（默认 true）、
  `browser.enabled`（默认 true + 内核检测）、`computer.enabled`（默认 false + 驱动检测）。
- **注入点**：`prepareWorkspace` 合成序列末尾新增 `composeSessionSettingsForWorkspace`——
  env `OMP_SESSION_SETTINGS_JSON`（部署方 JSON 对象）→ 写 `<workspace>/.omp/settings.json`。
  语义：env 未设不写（omp 默认，本地开发零影响）；键浅合并、部署键优先（fork 拷贝来源若带
  settings，部署收敛键赢）；坏 JSON 告警跳过不阻塞建会话（fail-open）；内容一致不落盘。
- **入口**：compose 透传 `OMP_SESSION_SETTINGS_JSON`；.env.example 给内网推荐值
  （四个键全 false）。只影响**新建会话**，存量 workspace 不回溯改写。
- **为什么不用其他通道**：entrypoint 环境变量做不到（omp 设置不读这类 env 的这些键）；
  全局 agent 定义可以关工具但会与用户级 agent 合成语义纠缠；project 层 settings 是 omp
  文档化的标准面，且作用域天然等于"这一个会话"。
- 单测 `test/unit/session-settings.test.ts` 6 项（未设不写/写入/合并/坏 JSON/非对象/不落盘）。

### 41.8 git 本地面（M35）——omp 生成物纯本地，容器 git 开箱即用

部署方确认：omp 生成的代码保存在容器挂载卷里，**不推远端**。据此先厘清责任边界，再补容器缺口：

- **omp 会话状态管理不依赖 git**：checkpoint/rewind 是会话树分支机制（`CheckpointState` =
  内存消息数 + session entry ID，见 pi-coding-agent checkpoint.ts）——"omp 自带 git 管理"
  实为会话树快照，git 二进制不参与。
- **git 的容器角色**：agent 在会话内对 workspace 做本地版本管理（init/add/保存点/历史）。
  镜像已带 git + openssh-client（§35.7"workspace 的 git 面"），无需再加工具；缺口在配置：
  1. **身份**：镜像零 git 配置，无身份时本地保存点报 "Please tell me who you are"——
     entrypoint 写 `$HOME/.gitconfig` 默认身份 `omp-session <omp-session@localhost>`，
     部署侧 `GIT_USER_NAME`/`GIT_USER_EMAIL` 覆盖；
  2. **safe.directory**：/workspace 是 777 bind mount，宿主 uid ≠ 容器 1000 时 git 以
     dubious ownership 拒绝操作——默认 `[safe] directory = *` 放行（`GIT_SAFE_DIRECTORY=0`
     关闭）。放行边界：该文件属主即容器用户（600），容器内无提权面，不扩大攻击面；
  3. `init.defaultBranch = main`（消除 hint 噪音）。
- **远端不在默认范围**：git+ssh 工具链（openssh-client）在镜像内但默认无 remote——需要远端
  的会话自行配置。`~/.gitconfig` 每次容器启动由 entrypoint 重写（部署侧配置为准）。
- compose 透传 `GIT_USER_NAME` / `GIT_USER_EMAIL` / `GIT_SAFE_DIRECTORY`；SOP §1.6 有验证方法。

### 41.9 TUI 终端桥（M35）——浏览器 xterm ⇄ WS ⇄ PTY ⇄ omp 原生 TUI

需求：内网部署在前端直接打开 omp 原生 TUI 做交互测试（真实 pi-tui 渲染，非模拟界面）。

- **前提修复（镜像）**：`dist/cli.js` 顶层静态 import `puppeteer-core/internal/util/Function.js`
  （其余 puppeteer 引用均为动态 import）——M24 瘦身删除 puppeteer 家族后，omp CLI 在容器内
  直接 `MODULE_NOT_FOUND`，TUI/ RPC/legacy 兼容路径全废（实测踩到）。恢复 puppeteer-core
  家族五个包（约 +20MB），React 系仍保持裁剪（TUI 不依赖）。
- **通道**：`GET /terminal` 测试页（xterm.js，vendor 依赖 `@xterm/xterm`+`@xterm/addon-fit`，
  ops 面无凭据）→ `GET /terminal/ws/:sid` WS 升级（hono/bun `upgradeWebSocket` +
  `Bun.serve({websocket})` handler）→ pi-natives `PtySession`（PTY 原语，pi-tui 要求
  stdin/stdout 均为 TTY）→ `bun dist/cli.js --session-dir <users/<uid>/sessions>
  --session <ompSessionId>`。
- **会话共享模型**（v2，正确性核心）：omp TUI 无运行时 reload——TUI→网关方向的自动感知
  做不到，故采用**共享观察**而非互斥交接：
  - **读面共享**：TUI 打开时网关 ctx **保持 live**（不 dispose）；tail 循环（500ms 轮询
    stat.size）读同一 JSONL 增量，按行解析 entry → publish `tui.entry` 事件（进 SSE 实时流
    + 回放缓冲，REPLAYABLE 白名单）——前端页面**实时镜像 TUI 里的对话**；
  - **写面互斥**：TUI 是该 JSONL 的活跃写者，网关侧新 turn 会与其内存 leaf 分叉——
    `withTurnSlot` 入口 + prompt 路由（模型预检**之前**，否则无凭据部署先报
    MODEL_UNAVAILABLE 误导——实测踩到）统一 409 `TUI_ACTIVE`；TUI 关闭自动解除；
  - **关闭吸收**：TUI 退出/页面关闭 → 停 tail → `disposeSession(ctx)` → 下次访问
    getOrRevive 从文件重建（含 TUI 期间写入的全部条目）；
  - 空会话（JSONL 未落盘，`SessionManager.create` 是内存态）：onOpen 物化最小 header
    （`CURRENT_SESSION_VERSION` 运行时导入；缺 title 行，open 兼容 §25 导入语义）；
  - 第二个终端 / 占用期复活（网关重启等防御位）仍 409 `TUI_ACTIVE`。
- **公网隧道实测坑位（frp-panel，47.94.164.232:10005 端到端验收通过）**：
  1. **页面 JS 的 WS URL 少冒号**：模板串写成 `${proto}//${host}` → `ws//host` 非法 URL。
     冒烟全用 bun 客户端直连构造 URL、不走页面 JS，故未暴露——页面级改动必须过浏览器 console；
  2. **frp 链路半开 → 僵尸占用**：对端断开时 close 帧经隧道丢失，网关侧占用标记不 clearing，
     新连接全部 409——guard 对占用的 WS 发空帧探活（`send` throw = 僵尸）→ 自动清理放行（自愈）；
  3. **诊断基建**：guard 所有拒绝分支带日志（404 分支曾无日志，探针 uid 错位时表现为
     "升级机制坏"的误判，排查多绕一圈）；
  4. **页面 `Cache-Control: no-store`**：旧页面缓存会让新功能（预填/自动连接）"不生效"；
  5. **`docker restart` 不替换容器文件系统**——更新页面/代码必须 `compose up -d`（recreate）。
- **omp 会话 id 来源**：live ctx 的 `ompSessionId`（= `sessionManager.getSessionId()`）；
  会话已被回收时从 JSONL 头行解析（首条记录携带 id）。
- **agentDir**：CLI 无 `--agent-dir` 主 flag，读 env `PI_CODING_AGENT_DIR`（SDK 同款通道）
  → 注入用户 agentDir，TUI 使用同一份 models.yml/凭据。
- **鉴权**：挂根应用（不经 /api authMiddleware——浏览器 WS 无法带 header）；
  `Authorization` header 优先（BFF 代理场景），`?token=&uid=` 回落（浏览器直连），
  同一套恒时校验（tokenAccepted 导出复用）。
- **协议**：client→server：binary 帧=原始键入，text 帧=JSON 控制帧
  （`{"type":"input","data":..}` / `{"type":"resize","cols":..,"rows":..}`）；
  server→client：PTY 输出原样转发 + `{"type":"exit","code":..}` 终止帧。
  页面关闭 = `pty.kill()`（TUI 退出，内容已在 JSONL）。
- 单测 `test/unit/terminal.test.ts` 5 项（spawn 参数/env 继承/JSONL id 解析/守卫语义）。
