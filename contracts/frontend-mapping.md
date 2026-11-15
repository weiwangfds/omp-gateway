# 前端事件映射契约（M9/M11，v1.2）

React(assistant-ui + a2ui) 消费 gateway-events v1.2 的权威映射表。SSE 传输与重连协议见
`gateway-events.v1.schema.json` description 与 DESIGN §6/§12；认证见 DESIGN §18。

## 连接顺序（铁律）

1. `GET /api/sessions/:sid/events`（可带 `Last-Event-ID` 头）→ 收到 `replay.state`
2. `POST /api/sessions/:sid/prompt` → **202 即返回**（准许即 202，M7 语义；turn 结果走 SSE）
3. 事件循环消费；断开=仅解绑订阅；显式取消=`POST /:sid/abort`

## gateway-events → assistant-ui 映射

| gateway 事件 | assistant-ui / 前端动作 |
|---|---|
| `replay.state` | 初始化状态帧（status/subscribers/lastEventId），据此决定是否需要恢复 UI 状态 |
| `session.status {streaming\|idle}` | run 状态指示（转圈/空闲） |
| `session.status_changed` | 会话迁移提示（fork/branch 后旧 sid → 新 sid 重定向） |
| `message.started {role,messageId}` | 开新 message part；role=user 忽略（本地已乐观渲染） |
| `text.delta {messageId,delta}` | assistant message 追加文本（append） |
| `message.completed {role,messageId,stopReason,usage}` | 落定消息；stopReason=error 显示错误横幅（errorMessage 在 omp.raw/error 事件内） |
| `tool.started {callId,name,args}` | tool-call part（进行中）；**args（v1.1 新增）供 a2ui 卡片渲染** |
| `tool.completed {callId,result}` | tool-call part 补结果；与 started 按 callId 配对 |
| `tool.confirm_required {approvalId,tool,args{full,compact},timeoutSec}` | 审批卡片：full 文本 + approve/deny 按钮 + timeoutSec 倒计时 → `POST /:sid/approvals/:approvalId {approve,reason?}`；超时后端自动拒绝（404=已决） |
| `turn.completed {isTerminal,usage}` | isTerminal → run finish；usage 气泡（input/output/cost） |
| `model.changed {provider,modelId}` | 模型徽标更新 |
| `thinking.changed {level}` | thinking part 开关 |
| `agents.changed {agents}` | Agent Hub 名册重渲染 |
| `notice {level,text}` | toast（warning/error 高亮） |
| **v1.2 面板事件** | |
| `todo.reminder {todos,attempt,maxAttempts}` | Todo 面板刷新（含提醒次数徽标） |
| `todo.cleared` | Todo 面板清空 |
| `goal.updated {goal,state}` | 目标模式面板 |
| `queue.updated {steering,followUp,liveSteered}` | 队列徽标（待发送条数） |
| `compaction.started {manual,reason?,action?}` | 上下文条显示"压缩中"；reason=threshold/overflow/idle/incomplete |
| `compaction.completed {manual,aborted,willRetry?,skipped?,error?}` | 压缩结果 toast；willRetry → 继续等待 |
| `retry.started {attempt,maxAttempts,delayMs,errorMessage}` | 重试横幅（第 N/M 次，倒计时 delayMs） |
| `retry.completed {success,attempt,finalError?}` | 重试结局 toast（失败显示 finalError） |
| `model.fallback {from,to,role,reason?,succeeded?}` | 模型回退提示（succeeded=false=切换，true=回退成功） |
| `config.warnings` | 重新拉取 `/api/sessions/:sid/maintenance` 提示配置告警 |
| `rules.triggered {rules}` | 规则触发提示（ttsr） |
| `omp.raw` | 兜底：未知事件开发态展示，生产忽略 |

## 控制台面板数据面（DESIGN §21，按需拉取/轮询）

| 面板 | 端点 |
|---|---|
| 命令菜单（`/` 输入） | `GET /:sid/commands`（slashCommands/customCommands/mcpPrompts/templates） |
| 模型选择器 | `GET /:sid/models`（models + current + thinkingLevels/effortSelectors） |
| 思考档位 | `GET/PUT /:sid/thinking` |
| Todo 面板 | `GET/PUT /:sid/todos`（PUT=手工编辑，落 user_todo_edit） |
| 上下文条 | `GET /:sid/context`（usage + breakdown） |
| 状态栏/模式 | `GET /:sid/modes`（plan/goal/vibe/prewalk/checkpoint/rewind/usageLimit/serviceTier + 运行标志） |
| Plan 模式 | `GET /:sid/plan`（state + referencePath） |
| 维护状态 | `GET /:sid/maintenance`（autoCompaction/autoRetry/cacheWarming/promptCache） |
| 分叉历史树 | `GET /:sid/session-tree`（leafId + tree） |
| 停止按钮组 | `POST /:sid/interrupt {target: retry\|compaction\|handoff\|branch-summary\|bash\|eval\|all}` |
| 队列 | `DELETE /:sid/queue`（整清）/ `POST /:sid/queue/remove`（单条） |
| 自动标题 | `POST /:sid/title/generate` |
| 模型目录（全局） | `GET /api/me/models`（含 cost/contextWindow 能力） |
| Provider/Agent 配置表单 | `GET /api/me/config/schema`（字段/正则/示例）+ 结构化 `PUT /api/me/models/config`、`PUT|POST /api/me/agents`（DESIGN §30） |
| 会话检索 | `GET /api/sessions?q=`（标题）/ `GET /api/sessions/search?q=`（正文 snippet） |

## a2ui 工具卡片映射（按 tool.started.name + args / tool.completed.result）

| 工具 | 卡片 | 数据来源 |
|---|---|---|
| `bash` | 终端卡（命令 + 退出码 + 输出） | args.command / result.content[].text |
| `edit` / `write` | diff 卡（文件路径 + patch） | args.path/args.filePath / result diff 文本 |
| `read` | 文件预览卡 | args.path / result.content[].text |
| `grep`/`glob`/`find`/`ls` | 结果列表卡 | result.content[].text |
| `task` | 子代理卡（联动 Agent Hub 面板） | args.description / agents.changed |
| `web_search`/`github`/`browser` | 来源卡 | result 结构化字段 |
| MCP（`mcp__*`） | 通用 JSON 卡 | args/result 全量 |

## 审批 UI 状态机

`idle → (tool.confirm_required) asking(倒计时 timeoutSec) → (POST 200) settled`
；POST 409（会话不 live）/404（已决/超时）→ 回 idle 并刷新 pending 清单
`GET /:sid/approvals`。开启开关：`GET/PUT /api/me/approval {mode, policies}`（M7）。
