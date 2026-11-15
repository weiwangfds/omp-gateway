# 端点索引

> 由运行时 `GET /openapi.json` 派生（`bun run scripts/gen-endpoint-index.mjs` 重新生成）。
> 语义细节见 [SOP.md](./SOP.md) 与 [DESIGN.md](./DESIGN.md)。

共 193 个操作，13 个分组。

## session-core

会话生命周期：创建/列表/详情/归档/删除/分叉/快照

| 方法 | 路径 | 说明 | 查询参数 |
|---|---|---|---|
| `GET` | `/api/sessions` | 会话列表：分页 + 内联 live 状态/上下文占用/用量/末条消息预览 | `status`, `q`, `page`, `per_page` |
| `POST` | `/api/sessions` | 建会话：1:1 workspace、落 DB 行；幂等键 24h 内重放同响应 | — |
| `DELETE` | `/api/sessions/{sid}` | 删除会话：先打 pre_delete 快照再进 trash（30 天可找回） | `confirm` |
| `GET` | `/api/sessions/{sid}` | 会话详情：元数据 + live 状态 + 用量汇总 | — |
| `PATCH` | `/api/sessions/{sid}` | 改标题或归档状态（归档即释放进程态，文件保留） | — |
| `GET` | `/api/sessions/{sid}/approvals` | 待审批工具调用清单（含当前审批策略；超时后端自动拒绝） | — |
| `POST` | `/api/sessions/{sid}/approvals/{approvalId}` | 审批决定：放行或拒绝（404 表示已决或已超时） | — |
| `GET` | `/api/sessions/{sid}/entries` | 会话条目列表（fork/branch 的寻址键；可按类型过滤） | `type`, `offset`, `limit` |
| `DELETE` | `/api/sessions/{sid}/entries/{entryId}/label` | 移除条目标签 | — |
| `PUT` | `/api/sessions/{sid}/entries/{entryId}/label` | 给条目打标签（网页书签/标重点） | — |
| `GET` | `/api/sessions/{sid}/hooks` | 本会话的生命周期钩子 + 事件契约 | — |
| `POST` | `/api/sessions/{sid}/hooks` | 注册会话级生命周期钩子（notify 通知 / decide 同步决策） | — |
| `DELETE` | `/api/sessions/{sid}/hooks/{id}` | 注销会话级钩子 | — |
| `GET` | `/api/sessions/{sid}/session-file` | 下载会话原始 JSONL（NDJSON 附件） | — |
| `POST` | `/api/sessions/{sid}/share-link` | 签发分享链接（view 只读 / control 可对话；token 仅返回一次） | — |
| `DELETE` | `/api/sessions/{sid}/share-link/{shareId}` | 吊销分享链接 | — |
| `GET` | `/api/sessions/{sid}/share-links` | 本会话的分享链接列表 | — |
| `GET` | `/api/sessions/{sid}/snapshots` | 快照列表（自动与手动，按时间倒序） | — |
| `POST` | `/api/sessions/{sid}/snapshots` | 手动快照（幂等；零 turn 会话返回 SNAPSHOT_EMPTY） | — |
| `DELETE` | `/api/sessions/{sid}/snapshots/{snapId}` | 删除快照（文件与记录一起清） | — |
| `GET` | `/api/sessions/{sid}/snapshots/{snapId}` | 单个快照元数据 | — |
| `POST` | `/api/sessions/{sid}/snapshots/{snapId}/restore` | 快照恢复：fork（默认，安全）或 rollback（同会话换文件，先打 pre_restore 快照） | — |
| `GET` | `/api/sessions/{sid}/webhooks` | 本会话的回调订阅（secret 不外泄） | — |
| `POST` | `/api/sessions/{sid}/webhooks` | 注册会话级回调（只收该会话事件；HMAC 签名推送） | — |
| `DELETE` | `/api/sessions/{sid}/webhooks/{id}` | 注销会话级回调 | — |
| `POST` | `/api/sessions/import` | 导入会话 JSONL：校验 → 补 model_change → 写文件与 DB 行 | — |
| `GET` | `/api/sessions/search` | 会话正文搜索：扫该用户 JSONL 命中行并回 snippet | `q`, `limit`, `maxFiles` |
| `POST` | `/api/sessions/validate` | 会话 JSONL 干跑校验（不落库） | — |

## session-observe

状态与观测：state/bootstrap/status/事件流与回放/用量

