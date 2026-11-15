# 网关错误码契约（v1）

所有错误响应体统一为：

```json
{ "error": { "code": "SESSION_NOT_LIVE", "message": "human readable", "details": { } } }
```

`details` 可选（如流式队列统计、限额信息）。集成方**按 code 分支**，不要解析 message。
传输层：`Retry-After`（429）、`Idempotency-Replayed`（幂等命中）、`X-Request-Id`（全链路）。

## 认证与权限（4xx）

| code | status | 含义 / 处理建议 |
|---|---|---|
| `UNAUTHORIZED` | 401 | svc-token 缺失/错误（恒时比较）。检查 `Authorization: Bearer` |
| `INVALID_USER_ID` | 400 | `X-User-Id` 缺失或字符集非法（`USER_ID_RE`） |
| `FORBIDDEN` | 403 | 分享令牌访问非授权面 / 内部面被拒（`SHARE_TOKEN_FORBIDDEN` 场景） |
| `ADMIN_REQUIRED` | 403 | `/admin/*` 缺 `X-Admin-Id`（全局管理由上游注入标识） |
| `TENANT_DISABLED` | 403 | 租户被禁用（`/internal` 状态机），上游应停止调用 |

## 分享令牌（403 / 404）

| code | status | 含义 |
|---|---|---|
| `SHARE_VIEW_ONLY` | 403 | view 令牌只读；写端点需 control |
| `SHARE_SESSION_SCOPED` | 403 | 令牌绑定单会话，访问其他 sid |
| `SHARE_CONTROL_LIMITED` | 403 | control 令牌白名单外端点 |

## 会话与生命周期（404 / 409 / 429 / 503）

| code | status | 含义 / 处理建议 |
|---|---|---|
| `NOT_FOUND` | 404 | 会话/资源不存在或**跨租户不可见**（不区分，防枚举） |
| `SESSION_ARCHIVED` | 409 | 会话已归档（只读）。先 `POST /:sid/resume` 或转 active |
| `SESSION_NOT_LIVE` | 409 | 无内存会话且无 sessionFile 可复活（需先 prompt/恢复） |
| `SESSION_BUSY` | 409 | 会话有进行中的互斥操作（compact/rollback 等要求 idle） |
| `SESSION_STREAMING` | 409 | 端点要求 idle（如 reset/rollback），当前 streaming |
| `SESSION_LIMIT` | 429/409 | 超过 `maxSessions`/`maxConcurrent` 限额（上游扩额或归档旧会话） |
| `STREAM_QUEUE_TIMEOUT` | 429 | streaming 槽位排队超时；按 `Retry-After` 退避（配 Idempotency-Key） |
| `RATE_LIMITED` | 429 | RPM 滑动窗口超限；按 `Retry-After` 重试 |
| `BUDGET_EXCEEDED` | 402 | 月度预算硬约束；联系上游调整 `monthlyBudgetUsd` |
| `DRAINING` | 503 | 实例关停中；上游切流到其他实例 |
| `GATEWAY_UNCONFIGURED` | 503 | 网关未配置（缺 svc-token），运维问题 |

## 模型与凭据（404 / 409）

| code | status | 含义 |
|---|---|---|
| `MODEL_NOT_FOUND` | 404 | provider/modelId 不在该用户目录（`GET /me/models` 确认） |
| `MODEL_UNAVAILABLE` | 409 | 会话无可用模型（未配 models.yml/凭据），或切模型后不可用 |
| `PROVIDER_NOT_ALLOWED` | 403 | `additionalDirectories`/provider 越权（用户根守卫） |
| `NO_MESSAGES` | 409 | 标题生成无用户消息 |
| `TITLE_FAILED` | 409 | 标题生成失败（模型错误，看 message） |

## SDK 操作（多为 409，语义=当前状态不允许）

| code | status | 含义 |
|---|---|---|
| `COMPACT_FAILED` | 409 | 压缩失败（小上下文/无内容可压） |
| `HANDOFF_FAILED` | 409 | 移交失败（通常需更大上下文） |
| `FORK_FAILED` / `FORK_REJECTED` | 409/500 | 分叉失败/被拒（entryId 非法或状态不符） |
| `BRANCH_FAILED` / `BRANCH_CANCELLED` | 409 | 原地分支失败/取消 |
| `FRESH_REJECTED` | 409 | freshSession 被拒（状态不符） |
| `RESET_FAILED` | 409 | 上下文重置失败 |
| `FOLLOW_UP_FAILED` | 409 | follow-up 入队失败（非 streaming 或非法） |
| `CUSTOM_MESSAGE_FAILED` | 409 | 自定义消息投递失败 |
| `QUEUE_CLEAR_FAILED` | 409 | 队列清理失败 |
| `NOT_SUPPORTED` | 409 | 该 SDK 版本/会话不支持（如 todo 编辑） |
| `NOT_REVIVABLE` | 409 | 子代理无持久化 transcript，无法复活 |
| `REVIVE_FAILED` | 409 | 子代理复活失败（workspace 丢失/契约缺失） |
| `AGENT_NOT_LIVE` | 409 | 子代理 parked/killed 且复活失败 |
| `AGENT_ALREADY_LIVE` | 409 | 子代理已 live，无需 revive |
| `AGENT_CHAT_FAILED` | 409 | 子代理 chat 失败 |
| `MCP_DISABLED` | 409 | 会话 `enableMcp:false`，无 MCP manager |
| `MCP_RELOAD_FAILED` | 409 | MCP reload 失败（服务器连接错误） |