| 方法 | 路径 | 说明 | 查询参数 |
|---|---|---|---|
| `GET` | `/api/sessions/{sid}/bootstrap` | 集成端初始化聚合：会话/状态/模式/待审批/命令/事件游标一次取全 | — |
| `GET` | `/api/sessions/{sid}/dump` | 会话全文转写（纯文本） | — |
| `GET` | `/api/sessions/{sid}/events` | SSE 事件流：先订阅后 prompt；Last-Event-ID 重连，types 可过滤 | `types` |
| `GET` | `/api/sessions/{sid}/events/replay` | 事件 JSON 回放：按游标补齐（环形缓冲最近 500 条） | `since`, `limit`, `types` |
| `GET` | `/api/sessions/{sid}/integration` | 本会话集成端点清单与契约文档位置（自描述） | — |
| `GET` | `/api/sessions/{sid}/messages` | 会话消息历史（SDK messages 直读，since 可增量） | `since` |
| `POST` | `/api/sessions/{sid}/messages/custom` | 投递自定义消息：扩展协议通道（customType + content + deliverAs） | — |
| `GET` | `/api/sessions/{sid}/state` | 状态快照一次拿全：模型/思考/队列/工具/上下文占用/消息数 | — |
| `GET` | `/api/sessions/{sid}/stats` | SDK 会话统计直出（工具调用数/耗时/缓存等） | — |
| `GET` | `/api/sessions/{sid}/status` | 轻量轮询：状态/模型/待审批数/队列数/事件游标 | — |
| `GET` | `/api/sessions/{sid}/usage` | 会话用量：汇总 + 最近 50 个 turn 明细 | — |

## session-conversation

对话通道：prompt/steer/inject/业务事件/队列

| 方法 | 路径 | 说明 | 查询参数 |
|---|---|---|---|
| `POST` | `/api/sessions/{sid}/abort` | 中止当前 turn（立即返回 202） | — |
| `POST` | `/api/sessions/{sid}/branch` | 从某条目分支（编辑点语义）：返回编辑器草稿并换绑到新会话 | — |
| `POST` | `/api/sessions/{sid}/business-events` | 注入业务事件：登记并广播，turn 内事件带 correlation 关联 | — |
| `POST` | `/api/sessions/{sid}/compact` | 手动压缩上下文（需 idle） | — |
| `POST` | `/api/sessions/{sid}/cycle-model` | 轮换模型角色（Ctrl+P 语义；需 idle） | — |
| `POST` | `/api/sessions/{sid}/cycle-thinking` | 轮换思考档位并返回新值 | — |
| `POST` | `/api/sessions/{sid}/export` | 导出当前会话为 HTML（落在 workspace/exports/） | — |
| `POST` | `/api/sessions/{sid}/follow-up` | 追加 follow-up：排队到当前 turn 之后，不打断 | — |
| `POST` | `/api/sessions/{sid}/fork` | 分叉：无 entryId 走血缘分叉（源不动），有 entryId 走 SDK 原地分支后换绑 | — |
| `POST` | `/api/sessions/{sid}/fresh` | 开新会话（保留文件与工作区，丢弃上下文；需 idle） | — |
| `POST` | `/api/sessions/{sid}/handoff` | handoff：总结当前会话并移交到新上下文（需 idle） | — |
| `POST` | `/api/sessions/{sid}/inject` | 提示词注入：context 不耗模型不触发 turn，user 触发 turn（计配额） | — |
| `POST` | `/api/sessions/{sid}/interrupt` | 细粒度中断：按通道中止重试/压缩/handoff/分支摘要/bash/eval | — |
| `POST` | `/api/sessions/{sid}/model` | 会话内切模型（需 idle；切前自动快照，受 provider 白名单约束） | — |
| `POST` | `/api/sessions/{sid}/name` | 给会话命名（SDK 层名称，与网关 title 相互独立） | — |
| `POST` | `/api/sessions/{sid}/prompt` | 发起 turn：202 准许即返回，过程与结果经 SSE；wait=true 可同步等终态 | — |
| `DELETE` | `/api/sessions/{sid}/queue` | 清空消息队列（steering 与 follow-up） | — |
| `POST` | `/api/sessions/{sid}/queue/remove` | 移除队列中的单条消息（按文本 + 队列名） | — |
| `POST` | `/api/sessions/{sid}/reset` | 重置会话上下文（清空对话，文件保留；需 idle） | — |
| `POST` | `/api/sessions/{sid}/restore-interrupted` | 恢复被中断的 turn（进程崩溃后 JSONL 未闭合条目） | — |
| `POST` | `/api/sessions/{sid}/steer` | 向正在流式的会话插话（不打断当前 turn） | — |
| `POST` | `/api/sessions/{sid}/title/generate` | 按首条用户消息生成标题并回写会话 title | — |

## session-panel

控制台面板：命令/模型/思考/todo/上下文/模式/维护

| 方法 | 路径 | 说明 | 查询参数 |
|---|---|---|---|
| `GET` | `/api/sessions/{sid}/commands` | 命令面板：斜杠命令 + 自定义命令 + MCP prompts + 模板 | — |
| `GET` | `/api/sessions/{sid}/context` | 上下文占用：窗口使用量与分桶明细 | `contextWindow` |
| `GET` | `/api/sessions/{sid}/context-files` | 上下文文件发现：用户级与项目级文件 + 是否已进入系统提示词 | — |
| `GET` | `/api/sessions/{sid}/maintenance` | 维护状态：自动压缩/自动重试/缓存预热/提示缓存 | — |
| `GET` | `/api/sessions/{sid}/models` | 模型选择器：可用模型目录 + 当前模型 + 思考档位 | — |
| `GET` | `/api/sessions/{sid}/modes` | 模式面板：plan/goal/压缩/重试/回退等运行态开关 | — |
| `GET` | `/api/sessions/{sid}/plan` | 计划模式：状态与引用的参考文件路径 | — |
| `GET` | `/api/sessions/{sid}/session-tree` | 分叉历史树：条目树 + 当前叶节点（网页可视化） | — |
| `GET` | `/api/sessions/{sid}/skills` | 会话已加载的技能：全部 + 进入系统提示词的那些 + 加载告警 | — |
| `GET` | `/api/sessions/{sid}/thinking` | 思考档位：当前值 + 可选档位与 effort 选择器 | — |
| `PUT` | `/api/sessions/{sid}/thinking` | 设置思考档位（如 low/high；越界按模型上限收敛） | — |
| `GET` | `/api/sessions/{sid}/todos` | todo 面板：阶段列表 | — |
| `PUT` | `/api/sessions/{sid}/todos` | 手工编辑 todo 阶段（落 user_todo_edit 条目） | — |

## session-workspace

会话工作区：文件读写/上传/git/worktree

| 方法 | 路径 | 说明 | 查询参数 |
|---|---|---|---|
| `DELETE` | `/api/sessions/{sid}/file` | 删除文件或目录 | `path` |
| `GET` | `/api/sessions/{sid}/file` | 读文件（JSON 信封：path/encoding/content/size） | `path` |
| `PUT` | `/api/sessions/{sid}/file` | 写文件（utf8 或 base64，≤5MB） | `path` |
| `POST` | `/api/sessions/{sid}/file/mkdir` | 创建目录（workspace 内相对路径） | — |
| `GET` | `/api/sessions/{sid}/file/raw` | 原始字节流（支持 Range，图像/PDF 直接预览） | `path` |
| `POST` | `/api/sessions/{sid}/file/rename` | 重命名或移动 | — |
| `GET` | `/api/sessions/{sid}/files/index` | workspace 文件索引与按名搜索 | `q` |
| `POST` | `/api/sessions/{sid}/files/upload` | 上传文件（multipart，字段名 files；只取 basename 防穿越） | `path` |
| `GET` | `/api/sessions/{sid}/git/branches` | git 分支列表（本地 + 远程，标记当前分支） | — |
| `POST` | `/api/sessions/{sid}/git/commit` | 暂存并提交（add 可为 all 或路径白名单） | — |
| `GET` | `/api/sessions/{sid}/git/diff` | git 差异（可限定路径/暂存区/基线 ref/仅统计） | `path`, `staged`, `stat`, `base` |
| `GET` | `/api/sessions/{sid}/git/log` | git 提交历史 | `limit` |
| `GET` | `/api/sessions/{sid}/git/status` | git 状态：分支/上游/领先落后/逐文件变更 | — |
| `DELETE` | `/api/sessions/{sid}/git/worktrees` | 移除 git worktree | — |
| `GET` | `/api/sessions/{sid}/git/worktrees` | git worktree 列表 | — |
| `POST` | `/api/sessions/{sid}/git/worktrees` | 新建 git worktree（路径必须落在用户数据根内） | — |
| `GET` | `/api/sessions/{sid}/tree` | workspace 文件树（限深限条数） | `path`, `depth`, `max` |

## session-tools

会话工具面：运行时工具集/工具发现/MCP/LSP/异步任务