## 资源与文件（400 / 404 / 413）

| code | status | 含义 |
|---|---|---|
| `BAD_REQUEST` | 400 | 参数校验失败（看 message 指明字段） |
| `CONFIRM_REQUIRED` | 400 | 危险操作需 `confirm:true`（级联删除等） |
| `INVALID_JSON` | 400 | JSON 语法错误（MCP/结构化配置请求体） |
| `INVALID_YAML` | 400 | models.yml 语法或根结构错误（如 `providers` 不是映射） |
| `INVALID_CONFIG` | 400 | 结构化配置字段校验失败（message 含字段路径，如 `providers.p.models[0].id`） |
| `INVALID_PROVIDER` | 400 | provider id 不合规（`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`） |
| `INVALID_AGENT` | 400 | 结构化 agent 定义校验失败（未知字段/缺 description/instructions/别名冲突） |
| `INVALID_FRONTMATTER` | 400 | agent frontmatter 缺失或 YAML 解析失败 |
| `INVALID_NAME` | 400 | skill/plugin/agent 命名不合规（正则见 DESIGN §18/§28） |
| `INVALID_RANGE` | 400 | Range 头非法/不可满足（文件下载） |
| `PATH_FORBIDDEN` | 403/400 | 路径穿越/越出 workspace（三重守卫） |
| `IS_DIRECTORY` | 400 | 对目录执行文件操作 |
| `FILE_TOO_LARGE` | 413 | 单文件超限（读 25MB / 写 5MB / 插件 2MB） |
| `PAYLOAD_TOO_LARGE` | 413 | 请求体超 `GATEWAY_BODY_LIMIT_MB`（默认 20MB）或配置文本超限 |
| `YAML_UNAVAILABLE` | 500 | 运行时缺少 `Bun.YAML`（网关要求 Bun >= 1.2） |
| `SNAPSHOT_EMPTY` | 409 | 零 turn 会话无可快照内容 |
| `SNAPSHOT_NOT_FOUND` | 404 | 快照 id 不存在（或被 Pruner 清理） |
| `SNAPSHOT_FAILED` | 409/500 | 快照创建/恢复失败 |
| `NOT_A_GIT_REPO` | 409 | workspace 非 git 仓库 |
| `GIT_UNAVAILABLE` | 503 | git 可执行文件不可用 |
| `GIT_TIMEOUT` | 504/409 | git 子进程超时（15s） |
| `GIT_FAILED` | 409 | git 命令失败（message 含 stderr 截断） |
| `ALREADY_EXISTS` | 409 | 资源已存在（rename/mkdir 冲突） |
| `MANIFEST_INVALID` | 400 | 迁移 bundle 的 manifest 缺失/格式不符/校验和不过（DESIGN §32） |
| `SCHEMA_VERSION_MISMATCH` | 400 | DB schema 版本高于当前网关支持（import 与 boot 双向检查） |
| `GATEWAY_NOT_DRAINED` | 409 | export/import 要求实例已 drain 且无活跃会话 |
| `BUNDLE_INCOMPLETE` | 400 | bundle 内容不完整（db sha256 或文件计数对账失败） |
| `INTERNAL` | 500 | 未预期错误（记录日志；带 X-Request-Id 报障） |

## SSE 传输层错误（event: error）

SSE 建连后若会话不可用，以 `event: error` 帧返回（不是 HTTP 状态）：

```json
{ "code": "NOT_FOUND" }          // 会话不存在/跨租户
{ "code": "SESSION_NOT_LIVE" }   // 无文件可复活
```

收到后应停止重连（除非业务上会 resume）。

## 变更记录

- v1.1（2026-11-15）：新增结构化配置错误码（`INVALID_CONFIG`/`INVALID_PROVIDER`/`INVALID_AGENT`/
  `INVALID_FRONTMATTER`/`INVALID_YAML`/`YAML_UNAVAILABLE`，DESIGN §30）。
- v1（2026-11-15）：从 M1-M11 实现全量反推；与 `src/routes/*.ts` 的 `jsonError` 调用一一对应。