| 方法 | 路径 | 说明 | 查询参数 |
|---|---|---|---|
| `GET` | `/api/sessions/{sid}/jobs` | 异步任务树与快照（bash 后台 / task 子代理） | — |
| `GET` | `/api/sessions/{sid}/jobs/{jobId}` | 单个异步任务详情 | — |
| `POST` | `/api/sessions/{sid}/jobs/{jobId}/cancel` | 取消异步任务 | — |
| `GET` | `/api/sessions/{sid}/lsp` | LSP 服务器清单 | — |
| `GET` | `/api/sessions/{sid}/mcp` | MCP 汇总：已连接服务器与工具名 | — |
| `POST` | `/api/sessions/{sid}/mcp/reload` | 重新对账项目级 MCP 配置并刷新全部工具（重放业务工具） | — |
| `GET` | `/api/sessions/{sid}/mcp/servers` | MCP 服务器明细：状态/传输/工具数/来源 | — |
| `POST` | `/api/sessions/{sid}/mcp/servers/{name}/reconnect` | 重连单个 MCP 服务器（不重新发现） | — |
| `GET` | `/api/sessions/{sid}/mcp/servers/{name}/resources` | MCP 服务器资源列表 | `refresh` |
| `GET` | `/api/sessions/{sid}/tools` | 运行时生效的工具名（active / all） | — |
| `PUT` | `/api/sessions/{sid}/tools` | 调整运行时生效工具集 | — |
| `GET` | `/api/sessions/{sid}/tools/http` | 本会话可见的业务 HTTP 工具（会话级 + 用户级） | — |
| `DELETE` | `/api/sessions/{sid}/tools/http/{name}` | 注销会话级业务 HTTP 工具 | — |
| `PUT` | `/api/sessions/{sid}/tools/http/{name}` | 注册会话级业务 HTTP 工具（同名覆盖用户级；注册后热生效） | — |
| `GET` | `/api/sessions/{sid}/tools/info` | 工具能力发现：描述、参数名、来源（内置/MCP/自定义） | — |

## session-agent

Agent Hub：名册/定义/transcript/chat/kill/revive

| 方法 | 路径 | 说明 | 查询参数 |
|---|---|---|---|
| `GET` | `/api/sessions/{sid}/agents` | 子代理名册（含 live 状态） | — |
| `GET` | `/api/sessions/{sid}/agents/{aid}` | 子代理详情（任务描述、状态、工具等） | — |
| `POST` | `/api/sessions/{sid}/agents/{aid}/chat` | 给子代理发消息（已停止的先自动复活） | — |
| `POST` | `/api/sessions/{sid}/agents/{aid}/kill` | 中止子代理（留 tombstone；transcript 留盘可复活） | — |
| `POST` | `/api/sessions/{sid}/agents/{aid}/revive` | 从持久化 transcript 忠实重建子代理 | — |
| `GET` | `/api/sessions/{sid}/agents/{aid}/transcript` | 子代理 transcript 原文（限用户根内，≤4MB） | — |
| `GET` | `/api/sessions/{sid}/agents/definitions` | 本会话可见的 agent 定义 + 是否出现在系统提示词 | — |

## config-discovery

用户级发现项与用量：skills/plugins/MCP 开关/限额/用量/schema

| 方法 | 路径 | 说明 | 查询参数 |
|---|---|---|---|
| `GET` | `/api/me/config/schema` | 配置自描述：provider/model/agent 字段清单与示例（供前端生成表单） | — |
| `GET` | `/api/me/limits` | 配额视图：限额 / 本月用量 / 预算余额 / RPM 窗口 | — |
| `GET` | `/api/me/mcp` | MCP 原始配置（agent/mcp.json 原文） | — |
| `PUT` | `/api/me/mcp` | 写 MCP 原始配置（仅挡语法错误，结构由 omp 发现期校验） | — |
| `GET` | `/api/me/mcp/settings` | MCP 用户级开关（disabledServers 优先级最高） | — |
| `PUT` | `/api/me/mcp/settings` | 设置 MCP 用户级开关（写 agent/mcp.json） | — |
| `GET` | `/api/me/plugins` | 用户可见插件清单（私有 + 全局，带 scope 标签） | — |
| `DELETE` | `/api/me/plugins/{name}` | 删除用户级插件 | — |
| `GET` | `/api/me/plugins/{name}` | 读取插件源码 | — |
| `PUT` | `/api/me/plugins/{name}` | 写用户级插件（≤2MB） | — |
| `GET` | `/api/me/projects` | 按仓库聚合会话（origin url 维度） | — |
| `GET` | `/api/me/skills` | 用户可见技能清单（私有 + 全局，带 scope 标签） | — |
| `DELETE` | `/api/me/skills/{name}` | 删除用户级技能 | — |
| `GET` | `/api/me/skills/{name}` | 读取技能原文（SKILL.md） | — |
| `PUT` | `/api/me/skills/{name}` | 写用户级技能（name + description + 正文） | — |
| `GET` | `/api/me/usage` | 用户用量聚合（按天/模型/会话分桶） | `group`, `from`, `to` |

## config-automation

用户级自动化：审批策略与授权/钩子/回调/业务工具/上下文文件

| 方法 | 路径 | 说明 | 查询参数 |
|---|---|---|---|
| `GET` | `/api/me/agents` | 用户级 agent 定义列表（含 frontmatter 解析结果） | — |
| `POST` | `/api/me/agents` | 创建 agent 定义（name 取自 body；同名 409） | — |
| `DELETE` | `/api/me/agents/{name}` | 删除 agent 定义 | — |
| `GET` | `/api/me/agents/{name}` | agent 定义原文；format=json 返回规范字段 + frontmatter | `format` |
| `PUT` | `/api/me/agents/{name}` | 写 agent 定义：application/json 结构化（字段白名单）或 text/markdown 原文 | — |
| `GET` | `/api/me/approval` | 审批策略：模式 + 按工具的策略表 | — |
| `PUT` | `/api/me/approval` | 设置审批策略（模式四选一 + 工具策略整体替换） | — |
| `DELETE` | `/api/me/approval/grants` | 清空持久授权清单 | — |
| `GET` | `/api/me/approval/grants` | 持久授权清单（always-ask-cached 已记住的批准） | — |
| `GET` | `/api/me/context-files` | 用户级上下文文件清单（AGENTS/RULES/APPEND_SYSTEM/SYSTEM） | — |
| `DELETE` | `/api/me/context-files/{name}` | 删除用户级上下文文件 | — |
| `GET` | `/api/me/context-files/{name}` | 读取单个上下文文件 | — |
| `PUT` | `/api/me/context-files/{name}` | 写用户级上下文文件（新会话创建时进入系统提示词） | — |
| `GET` | `/api/me/hooks` | 用户级钩子列表 + 21 事件契约（区分决策型与通知型） | — |
| `POST` | `/api/me/hooks` | 注册用户级生命周期钩子（对该用户全部会话生效） | — |
| `DELETE` | `/api/me/hooks/{id}` | 注销用户级钩子 | — |
| `GET` | `/api/me/tools/http` | 用户级业务 HTTP 工具列表 | — |
| `DELETE` | `/api/me/tools/http/{name}` | 注销用户级业务 HTTP 工具 | — |
| `PUT` | `/api/me/tools/http/{name}` | 注册用户级业务 HTTP 工具（注册后热应用到该用户全部 live 会话） | — |
| `GET` | `/api/me/webhooks` | 用户级回调订阅列表（跨全部会话） | — |
| `POST` | `/api/me/webhooks` | 注册用户级回调（HMAC 签名推送；secret 仅创建响应返回一次） | — |
| `DELETE` | `/api/me/webhooks/{id}` | 注销用户级回调 | — |

## config-models

用户级模型配置：目录/models.yml/provider/凭据/角色/探针

| 方法 | 路径 | 说明 | 查询参数 |
|---|---|---|---|
| `GET` | `/api/me/model-roles` | 模型角色配置（@role 别名与轮转顺序） | — |
| `PUT` | `/api/me/model-roles` | 设置模型角色与轮转顺序（写用户级 config.yml） | — |
| `GET` | `/api/me/models` | 模型目录（带成本与上下文窗口；find/provider/refresh 可用） | `find`, `provider`, `refresh` |
| `GET` | `/api/me/models/config` | models.yml 原文（text/yaml）；format=json 返回结构化视图 | `format` |
| `PUT` | `/api/me/models/config` | 写 models.yml：application/json 为结构化（校验并格式化），其余按原文写入 | — |
| `POST` | `/api/me/models/credentials` | 注入凭据：把 API key 合并进 models.yml 对应 provider | — |
| `DELETE` | `/api/me/models/providers/{provider}` | 删除单个 provider | — |
| `GET` | `/api/me/models/providers/{provider}` | 单个 provider 配置 | — |
| `PUT` | `/api/me/models/providers/{provider}` | 整体替换单个 provider（省略字段即删除；其他 provider 不受影响） | — |
| `POST` | `/api/me/models/test` | 模型探针：独立内存会话发一条探针，测首字延迟与总耗时 | — |
| `GET` | `/api/me/providers` | Provider 结构化视图（configured/available/disabled；不返回 apiKey 明文） | — |
| `GET` | `/api/me/providers/settings` | provider 开关设置（disabledProviders） | — |
| `PUT` | `/api/me/providers/settings` | 设置 provider 开关（对新会话生效；live 会话保留原 registry） | — |

## internal

内部生命周期契约（/internal/*）：上游服务专用，分享令牌拒绝

| 方法 | 路径 | 说明 | 查询参数 |
|---|---|---|---|
| `GET` | `/internal/audit` | 审计查询：按用户与动作过滤，分页返回 | `user`, `action`, `page`, `per_page` |
| `POST` | `/internal/drain` | 排空开关：开启后拒新会话且健康检查失败（滚动发布摘流量） | `off` |
| `POST` | `/internal/maintenance/export` | 环境导出：静默实例 → 一致 DB 快照 + 文件树 + manifest（校验和/计数/文件清单） | `keepDrained` |
| `POST` | `/internal/maintenance/import` | 环境导入：校验 manifest → 复制覆盖 → 按文件清单清冗余 → 换库重开 → 计数对账 | — |
| `GET` | `/internal/trash` | 回收站列表：已删会话与租户（30 天窗口） | — |
| `POST` | `/internal/trash/sessions/{sid}/restore` | 找回已删会话（清 deleted_at，状态回 active） | — |
| `POST` | `/internal/trash/users/{uid}/restore` | 找回已删租户 | — |
| `DELETE` | `/internal/users/{uid}` | 级联删除用户：释放全部 live 会话并标记 deleted（30 天后物理清除） | `confirm` |
| `PATCH` | `/internal/users/{uid}/limits` | 调整用户限额（合并语义：maxSessions/maxConcurrent/allowedProviders） | — |
| `POST` | `/internal/users/{uid}/provision` | 懒 provision：建用户目录骨架与租户行（幂等） | — |
| `GET` | `/internal/users/{uid}/summary` | 用户状态：租户信息、限额、活跃/live/streaming 会话数 | — |
| `GET` | `/internal/users/{uid}/usage` | 用户用量聚合（上游计费或展示用） | `group`, `from`, `to` |
| `GET` | `/internal/users/{uid}/webhooks` | 用户的回调订阅（内部视角） | — |
| `POST` | `/internal/users/{uid}/webhooks` | 为用户注册回调（内部视角） | — |
| `DELETE` | `/internal/webhooks/{id}` | 注销用户回调（内部视角） | — |

## admin

全局资源管理（/admin/*）：需上游注入 X-Admin-Id

| 方法 | 路径 | 说明 | 查询参数 |
|---|---|---|---|
| `GET` | `/admin/global/mcp` | 全局 MCP 配置 | — |
| `PUT` | `/admin/global/mcp` | 写全局 MCP 配置（合成进各用户 workspace） | — |
| `GET` | `/admin/global/plugins` | 全局插件清单 | — |
| `DELETE` | `/admin/global/plugins/{name}` | 删除全局插件 | — |
| `GET` | `/admin/global/plugins/{name}` | 读取全局插件源码 | — |
| `PUT` | `/admin/global/plugins/{name}` | 写全局插件（所有用户可见） | — |
| `GET` | `/admin/global/skills` | 全局技能清单（所有用户可见，用户同名覆盖） | — |
| `DELETE` | `/admin/global/skills/{name}` | 删除全局技能 | — |
| `GET` | `/admin/global/skills/{name}` | 读取全局技能原文 | — |
| `PUT` | `/admin/global/skills/{name}` | 写全局技能（所有用户可见） | — |

## ops

运维探针（healthz/readyz/metrics/openapi），内网无凭据

| 方法 | 路径 | 说明 | 查询参数 |
|---|---|---|---|
| `GET` | `/healthz` | 存活探针（排空期间返回 503 以摘流量） | — |
| `GET` | `/metrics` | Prometheus 指标：会话数、流式槽位、用量与成本、限流与预算拒绝 | — |
| `GET` | `/openapi.json` | 本契约文档（OpenAPI 3.1） | — |
| `GET` | `/readyz` | 就绪探针（数据根可写） | — |
