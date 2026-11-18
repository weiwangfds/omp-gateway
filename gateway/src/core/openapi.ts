import type { Hono } from "hono";

/**
 * OpenAPI 3.1 契约生成器（DESIGN §12 契约冻结，§33 后随实现演进）。
 *
 * 两层来源：
 *  1. 路由表内省（paths/methods/路径参数，route() 已合并挂载前缀）
 *  2. SUMMARIES 操作级摘要表（每个操作一条，覆盖 100% 操作；缺键回退 "METHOD path" 字面）
 *
 * 语义细节以 docs/DESIGN.md 与 contracts/* 为准；本文件只做机器可读投影。
 */

/** gateway-events 全量事件类型（与 contracts/gateway-events.v1.schema.json 的枚举保持一致，测试对账）。 */
export const GATEWAY_EVENT_TYPES = [
  "session.status",
  "session.status_changed",
  "replay.state",
  "message.started",
  "message.completed",
  "text.delta",
  "tool.started",
  "tool.completed",
  "tool.confirm_required",
  "turn.completed",
  "model.changed",
  "thinking.changed",
  "agents.changed",
  "notice",
  // v1.2 控制台面板事件
  "todo.reminder",
  "todo.cleared",
  "goal.updated",
  "queue.updated",
  "compaction.started",
  "compaction.completed",
  "retry.started",
  "retry.completed",
  "model.fallback",
  "config.warnings",
  "rules.triggered",
  // v1.3 业务事件
  "business.event",
  "business.completed",
  "omp.raw",
  // v1.4 TUI 终端桥（events.ts 已发布、SSE 可回放，此前枚举漏登）
  "tui.entry",
] as const;

/** 错误码契约投影（contracts/error-codes.md 的机器可读版；按 code 分支，勿解析 message）。 */
export const GATEWAY_ERROR_CODES: Record<string, string> = {
  UNAUTHORIZED: "401 svc-token 缺失/错误",
  INVALID_USER_ID: "400 X-User-Id 缺失或非法",
  FORBIDDEN: "403 分享令牌访问非授权面",
  SHARE_TOKEN_FORBIDDEN: "403 分享令牌访问内部/配置面",
  SHARE_VIEW_ONLY: "403 view 令牌只读",
  SHARE_SESSION_SCOPED: "403 令牌绑定单会话",
  SHARE_CONTROL_LIMITED: "403 control 令牌白名单外",
  ADMIN_REQUIRED: "403 /admin/* 缺 X-Admin-Id",
  NOT_FOUND: "404 不存在或跨租户不可见（不区分，防枚举）",
  SESSION_ARCHIVED: "409 会话已归档（只读）",
  SESSION_NOT_LIVE: "409 无内存会话且无文件可复活",
  SESSION_BUSY: "409 有进行中的互斥操作",
  SESSION_STREAMING: "409 端点要求 idle，当前 streaming",
  SESSION_LIMIT: "429/409 超 maxSessions/maxConcurrent",
  STREAM_QUEUE_TIMEOUT: "429 流式槽位排队超时（Retry-After 退避）",
  RATE_LIMITED: "429 RPM 滑动窗口超限（Retry-After）",
  BUDGET_EXCEEDED: "402 月度预算硬约束",
  MODEL_NOT_FOUND: "404 provider/modelId 不在该用户目录",
  MODEL_UNAVAILABLE: "409 无可用模型（未配置或已失效）",
  INVALID_CONFIG: "400 结构化配置字段校验失败",
  INVALID_PROVIDER: "400 provider id 不合规",
  INVALID_AGENT: "400 结构化 agent 定义校验失败",
  INVALID_FRONTMATTER: "400 agent frontmatter 缺失/解析失败",
  INVALID_SESSION_FILE: "400 会话 JSONL 校验失败",
  CONFIRM_REQUIRED: "400 危险操作需 confirm",
  PATH_FORBIDDEN: "403/400 路径越界（三重守卫）",
  FILE_TOO_LARGE: "413 文件超限（读 2MB/写 5MB/raw 流 25MB/插件 2MB）",
  SNAPSHOT_EMPTY: "409 零 turn 会话无可快照内容",
  ALREADY_EXISTS: "409 资源已存在",
  MAINTENANCE_BUSY: "409 迁移操作进行中",
  MANIFEST_INVALID: "400 迁移 bundle manifest 缺失/不符",
  SCHEMA_VERSION_MISMATCH: "400 DB schema 版本高于当前网关",
  GATEWAY_NOT_DRAINED: "409 export/import 要求实例已 drain",
  BUNDLE_INCOMPLETE: "400 bundle 校验和/计数对账失败",
  DRAINING: "503 实例关停中，切流到其他实例",
  GATEWAY_UNCONFIGURED: "503 未配置 svc-token（运维问题）",
  INVALID_SLUG: "400 KB slug 不合 skill 名规",
  INVALID_DOC_NAME: "400 KB 文档名清洗后仍不合规",
  INVALID_ZIP: "400 MinerU zip 缺 markdown.md / 非法条目 / 分组路径非法 / 魔数不符",
  KB_NOT_FOUND: "404 知识库不存在",
  DOC_NOT_FOUND: "404 知识库文档不存在（或 source.pdf 未补传）",
  WREN_DISABLED: "409 数据查询层未启用（WREN_MCP!=1）",
  WREN_UNAVAILABLE: "503 wren CLI 不可用（WREN_BIN/PATH 均未找到）",
  // ---- 以下为 ERRORS 表已引用但此前漏登的码（与 contracts/error-codes.md 对账补齐） ----
  BAD_REQUEST: "400 参数校验失败（看 message 指明字段）",
  INVALID_JSON: "400 JSON 语法错误（MCP/结构化配置请求体）",
  INVALID_YAML: "400 models.yml 语法或根结构错误（如 `providers` 不是映射）",
  INVALID_NAME: "400 skill/plugin/agent 命名不合规（正则见 DESIGN §18/§28）",
  INVALID_RANGE: "400 Range 头非法/不可满足（文件下载）",
  PAYLOAD_TOO_LARGE: "413 请求体超 GATEWAY_BODY_LIMIT_MB（默认 20MB）或配置文本超限",
  PROVIDER_NOT_ALLOWED: "403 additionalDirectories/provider 越权（用户根守卫）",
  INPUT_BLOCKED: "403 输入被集成端 input 钩子拦截",
  TENANT_DISABLED: "403 租户被禁用（/internal 状态机），上游应停止调用",
  NOT_A_GIT_REPO: "409 workspace 非 git 仓库",
  GIT_FAILED: "409 git 命令失败（message 含 stderr 截断）",
  NOT_SUPPORTED: "409 该 SDK 版本/会话不支持（如 todo 编辑）",
  NOT_REVIVABLE: "409 子代理无持久化 transcript，无法复活",
  REVIVE_FAILED: "409 子代理复活失败（workspace 丢失/契约缺失）",
  AGENT_ALREADY_LIVE: "409 子代理已 live，无需 revive",
  AGENT_NOT_LIVE: "409 子代理 parked/killed 且复活失败",
  AGENT_CHAT_FAILED: "409 子代理 chat 失败",
  COMPACT_FAILED: "409 压缩失败（小上下文/无内容可压）",
  RESET_FAILED: "409 上下文重置失败",
  HANDOFF_FAILED: "409 移交失败（通常需更大上下文）",
  FOLLOW_UP_FAILED: "409 follow-up 入队失败（非 streaming 或非法）",
  CUSTOM_MESSAGE_FAILED: "409 自定义消息投递失败",
  QUEUE_CLEAR_FAILED: "409 队列清理失败",
  NO_MESSAGES: "409 标题生成无用户消息",
  TITLE_FAILED: "409 标题生成失败（模型错误，看 message）",
  MCP_DISABLED: "409 会话 enableMcp:false，无 MCP manager",
  MCP_RELOAD_FAILED: "409 MCP reload 失败（服务器连接错误）",
  MCP_RECONNECT_FAILED: "409 MCP 单服务器重连失败",
  INJECT_FAILED: "409 集成端上下文注入失败",
  BUSINESS_EVENT_INJECT_FAILED: "409 业务事件已登记但上下文注入失败",
  FORK_REJECTED: "409 fork 被 hook 拒绝或会话未持久化",
  FORK_FAILED: "409/500 fork 执行失败（workspace 拷贝等）",
  FRESH_REJECTED: "409 freshSession 被拒（状态不符）",
  BRANCH_CANCELLED: "409 branch 被 hook 取消",
  BRANCH_FAILED: "409 branch 执行失败",
  EXPORT_FAILED: "500 导出 bundle 失败",
  IMPORT_FAILED: "500 导入 bundle 失败",
};

const ERROR_SCHEMA_REF = { $ref: "#/components/schemas/Error" };

/** 常用请求体（轻量 JSON Schema；复杂语义由 SUMMARIES 对应条目的摘要补充说明）。 */
const BODY = {
  prompt: {
    type: "object",
    required: ["text"],
    properties: {
      text: { type: "string" },
      images: {
        type: "array",
        items: { type: "object", properties: { data: { type: "string" }, mimeType: { type: "string" } } },
      },
      streamingBehavior: { type: "string", enum: ["steer", "followUp"] },
      wait: { type: "boolean", description: "同步等待 turn 终态（默认 false，事件走 SSE）" },
      waitTimeoutMs: { type: "integer" },
    },
  },
  inject: {
    type: "object",
    required: ["text"],
    properties: {
      text: { type: "string" },
      mode: { type: "string", enum: ["context", "user"], description: "context=不触发 turn；user=触发 turn" },
      customType: { type: "string" },
      deliverAs: { type: "string", enum: ["steer", "followUp", "nextTurn", "aside"] },
      triggerTurn: { type: "boolean" },
      wait: { type: "boolean" },
    },
  },
  businessEvent: {
    type: "object",
    required: ["type"],
    properties: {
      type: { type: "string", description: "业务事件类型（≤128 字符）" },
      data: { type: "object", description: "与 text 二选一；自动 JSON.stringify 后注入" },
      text: { type: "string" },
      inject: { type: "boolean", default: true },
      triggerTurn: { type: "boolean" },
      deliverAs: { type: "string", enum: ["steer", "followUp", "nextTurn", "aside"] },
      wait: { type: "boolean" },
    },
  },
  approvalDecision: {
    type: "object",
    required: ["approve"],
    properties: { approve: { type: "boolean" }, reason: { type: "string" } },
  },
  modelRef: {
    type: "object",
    required: ["provider", "modelId"],
    properties: { provider: { type: "string" }, modelId: { type: "string" }, role: { type: "string" } },
  },
  createSession: {
    type: "object",
    properties: {
      title: { type: "string" },
      model: { type: "object", properties: { provider: { type: "string" }, modelId: { type: "string" } } },
      appendSystemPrompt: { type: "string" },
      systemPrompt: { type: "string", description: "完整替换内置系统提示词（≤256KB，与 append 互斥）" },
      contextFiles: {
        type: "array",
        description: "≤20 条 {path,content}，合计 ≤1MB；内容进系统提示词不落盘",
        items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
      },
      thinkingLevel: { type: "string" },
      restrictTools: { type: "array", items: { type: "string" } },
      enableMcp: { type: "boolean" },
      enableLsp: { type: "boolean" },
      additionalDirectories: { type: "array", items: { type: "string" }, description: "仅允许用户数据根内路径" },
    },
  },
  webhookRegister: {
    type: "object",
    required: ["url"],
    properties: {
      url: { type: "string" },
      events: { type: "array", items: { type: "string" }, description: "gateway-events 类型或 *；缺省 *" },
      secret: { type: "string", description: "≥8 字符；缺省生成 whsec_（仅创建响应返回一次）" },
    },
  },
  hookRegister: {
    type: "object",
    required: ["event", "url"],
    properties: {
      event: { type: "string", description: "21 个生命周期事件之一（GET 列表返回）" },
      url: { type: "string" },
      mode: { type: "string", enum: ["notify", "decide"], description: "decide 同步等决策，仅决策型事件支持" },
      matcher: { type: "object" },
      timeoutMs: { type: "integer" },
      onTimeout: { type: "string", enum: ["allow", "deny"] },
      secret: { type: "string" },
    },
  },
  httpToolRegister: {
    type: "object",
    required: ["description", "url", "parameters"],
    properties: {
      description: { type: "string" },
      url: { type: "string" },
      parameters: { type: "object", description: "JSON Schema（工具入参）" },
      label: { type: "string" },
      timeoutMs: { type: "integer" },
      approval: { type: "string" },
      secret: { type: "string" },
    },
  },
  importSession: { type: "string", description: "会话 JSONL 原文（NDJSON，≤20MB）；缺 model_change 时自动补一条" },
  modelsConfigJson: {
    type: "object",
    required: ["providers"],
    properties: {
      providers: {
        type: "object",
        additionalProperties: {
          type: "object",
          properties: {
            baseUrl: { type: "string" },
            api: { type: "string" },
            apiKey: { type: "string", description: "环境变量名或字面量" },
            models: {
              type: "array",
              items: {
                type: "object",
                properties: { id: { type: "string" }, name: { type: "string" }, contextWindow: { type: "integer" } },
              },
            },
          },
        },
      },
    },
  },
  agentDefinition: {
    type: "object",
    required: ["description", "instructions"],
    properties: {
      description: { type: "string" },
      instructions: { type: "string" },
      tools: { type: "array", items: { type: "string" } },
      model: { type: "string" },
      thinkingLevel: { type: "string", enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"] },
      spawns: { type: "string" },
      prewalk: { type: "string" },
      advisor: { type: "string" },
      content: { type: "string", description: "原文通道：完整 markdown，不可与结构化字段混用" },
    },
  },
  migrationImport: {
    type: "object",
    required: ["path", "confirm"],
    properties: {
      path: { type: "string", description: "bundle 目录（须在 GATEWAY_IMPORT_DIRS 白名单内）" },
      confirm: { type: "string", enum: ["REPLACE"] },
    },
  },
  kbCreate: {
    type: "object",
    required: ["slug"],
    properties: {
      slug: { type: "string", description: "KB 标识（^[a-z0-9][a-z0-9-]{0,63}$），skill 名恒为 kb-<slug>" },
      title: { type: "string", description: "展示标题（缺省 = slug）" },
    },
  },
  wrenDatasource: {
    type: "object",
    required: ["datasource", "connection"],
    properties: {
      datasource: {
        type: "string",
        description: "wren 类型（如 postgres/clickhouse；权威字段见 wren docs connection-info）",
      },
      connection: {
        type: "object",
        description:
          "连接字段（postgres: host/port/database/user/password；clickhouse: host/httpPort/database/user/password）",
        additionalProperties: true,
      },
      tables: {
        type: "array",
        nullable: true,
        items: { type: "string" },
        description: '内省白名单（"schema.table" 精确匹配）；缺省/null = 全部非系统表',
      },
    },
  },
  wrenTestRequest: {
    type: "object",
    description: "缺省测注册表既有条目；给 datasource+connection 即测未落库载荷",
    properties: {
      datasource: { type: "string" },
      connection: { type: "object", additionalProperties: true },
    },
  },
  wrenSyncRequest: {
    type: "object",
    description:
      "缺省按 drift 检测同步（catalogHash 相同短路）；force=true 跳过短路（无内省器类型仅重编译 + 重启 daemon）",
    properties: {
      force: { type: "boolean", description: "强制同步（跳过 drift 短路，无条件 context build + daemon 重启）" },
    },
  },
} as const;

/* ── 操作级文档表 ──────────────────────────────────────────────────────────
 * 键 = "METHOD /openapi路径"（与 openapi.json 的 paths 一致）。
 * SUMMARIES 覆盖**全部**操作（无族级兜底）；QUERIES 声明查询参数；ERRORS 声明专属错误码；
 * BODIES 声明请求体；RESPONSES 指向 components.schemas 里的响应模型。
 * 新增路由时四张表一起补——test/detailed-endpoints.test.ts 会守住覆盖率 100%。
 */

/** 查询参数声明。 */
const QUERIES: Record<string, Array<{ name: string; description: string; schema?: Record<string, unknown> }>> = {
  "GET /api/sessions": [
    {
      name: "status",
      description: "会话状态过滤（active|archived|deleted，缺省 active）",
      schema: { type: "string", enum: ["active", "archived", "deleted"] },
    },
    { name: "q", description: "标题/ID 模糊过滤（SQL LIKE）" },
    { name: "page", description: "页码（0 起）", schema: { type: "integer", minimum: 0 } },
    { name: "per_page", description: "每页条数（上限 200）", schema: { type: "integer", minimum: 1, maximum: 200 } },
  ],
  "GET /api/sessions/search": [
    { name: "q", description: "正文关键词（≥2 字符）" },
    { name: "limit", description: "返回条数上限（1-50）", schema: { type: "integer", minimum: 1, maximum: 50 } },
    { name: "maxFiles", description: "扫描文件数上限（1-500）", schema: { type: "integer", minimum: 1, maximum: 500 } },
  ],
  "GET /api/sessions/{sid}/messages": [{ name: "since", description: "只返回序号 ≥ since 的消息" }],
  "GET /api/sessions/{sid}/entries": [
    { name: "type", description: "条目类型过滤（逗号分隔，如 message,model_change）" },
    { name: "offset", description: "偏移" },
    { name: "limit", description: "条数（1-2000）" },
  ],
  "GET /api/sessions/{sid}/events": [
    { name: "types", description: "事件类型过滤（逗号分隔，后缀通配如 tool.*；replay.state 永远放行）" },
  ],
  "GET /api/sessions/{sid}/events/replay": [
    { name: "since", description: "游标：只返回 seq > since 的事件" },
    { name: "limit", description: "单次返回上限（1-500）", schema: { type: "integer", minimum: 1, maximum: 500 } },
    { name: "types", description: "事件类型过滤（同 SSE）" },
  ],
  "GET /api/sessions/{sid}/context": [{ name: "contextWindow", description: "按指定窗口计算上下文占用" }],
  "GET /api/sessions/{sid}/mcp/servers/{name}/resources": [
    { name: "refresh", description: "设为 1 先向服务器刷新资源再返回" },
  ],
  "GET /api/me/models": [
    { name: "find", description: "按 provider/modelId/name 模糊搜索" },
    { name: "provider", description: "只看某个 provider" },
    { name: "refresh", description: "设为 1 先刷新目录（联网 discovery）" },
  ],
  "GET /api/me/models/config": [
    {
      name: "format",
      description: "设为 json 返回结构化视图（默认原文 YAML）",
      schema: { type: "string", enum: ["json"] },
    },
  ],
  "GET /api/me/agents/{name}": [
    {
      name: "format",
      description: "设为 json 返回规范字段 + frontmatter（默认 markdown 原文）",
      schema: { type: "string", enum: ["json"] },
    },
  ],
  "GET /admin/global/agents/{name}": [
    {
      name: "format",
      description: "设为 json 返回规范字段 + frontmatter（默认 markdown 原文）",
      schema: { type: "string", enum: ["json"] },
    },
  ],
  "GET /api/me/usage": [
    { name: "group", description: "分桶维度", schema: { type: "string", enum: ["day", "model", "session"] } },
    { name: "from", description: "起始日期（含）" },
    { name: "to", description: "结束日期（含当天）" },
  ],
  "GET /internal/users/{uid}/usage": [
    { name: "group", description: "分桶维度", schema: { type: "string", enum: ["day", "model", "session"] } },
    { name: "from", description: "起始日期（含）" },
    { name: "to", description: "结束日期（含当天）" },
  ],
  "GET /internal/audit": [
    { name: "user", description: "按用户过滤（匹配 actor 或 on_behalf_of）" },
    { name: "action", description: "按动作过滤" },
    { name: "page", description: "页码（1 起）", schema: { type: "integer", minimum: 1 } },
    { name: "per_page", description: "每页条数（1-200）", schema: { type: "integer", minimum: 1, maximum: 200 } },
  ],
  "DELETE /api/sessions/{sid}": [{ name: "confirm", description: "必须等于 sid 才执行删除" }],
  "DELETE /internal/users/{uid}": [{ name: "confirm", description: "必须等于 uid 才执行级联删除" }],
  "POST /internal/drain": [{ name: "off", description: "设为 1 恢复接单" }],
  "POST /internal/maintenance/export": [
    { name: "keepDrained", description: "设为 1 则导出后保持排空态（默认自动恢复接单）" },
  ],
  "GET /api/sessions/{sid}/file": [{ name: "path", description: "workspace 内相对路径" }],
  "GET /api/sessions/{sid}/file/raw": [{ name: "path", description: "workspace 内相对路径" }],
  "PUT /api/sessions/{sid}/file": [{ name: "path", description: "workspace 内相对路径" }],
  "DELETE /api/sessions/{sid}/file": [{ name: "path", description: "workspace 内相对路径" }],
  "GET /api/sessions/{sid}/tree": [
    { name: "path", description: "子目录起点（缺省 workspace 根）" },
    { name: "depth", description: "递归深度（默认 3，上限 8）", schema: { type: "integer" } },
    { name: "max", description: "最大条目数（默认 2000）", schema: { type: "integer" } },
  ],
  "GET /api/sessions/{sid}/files/index": [{ name: "q", description: "按名模糊查询文件索引" }],
  "GET /api/sessions/{sid}/git/log": [{ name: "limit", description: "提交条数（1-100）", schema: { type: "integer" } }],
  "GET /api/sessions/{sid}/git/diff": [
    { name: "path", description: "只看某个路径" },
    { name: "staged", description: "设为 1 看已暂存区" },
    { name: "stat", description: "设为 1 只出统计" },
    { name: "base", description: "对比基线 ref（如 HEAD~1）" },
  ],
  "POST /api/sessions/{sid}/files/upload": [{ name: "path", description: "目标子目录（缺省 workspace 根）" }],
};

/** 专属错误码（状态 + code + 说明）。 */
const ERRORS: Record<string, string[]> = {
  "POST /api/sessions": ["409 SESSION_LIMIT", "403 PROVIDER_NOT_ALLOWED", "404 MODEL_NOT_FOUND", "503 DRAINING"],
  "GET /api/sessions/search": ["400 BAD_REQUEST"],
  "PATCH /api/sessions/{sid}": ["404 NOT_FOUND"],
  "DELETE /api/sessions/{sid}": ["400 CONFIRM_REQUIRED", "404 NOT_FOUND"],
  "POST /api/sessions/{sid}/prompt": [
    "400 BAD_REQUEST",
    "409 SESSION_NOT_LIVE",
    "409 MODEL_UNAVAILABLE",
    "409 SESSION_STREAMING",
    "429 STREAM_QUEUE_TIMEOUT",
    "429 RATE_LIMITED",
    "402 BUDGET_EXCEEDED",
    "403 INPUT_BLOCKED",
  ],
  "POST /api/sessions/{sid}/steer": ["409 MODEL_UNAVAILABLE", "429 STREAM_QUEUE_TIMEOUT"],
  "POST /api/sessions/{sid}/inject": ["400 BAD_REQUEST", "409 NOT_SUPPORTED", "409 INJECT_FAILED", "429 RATE_LIMITED"],
  "POST /api/sessions/{sid}/business-events": [
    "400 BAD_REQUEST",
    "409 BUSINESS_EVENT_INJECT_FAILED",
    "429 RATE_LIMITED",
  ],
  "POST /api/sessions/{sid}/approvals/{approvalId}": ["400 BAD_REQUEST", "404 NOT_FOUND"],
  "POST /api/sessions/{sid}/snapshots": ["409 SNAPSHOT_EMPTY"],
  "POST /api/sessions/{sid}/snapshots/{snapId}/restore": [
    "404 NOT_FOUND",
    "409 SESSION_STREAMING",
    "409 SNAPSHOT_EMPTY",
  ],
  "GET /api/sessions/{sid}/snapshots/{snapId}": ["404 NOT_FOUND"],
  "DELETE /api/sessions/{sid}/snapshots/{snapId}": ["404 NOT_FOUND"],
  "POST /api/sessions/{sid}/fork": ["409 SESSION_NOT_LIVE", "409 FORK_FAILED", "409 FORK_REJECTED"],
  "POST /api/sessions/{sid}/branch": ["400 BAD_REQUEST", "409 BRANCH_FAILED", "409 BRANCH_CANCELLED"],
  "POST /api/sessions/{sid}/agents/{aid}/chat": ["404 NOT_FOUND", "409 AGENT_NOT_LIVE", "409 AGENT_CHAT_FAILED"],
  "POST /api/sessions/{sid}/agents/{aid}/kill": ["404 NOT_FOUND"],
  "POST /api/sessions/{sid}/agents/{aid}/revive": [
    "404 NOT_FOUND",
    "409 AGENT_ALREADY_LIVE",
    "409 NOT_REVIVABLE",
    "409 REVIVE_FAILED",
  ],
  "POST /api/me/webhooks": ["400 BAD_REQUEST", "403 FORBIDDEN"],
  "POST /api/sessions/{sid}/webhooks": ["400 BAD_REQUEST", "403 FORBIDDEN"],
  "POST /api/me/hooks": ["400 BAD_REQUEST", "403 FORBIDDEN"],
  "POST /api/sessions/{sid}/hooks": ["400 BAD_REQUEST", "403 FORBIDDEN"],
  "PUT /api/me/tools/http/{name}": ["400 BAD_REQUEST", "400 INVALID_NAME", "403 FORBIDDEN", "413 PAYLOAD_TOO_LARGE"],
  "PUT /api/sessions/{sid}/tools/http/{name}": [
    "400 BAD_REQUEST",
    "400 INVALID_NAME",
    "403 FORBIDDEN",
    "413 PAYLOAD_TOO_LARGE",
  ],
  "PUT /api/me/models/config": ["400 INVALID_CONFIG", "400 INVALID_PROVIDER", "400 INVALID_JSON"],
  "GET /api/me/models/config": ["400 INVALID_YAML"],
  "PUT /api/me/models/providers/{provider}": ["400 INVALID_CONFIG", "400 INVALID_PROVIDER", "404 NOT_FOUND"],
  "GET /api/me/models/providers/{provider}": ["404 NOT_FOUND"],
  "DELETE /api/me/models/providers/{provider}": ["404 NOT_FOUND"],
  "POST /api/me/models/credentials": ["400 BAD_REQUEST"],
  "POST /api/me/models/test": ["400 BAD_REQUEST", "404 MODEL_NOT_FOUND"],
  "PUT /api/me/agents/{name}": ["400 INVALID_AGENT", "400 INVALID_FRONTMATTER", "400 INVALID_NAME"],
  "POST /api/me/agents": ["400 INVALID_AGENT", "400 INVALID_NAME", "409 ALREADY_EXISTS"],
  "GET /api/me/agents/{name}": ["404 NOT_FOUND"],
  "PUT /api/me/approval": ["400 BAD_REQUEST"],
  "PUT /api/me/providers/settings": ["400 BAD_REQUEST"],
  "GET /api/me/providers": ["400 INVALID_YAML"],
  "POST /api/sessions/validate": ["400 BAD_REQUEST", "413 PAYLOAD_TOO_LARGE"],
  "POST /api/sessions/import": ["400 INVALID_SESSION_FILE", "409 ALREADY_EXISTS", "413 PAYLOAD_TOO_LARGE"],
  "GET /api/sessions/{sid}/session-file": ["404 NOT_FOUND", "409 SESSION_NOT_LIVE", "413 PAYLOAD_TOO_LARGE"],
  "PUT /api/sessions/{sid}/file": ["400 PATH_FORBIDDEN", "413 FILE_TOO_LARGE", "404 NOT_FOUND"],
  "GET /api/sessions/{sid}/file": ["400 PATH_FORBIDDEN", "404 NOT_FOUND", "413 FILE_TOO_LARGE"],
  "GET /api/sessions/{sid}/file/raw": ["404 NOT_FOUND", "416 INVALID_RANGE", "413 FILE_TOO_LARGE"],
  "POST /api/sessions/{sid}/git/commit": ["409 NOT_A_GIT_REPO", "409 GIT_FAILED"],
  "POST /api/sessions/{sid}/git/worktrees": ["400 PATH_FORBIDDEN", "409 NOT_A_GIT_REPO"],
  "DELETE /api/sessions/{sid}/git/worktrees": ["400 PATH_FORBIDDEN", "409 NOT_A_GIT_REPO"],
  "GET /api/sessions/{sid}/git/status": ["409 NOT_A_GIT_REPO"],
  "GET /api/sessions/{sid}/git/log": ["409 NOT_A_GIT_REPO"],
  "GET /api/sessions/{sid}/git/diff": ["409 NOT_A_GIT_REPO"],
  "GET /api/sessions/{sid}/git/branches": ["409 NOT_A_GIT_REPO"],
  "GET /api/sessions/{sid}/git/worktrees": ["409 NOT_A_GIT_REPO"],
  "POST /api/sessions/{sid}/mcp/reload": ["404 NOT_FOUND", "409 MCP_DISABLED", "409 MCP_RELOAD_FAILED"],
  "POST /api/sessions/{sid}/mcp/servers/{name}/reconnect": [
    "404 NOT_FOUND",
    "409 MCP_DISABLED",
    "409 MCP_RECONNECT_FAILED",
  ],
  "GET /api/sessions/{sid}/mcp/servers": ["404 NOT_FOUND", "409 MCP_DISABLED"],
  "GET /api/sessions/{sid}/mcp/servers/{name}/resources": ["404 NOT_FOUND", "409 MCP_DISABLED"],
  "POST /api/sessions/{sid}/compact": ["409 SESSION_STREAMING", "409 COMPACT_FAILED"],
  "POST /api/sessions/{sid}/follow-up": ["400 BAD_REQUEST", "409 FOLLOW_UP_FAILED", "429 STREAM_QUEUE_TIMEOUT"],
  "POST /api/sessions/{sid}/messages/custom": ["400 BAD_REQUEST", "409 CUSTOM_MESSAGE_FAILED"],
  "POST /api/sessions/{sid}/reset": ["409 SESSION_STREAMING", "409 RESET_FAILED"],
  "POST /api/sessions/{sid}/handoff": ["409 SESSION_STREAMING", "409 HANDOFF_FAILED"],
  "POST /api/sessions/{sid}/model": ["409 SESSION_STREAMING", "403 PROVIDER_NOT_ALLOWED", "404 MODEL_NOT_FOUND"],
  "POST /api/sessions/{sid}/interrupt": ["400 BAD_REQUEST"],
  "POST /api/sessions/{sid}/title/generate": ["409 NO_MESSAGES", "409 TITLE_FAILED"],
  "POST /api/sessions/{sid}/file/mkdir": ["400 PATH_FORBIDDEN"],
  "POST /api/sessions/{sid}/file/rename": ["400 PATH_FORBIDDEN", "404 NOT_FOUND"],
  "POST /api/sessions/{sid}/files/upload": ["400 PATH_FORBIDDEN", "413 FILE_TOO_LARGE"],
  "PUT /api/sessions/{sid}/thinking": ["400 BAD_REQUEST", "409 NOT_SUPPORTED"],
  "PUT /api/sessions/{sid}/todos": ["400 BAD_REQUEST", "409 NOT_SUPPORTED"],
  "PUT /api/sessions/{sid}/tools": ["400 BAD_REQUEST"],
  "PUT /api/sessions/{sid}/entries/{entryId}/label": ["400 BAD_REQUEST", "404 NOT_FOUND", "409 NOT_SUPPORTED"],
  "DELETE /api/sessions/{sid}/entries/{entryId}/label": ["404 NOT_FOUND", "409 NOT_SUPPORTED"],
  "POST /internal/users/{uid}/provision": ["403 TENANT_DISABLED"],
  "DELETE /internal/users/{uid}": ["400 CONFIRM_REQUIRED"],
  "POST /internal/trash/sessions/{sid}/restore": ["404 NOT_FOUND"],
  "POST /internal/trash/users/{uid}/restore": ["404 NOT_FOUND"],
  "POST /internal/maintenance/export": ["409 MAINTENANCE_BUSY", "500 EXPORT_FAILED"],
  "POST /internal/maintenance/import": [
    "400 MANIFEST_INVALID",
    "400 SCHEMA_VERSION_MISMATCH",
    "400 BUNDLE_INCOMPLETE",
    "403 PATH_FORBIDDEN",
    "409 MAINTENANCE_BUSY",
    "500 IMPORT_FAILED",
  ],
  "PUT /admin/global/skills/{name}": ["400 INVALID_NAME"],
  "PUT /admin/global/plugins/{name}": ["400 INVALID_NAME"],
  "PUT /admin/global/mcp": ["400 INVALID_JSON"],
  "POST /admin/kb": ["400 INVALID_SLUG", "409 ALREADY_EXISTS"],
  "GET /admin/kb": [],
  "POST /admin/kb/{slug}/upload": [
    "400 INVALID_ZIP",
    "400 INVALID_DOC_NAME",
    "404 KB_NOT_FOUND",
    "413 PAYLOAD_TOO_LARGE",
  ],
  "POST /admin/kb/{slug}/pdf": ["400 BAD_REQUEST", "404 KB_NOT_FOUND", "404 DOC_NOT_FOUND", "413 PAYLOAD_TOO_LARGE"],
  "GET /admin/kb/{slug}/pdf/{doc}": ["400 INVALID_SLUG", "404 KB_NOT_FOUND", "404 DOC_NOT_FOUND"],
  "GET /admin/kb/{slug}/tree": ["400 INVALID_SLUG", "404 KB_NOT_FOUND"],
  "GET /admin/kb/{slug}/index-status": ["400 INVALID_SLUG", "404 KB_NOT_FOUND"],
  "DELETE /admin/kb/{slug}/doc/{doc}": ["400 INVALID_SLUG", "404 KB_NOT_FOUND", "404 DOC_NOT_FOUND"],
  "DELETE /admin/kb/{slug}": ["400 INVALID_SLUG", "404 KB_NOT_FOUND"],
  "PUT /admin/global/agents/{name}": ["400 INVALID_AGENT", "400 INVALID_FRONTMATTER", "400 INVALID_NAME"],
  "GET /admin/global/agents/{name}": ["400 INVALID_NAME", "404 NOT_FOUND"],
  "DELETE /admin/global/agents/{name}": ["400 INVALID_NAME", "404 NOT_FOUND"],
  "GET /admin/wren/datasources": ["409 WREN_DISABLED"],
  "GET /admin/wren/datasources/{name}": ["404 NOT_FOUND"],
  "PUT /admin/wren/datasources/{name}": ["400 BAD_REQUEST", "409 WREN_DISABLED", "503 WREN_UNAVAILABLE"],
  "DELETE /admin/wren/datasources/{name}": ["404 NOT_FOUND", "409 WREN_DISABLED"],
  "POST /admin/wren/datasources/{name}/rebuild": ["404 NOT_FOUND", "409 WREN_DISABLED", "503 WREN_UNAVAILABLE"],
  "POST /admin/wren/datasources/{name}/sync": ["404 NOT_FOUND", "409 WREN_DISABLED", "503 WREN_UNAVAILABLE"],
  "POST /admin/wren/sync": ["409 WREN_DISABLED"],
  "POST /admin/wren/datasources/{name}/test": ["400 BAD_REQUEST", "404 NOT_FOUND", "409 WREN_DISABLED"],
  "PUT /api/me/mcp": ["400 INVALID_JSON"],
  "PUT /api/me/mcp/settings": ["400 BAD_REQUEST", "400 INVALID_JSON"],
  "PUT /api/me/skills/{name}": ["400 INVALID_NAME"],
  "PUT /api/me/plugins/{name}": ["400 INVALID_NAME"],
  "PUT /api/me/context-files/{name}": ["400 INVALID_NAME", "400 BAD_REQUEST", "413 PAYLOAD_TOO_LARGE"],
  "PUT /api/me/model-roles": ["400 BAD_REQUEST"],
  "POST /api/sessions/{sid}/share-link": ["404 NOT_FOUND"],
  "DELETE /api/sessions/{sid}/share-link/{shareId}": ["404 NOT_FOUND"],
  "DELETE /api/sessions/{sid}/queue": ["409 QUEUE_CLEAR_FAILED"],
  "POST /api/sessions/{sid}/queue/remove": ["400 BAD_REQUEST"],
  "POST /api/sessions/{sid}/jobs/{jobId}/cancel": ["404 NOT_FOUND"],
  "POST /api/sessions/{sid}/restore-interrupted": ["409 SESSION_STREAMING"],
  "POST /api/sessions/{sid}/fresh": ["409 SESSION_STREAMING", "409 FRESH_REJECTED"],
};

/** 请求体类型（对应 BODY 中的 schema；"text" 表示原文通道）。 */
const BODIES: Record<string, string> = {
  "POST /api/sessions": "createSession",
  "POST /api/sessions/{sid}/prompt": "prompt",
  "POST /api/sessions/{sid}/steer": "prompt",
  "POST /api/sessions/{sid}/inject": "inject",
  "POST /api/sessions/{sid}/business-events": "businessEvent",
  "POST /api/sessions/{sid}/approvals/{approvalId}": "approvalDecision",
  "POST /api/sessions/{sid}/model": "modelRef",
  "POST /api/me/webhooks": "webhookRegister",
  "POST /api/sessions/{sid}/webhooks": "webhookRegister",
  "POST /api/me/hooks": "hookRegister",
  "POST /api/sessions/{sid}/hooks": "hookRegister",
  "PUT /api/me/tools/http/{name}": "httpToolRegister",
  "PUT /api/sessions/{sid}/tools/http/{name}": "httpToolRegister",
  "PUT /api/me/models/config": "modelsConfigJson",
  "PUT /api/me/agents/{name}": "agentDefinition",
  "POST /api/me/agents": "agentDefinition",
  "PUT /admin/global/agents/{name}": "agentDefinition",
  "POST /internal/maintenance/import": "migrationImport",
  "POST /api/sessions/import": "importSession",
  "POST /admin/kb": "kbCreate",
  "PUT /admin/wren/datasources/{name}": "wrenDatasource",
  "POST /admin/wren/datasources/{name}/sync": "wrenSyncRequest",
  "POST /admin/wren/datasources/{name}/test": "wrenTestRequest",
  // multipart：无 JSON schema 先例，operationFor 特判输出 multipart/form-data 最小描述
  "POST /admin/kb/{slug}/upload": "kbUploadZip",
  "POST /admin/kb/{slug}/pdf": "kbUploadPdf",
};

/**
 * 全部操作的操作级摘要（数量随路由面漂移，以运行时 openapi.json 为准）。
 * 规则：一句话说清"做什么 + 关键约束"；不写与代码重复的字段罗列。
 */
const SUMMARIES: Record<string, string> = {
  // ---- 会话生命周期 ----
  "POST /api/sessions": "建会话：1:1 workspace、落 DB 行；幂等键 24h 内重放同响应",
  "GET /api/sessions": "会话列表：分页 + 内联 live 状态/上下文占用/用量/末条消息预览",
  "GET /api/sessions/search": "会话正文搜索：扫该用户 JSONL 命中行并回 snippet",
  "GET /api/sessions/{sid}": "会话详情：元数据 + live 状态 + 用量汇总",
  "PATCH /api/sessions/{sid}": "改标题或归档状态（归档即释放进程态，文件保留）",
  "DELETE /api/sessions/{sid}": "删除会话：先打 pre_delete 快照再进 trash（30 天可找回）",
  // ---- 对话 ----
  "POST /api/sessions/{sid}/prompt": "发起 turn：202 准许即返回，过程与结果经 SSE；wait=true 可同步等终态",
  "POST /api/sessions/{sid}/steer": "向正在流式的会话插话（不打断当前 turn）",
  "POST /api/sessions/{sid}/abort": "中止当前 turn（立即返回 202）",
  "POST /api/sessions/{sid}/inject": "提示词注入：context 不耗模型不触发 turn，user 触发 turn（计配额）",
  "POST /api/sessions/{sid}/business-events": "注入业务事件：登记并广播，turn 内事件带 correlation 关联",
  "POST /api/sessions/{sid}/follow-up": "追加 follow-up：排队到当前 turn 之后，不打断",
  "POST /api/sessions/{sid}/messages/custom": "投递自定义消息：扩展协议通道（customType + content + deliverAs）",
  // ---- 状态与观测 ----
  "GET /api/sessions/{sid}/state": "状态快照一次拿全：模型/思考/队列/工具/上下文占用/消息数",
  "GET /api/sessions/{sid}/bootstrap": "集成端初始化聚合：会话/状态/模式/待审批/命令/事件游标一次取全",
  "GET /api/sessions/{sid}/status": "轻量轮询：状态/模型/待审批数/队列数/事件游标",
  "GET /api/sessions/{sid}/events": "SSE 事件流：先订阅后 prompt；Last-Event-ID 重连，types 可过滤",
  "GET /api/sessions/{sid}/events/replay": "事件 JSON 回放：按游标补齐（环形缓冲最近 500 条）",
  "GET /api/sessions/{sid}/usage": "会话用量：汇总 + 最近 50 个 turn 明细",
  "GET /api/sessions/{sid}/stats": "SDK 会话统计直出（工具调用数/耗时/缓存等）",
  "GET /api/sessions/{sid}/messages": "会话消息历史（SDK messages 直读，since 可增量）",
  "GET /api/sessions/{sid}/dump": "会话全文转写（纯文本）",
  "GET /api/sessions/{sid}/integration": "本会话集成端点清单与契约文档位置（自描述）",
  // ---- 能力面板 ----
  "GET /api/sessions/{sid}/commands": "命令面板：斜杠命令 + 自定义命令 + MCP prompts + 模板",
  "GET /api/sessions/{sid}/models": "模型选择器：可用模型目录 + 当前模型 + 思考档位",
  "GET /api/sessions/{sid}/thinking": "思考档位：当前值 + 可选档位与 effort 选择器",
  "PUT /api/sessions/{sid}/thinking": "设置思考档位（如 low/high；越界按模型上限收敛）",
  "GET /api/sessions/{sid}/todos": "todo 面板：阶段列表",
  "PUT /api/sessions/{sid}/todos": "手工编辑 todo 阶段（落 user_todo_edit 条目）",
  "GET /api/sessions/{sid}/context": "上下文占用：窗口使用量与分桶明细",
  "GET /api/sessions/{sid}/modes": "模式面板：plan/goal/压缩/重试/回退等运行态开关",
  "GET /api/sessions/{sid}/plan": "计划模式：状态与引用的参考文件路径",
  "GET /api/sessions/{sid}/maintenance": "维护状态：自动压缩/自动重试/缓存预热/提示缓存",
  "GET /api/sessions/{sid}/session-tree": "分叉历史树：条目树 + 当前叶节点（网页可视化）",
  "GET /api/sessions/{sid}/context-files": "上下文文件发现：用户级与项目级文件 + 是否已进入系统提示词",
  "GET /api/sessions/{sid}/skills": "会话已加载的技能：全部 + 进入系统提示词的那些 + 加载告警",
  // ---- 控制与生命周期 ----
  "POST /api/sessions/{sid}/compact": "手动压缩上下文（需 idle）",
  "POST /api/sessions/{sid}/reset": "重置会话上下文（清空对话，文件保留；需 idle）",
  "POST /api/sessions/{sid}/handoff": "handoff：总结当前会话并移交到新上下文（需 idle）",
  "POST /api/sessions/{sid}/restore-interrupted": "恢复被中断的 turn（进程崩溃后 JSONL 未闭合条目）",
  "POST /api/sessions/{sid}/cycle-model": "轮换模型角色（Ctrl+P 语义；需 idle）",
  "POST /api/sessions/{sid}/cycle-thinking": "轮换思考档位并返回新值",
  "POST /api/sessions/{sid}/queue/remove": "移除队列中的单条消息（按文本 + 队列名）",
  "DELETE /api/sessions/{sid}/queue": "清空消息队列（steering 与 follow-up）",
  "POST /api/sessions/{sid}/name": "给会话命名（SDK 层名称，与网关 title 相互独立）",
  "POST /api/sessions/{sid}/interrupt": "细粒度中断：按通道中止重试/压缩/handoff/分支摘要/bash/eval",
  "POST /api/sessions/{sid}/title/generate": "按首条用户消息生成标题并回写会话 title",
  "POST /api/sessions/{sid}/fresh": "开新会话（保留文件与工作区，丢弃上下文；需 idle）",
  "POST /api/sessions/{sid}/export": "导出当前会话为 HTML（落在 workspace/exports/）",
  "POST /api/sessions/{sid}/fork": "分叉：无 entryId 走血缘分叉（源不动），有 entryId 走 SDK 原地分支后换绑",
  "POST /api/sessions/{sid}/branch": "从某条目分支（编辑点语义）：返回编辑器草稿并换绑到新会话",
  "POST /api/sessions/{sid}/model": "会话内切模型（需 idle；切前自动快照，受 provider 白名单约束）",
  // ---- 条目与快照 ----
  "GET /api/sessions/{sid}/entries": "会话条目列表（fork/branch 的寻址键；可按类型过滤）",
  "PUT /api/sessions/{sid}/entries/{entryId}/label": "给条目打标签（网页书签/标重点）",
  "DELETE /api/sessions/{sid}/entries/{entryId}/label": "移除条目标签",
  "GET /api/sessions/{sid}/snapshots": "快照列表（自动与手动，按时间倒序）",
  "POST /api/sessions/{sid}/snapshots": "手动快照（幂等；零 turn 会话返回 SNAPSHOT_EMPTY）",
  "GET /api/sessions/{sid}/snapshots/{snapId}": "单个快照元数据",
  "DELETE /api/sessions/{sid}/snapshots/{snapId}": "删除快照（文件与记录一起清）",
  "POST /api/sessions/{sid}/snapshots/{snapId}/restore":
    "快照恢复：fork（默认，安全）或 rollback（同会话换文件，先打 pre_restore 快照）",
  // ---- 审批 ----
  "GET /api/sessions/{sid}/approvals": "待审批工具调用清单（含当前审批策略；超时后端自动拒绝）",
  "POST /api/sessions/{sid}/approvals/{approvalId}": "审批决定：放行或拒绝（404 表示已决或已超时）",
  // ---- Agent Hub ----
  "GET /api/sessions/{sid}/agents": "子代理名册（含 live 状态）",
  "GET /api/sessions/{sid}/agents/definitions": "本会话可见的 agent 定义 + 是否出现在系统提示词",
  "GET /api/sessions/{sid}/agents/{aid}": "子代理详情（任务描述、状态、工具等）",
  "GET /api/sessions/{sid}/agents/{aid}/transcript": "子代理 transcript 原文（限用户根内，≤4MB）",
  "POST /api/sessions/{sid}/agents/{aid}/chat": "给子代理发消息（已停止的先自动复活）",
  "POST /api/sessions/{sid}/agents/{aid}/kill": "中止子代理（留 tombstone；transcript 留盘可复活）",
  "POST /api/sessions/{sid}/agents/{aid}/revive": "从持久化 transcript 忠实重建子代理",
  // ---- 异步任务 ----
  "GET /api/sessions/{sid}/jobs": "异步任务树与快照（bash 后台 / task 子代理）",
  "GET /api/sessions/{sid}/jobs/{jobId}": "单个异步任务详情",
  "POST /api/sessions/{sid}/jobs/{jobId}/cancel": "取消异步任务",
  // ---- 运行时工具与 MCP ----
  "GET /api/sessions/{sid}/tools": "运行时生效的工具名（active / all）",
  "PUT /api/sessions/{sid}/tools": "调整运行时生效工具集",
  "GET /api/sessions/{sid}/tools/info": "工具能力发现：描述、参数名、来源（内置/MCP/自定义）",
  "GET /api/sessions/{sid}/tools/http": "本会话可见的业务 HTTP 工具（会话级 + 用户级）",
  "PUT /api/sessions/{sid}/tools/http/{name}": "注册会话级业务 HTTP 工具（同名覆盖用户级；注册后热生效）",
  "DELETE /api/sessions/{sid}/tools/http/{name}": "注销会话级业务 HTTP 工具",
  "GET /api/sessions/{sid}/mcp": "MCP 汇总：已连接服务器与工具名",
  "GET /api/sessions/{sid}/mcp/servers": "MCP 服务器明细：状态/传输/工具数/来源",
  "POST /api/sessions/{sid}/mcp/servers/{name}/reconnect": "重连单个 MCP 服务器（不重新发现）",
  "GET /api/sessions/{sid}/mcp/servers/{name}/resources": "MCP 服务器资源列表",
  "POST /api/sessions/{sid}/mcp/reload": "重新对账项目级 MCP 配置并刷新全部工具（重放业务工具）",
  "GET /api/sessions/{sid}/lsp": "LSP 服务器清单",
  // ---- 文件与 git ----
  "GET /api/sessions/{sid}/tree": "workspace 文件树（限深限条数）",
  "GET /api/sessions/{sid}/files/index": "workspace 文件索引与按名搜索",
  "GET /api/sessions/{sid}/file": "读文件（JSON 信封：path/encoding/content/size）",
  "GET /api/sessions/{sid}/file/raw": "原始字节流（支持 Range，图像/PDF 直接预览）",
  "PUT /api/sessions/{sid}/file": "写文件（utf8 或 base64，≤5MB）",
  "DELETE /api/sessions/{sid}/file": "删除文件或目录",
  "POST /api/sessions/{sid}/file/mkdir": "创建目录（workspace 内相对路径）",
  "POST /api/sessions/{sid}/file/rename": "重命名或移动",
  "POST /api/sessions/{sid}/files/upload": "上传文件（multipart，字段名 files；只取 basename 防穿越）",
  "GET /api/sessions/{sid}/git/status": "git 状态：分支/上游/领先落后/逐文件变更",
  "GET /api/sessions/{sid}/git/log": "git 提交历史",
  "GET /api/sessions/{sid}/git/diff": "git 差异（可限定路径/暂存区/基线 ref/仅统计）",
  "GET /api/sessions/{sid}/git/branches": "git 分支列表（本地 + 远程，标记当前分支）",
  "POST /api/sessions/{sid}/git/commit": "暂存并提交（add 可为 all 或路径白名单）",
  "GET /api/sessions/{sid}/git/worktrees": "git worktree 列表",
  "POST /api/sessions/{sid}/git/worktrees": "新建 git worktree（路径必须落在用户数据根内）",
  "DELETE /api/sessions/{sid}/git/worktrees": "移除 git worktree",
  // ---- 会话级订阅 ----
  "GET /api/sessions/{sid}/webhooks": "本会话的回调订阅（secret 不外泄）",
  "POST /api/sessions/{sid}/webhooks": "注册会话级回调（只收该会话事件；HMAC 签名推送）",
  "DELETE /api/sessions/{sid}/webhooks/{id}": "注销会话级回调",
  "GET /api/sessions/{sid}/hooks": "本会话的生命周期钩子 + 事件契约",
  "POST /api/sessions/{sid}/hooks": "注册会话级生命周期钩子（notify 通知 / decide 同步决策）",
  "DELETE /api/sessions/{sid}/hooks/{id}": "注销会话级钩子",
  // ---- 分享 ----
  "POST /api/sessions/{sid}/share-link": "签发分享链接（view 只读 / control 可对话；token 仅返回一次）",
  "GET /api/sessions/{sid}/share-links": "本会话的分享链接列表",
  "DELETE /api/sessions/{sid}/share-link/{shareId}": "吊销分享链接",
  // ---- 会话文件导入导出 ----
  "POST /api/sessions/validate": "会话 JSONL 干跑校验（不落库）",
  "POST /api/sessions/import": "导入会话 JSONL：校验 → 补 model_change → 写文件与 DB 行",
  "GET /api/sessions/{sid}/session-file": "下载会话原始 JSONL（NDJSON 附件）",
  // ---- 用户级：模型与 Provider ----
  "GET /api/me/models": "模型目录（带成本与上下文窗口；find/provider/refresh 可用）",
  "GET /api/me/models/config": "models.yml 原文（text/yaml）；format=json 返回结构化视图",
  "PUT /api/me/models/config": "写 models.yml：application/json 为结构化（校验并格式化），其余按原文写入",
  "GET /api/me/models/providers/{provider}": "单个 provider 配置",
  "PUT /api/me/models/providers/{provider}": "整体替换单个 provider（省略字段即删除；其他 provider 不受影响）",
  "DELETE /api/me/models/providers/{provider}": "删除单个 provider",
  "POST /api/me/models/credentials": "注入凭据：把 API key 合并进 models.yml 对应 provider",
  "POST /api/me/models/test": "模型探针：独立内存会话发一条探针，测首字延迟与总耗时",
  "GET /api/me/providers": "Provider 结构化视图（configured/available/disabled；不返回 apiKey 明文）",
  "GET /api/me/providers/settings": "provider 开关设置（disabledProviders）",
  "PUT /api/me/providers/settings": "设置 provider 开关（对新会话生效；live 会话保留原 registry）",
  "GET /api/me/model-roles": "模型角色配置（@role 别名与轮转顺序）",
  "PUT /api/me/model-roles": "设置模型角色与轮转顺序（写用户级 config.yml）",
  // ---- 用户级：审批 ----
  "GET /api/me/approval": "审批策略：模式 + 按工具的策略表",
  "PUT /api/me/approval": "设置审批策略（模式四选一 + 工具策略整体替换）",
  "GET /api/me/approval/grants": "持久授权清单（always-ask-cached 已记住的批准）",
  "DELETE /api/me/approval/grants": "清空持久授权清单",
  // ---- 用户级：Agent 与上下文 ----
  "GET /api/me/agents": "用户级 agent 定义列表（含 frontmatter 解析结果）",
  "GET /api/me/agents/{name}": "agent 定义原文；format=json 返回规范字段 + frontmatter",
  "PUT /api/me/agents/{name}": "写 agent 定义：application/json 结构化（字段白名单）或 text/markdown 原文",
  "POST /api/me/agents": "创建 agent 定义（name 取自 body；同名 409）",
  "DELETE /api/me/agents/{name}": "删除 agent 定义",
  "GET /api/me/context-files": "用户级上下文文件清单（AGENTS/RULES/APPEND_SYSTEM/SYSTEM）",
  "GET /api/me/context-files/{name}": "读取单个上下文文件",
  "PUT /api/me/context-files/{name}": "写用户级上下文文件（新会话创建时进入系统提示词）",
  "DELETE /api/me/context-files/{name}": "删除用户级上下文文件",
  // ---- 用户级：订阅与工具 ----
  "GET /api/me/webhooks": "用户级回调订阅列表（跨全部会话）",
  "POST /api/me/webhooks": "注册用户级回调（HMAC 签名推送；secret 仅创建响应返回一次）",
  "DELETE /api/me/webhooks/{id}": "注销用户级回调",
  "GET /api/me/hooks": "用户级钩子列表 + 21 事件契约（区分决策型与通知型）",
  "POST /api/me/hooks": "注册用户级生命周期钩子（对该用户全部会话生效）",
  "DELETE /api/me/hooks/{id}": "注销用户级钩子",
  "GET /api/me/tools/http": "用户级业务 HTTP 工具列表",
  "PUT /api/me/tools/http/{name}": "注册用户级业务 HTTP 工具（注册后热应用到该用户全部 live 会话）",
  "DELETE /api/me/tools/http/{name}": "注销用户级业务 HTTP 工具",
  // ---- 用户级：MCP / 发现项 / 用量 ----
  "GET /api/me/mcp": "MCP 原始配置（agent/mcp.json 原文）",
  "PUT /api/me/mcp": "写 MCP 原始配置（仅挡语法错误，结构由 omp 发现期校验）",
  "GET /api/me/mcp/settings": "MCP 用户级开关（disabledServers 优先级最高）",
  "PUT /api/me/mcp/settings": "设置 MCP 用户级开关（写 agent/mcp.json）",
  "GET /api/me/skills": "用户可见技能清单（私有 + 全局，带 scope 标签）",
  "GET /api/me/skills/{name}": "读取技能原文（SKILL.md）",
  "PUT /api/me/skills/{name}": "写用户级技能（name + description + 正文）",
  "DELETE /api/me/skills/{name}": "删除用户级技能",
  "GET /api/me/plugins": "用户可见插件清单（私有 + 全局，带 scope 标签）",
  "GET /api/me/plugins/{name}": "读取插件源码",
  "PUT /api/me/plugins/{name}": "写用户级插件（≤2MB）",
  "DELETE /api/me/plugins/{name}": "删除用户级插件",
  "GET /api/me/limits": "配额视图：限额 / 本月用量 / 预算余额 / RPM 窗口",
  "GET /api/me/usage": "用户用量聚合（按天/模型/会话分桶）",
  "GET /api/me/projects": "按仓库聚合会话（origin url 维度）",
  "GET /api/me/config/schema": "配置自描述：provider/model/agent 字段清单与示例（供前端生成表单）",
  // ---- 内部契约 ----
  "POST /internal/users/{uid}/provision": "懒 provision：建用户目录骨架与租户行（幂等）",
  "GET /internal/users/{uid}/summary": "用户状态：租户信息、限额、活跃/live/streaming 会话数",
  "GET /internal/users/{uid}/usage": "用户用量聚合（上游计费或展示用）",
  "PATCH /internal/users/{uid}/limits": "调整用户限额（合并语义：maxSessions/maxConcurrent/allowedProviders）",
  "DELETE /internal/users/{uid}": "级联删除用户：释放全部 live 会话并标记 deleted（30 天后物理清除）",
  "GET /internal/users/{uid}/webhooks": "用户的回调订阅（内部视角）",
  "POST /internal/users/{uid}/webhooks": "为用户注册回调（内部视角）",
  "DELETE /internal/webhooks/{id}": "注销用户回调（内部视角）",
  "GET /internal/trash": "回收站列表：已删会话与租户（30 天窗口）",
  "POST /internal/trash/sessions/{sid}/restore": "找回已删会话（清 deleted_at，状态回 active）",
  "POST /internal/trash/users/{uid}/restore": "找回已删租户",
  "GET /internal/audit": "审计查询：按用户与动作过滤，分页返回",
  "POST /internal/drain": "排空开关：开启后拒新会话且健康检查失败（滚动发布摘流量）",
  "POST /internal/maintenance/export": "环境导出：静默实例 → 一致 DB 快照 + 文件树 + manifest（校验和/计数/文件清单）",
  "POST /internal/maintenance/import": "环境导入：校验 manifest → 复制覆盖 → 按文件清单清冗余 → 换库重开 → 计数对账",
  // ---- 全局管理 ----
  "GET /admin/global/skills": "全局技能清单（所有用户可见，用户同名覆盖）",
  "GET /admin/global/skills/{name}": "读取全局技能原文",
  "PUT /admin/global/skills/{name}": "写全局技能（所有用户可见）",
  "DELETE /admin/global/skills/{name}": "删除全局技能",
  "GET /admin/global/plugins": "全局插件清单",
  "GET /admin/global/plugins/{name}": "读取全局插件源码",
  "PUT /admin/global/plugins/{name}": "写全局插件（所有用户可见）",
  "DELETE /admin/global/plugins/{name}": "删除全局插件",
  "GET /admin/global/mcp": "全局 MCP 配置",
  "PUT /admin/global/mcp": "写全局 MCP 配置（合成进各用户 workspace）",
  "GET /admin/global/agents": "全局 agent 定义清单（所有用户可见，用户同名覆盖）",
  "GET /admin/global/agents/{name}": "全局 agent 定义原文；format=json 返回规范字段 + frontmatter",
  "PUT /admin/global/agents/{name}": "写全局 agent 定义（合成进各用户新会话 workspace 的 .omp/agents）",
  "DELETE /admin/global/agents/{name}": "删除全局 agent 定义（新会话不再合成）",
  // ---- 知识库（DESIGN §38）----
  "POST /admin/kb": "建知识库：skill 目录骨架（SKILL.md/kb.json/docs/scripts/assets）+ kb.db",
  "GET /admin/kb": "知识库列表：扫 global/skills/kb-*（kb.json 标记），含 docs 计数",
  "POST /admin/kb/{slug}/upload":
    "上传 MinerU ParseOutcome zip（一包一文档）：透传落 docs/<doc>/，markdown.md 改名 <doc>.md，同名重传覆盖",
  "POST /admin/kb/{slug}/pdf": "补传原始 PDF：写 docs/<doc>/source.pdf 并置 has_pdf=1（截图脚本依赖）",
  "GET /admin/kb/{slug}/pdf/{doc}": "取文档原始 PDF（application/pdf）",
  "GET /admin/kb/{slug}/tree": "分组树 + 文档卡片（pages/images/has_pdf/md_sha256；未分组文档挂根部）",
  "GET /admin/kb/{slug}/index-status":
    "语义索引状态：update（BM25）在上传响应内已同步完成，embed（向量）后台单飞异步；?probe=1 额外读 qmd status 的待嵌入数",
  "DELETE /admin/kb/{slug}/doc/{doc}": "删文档：目录 + kb.db 行联动",
  "DELETE /admin/kb/{slug}":
    "删知识库：整个 skill 目录 + kb.db（含 -wal/-shm）；workspace 残留 junction 由下次合成清理",
  // ---- WrenAI 数据源管理（DESIGN §39.2.1）----
  "GET /admin/wren/datasources": "Wren 数据源列表：state/daemon 端口与存活/models 数/updatedAt（connection 已脱敏）",
  "GET /admin/wren/datasources/{name}": "单个 Wren 数据源详情（connection 脱敏，password 恒为 ******）",
  "PUT /admin/wren/datasources/{name}":
    "创建/更新 Wren 数据源（合并 connection/tables）→ 全量 re-provision（内省生成 MDL + context build + daemon 重启）；201 创建 / 200 更新",
  "DELETE /admin/wren/datasources/{name}":
    "删除 Wren 数据源：杀 daemon → mcp.json 移除 → 项目目录删除 → 注册表移除（profiles.yml 残留无害）",
  "POST /admin/wren/datasources/{name}/rebuild":
    "重内省 + 重生成 models + context build + daemon 重启（enrich 后同步语义层）",
  "POST /admin/wren/datasources/{name}/sync":
    '按 drift 增量同步单数据源：catalogHash 有变化才增量重生成（保留 agent enrich）→ build → 重启 daemon；{"force":true} 跳过短路',
  "POST /admin/wren/sync":
    "全量 drift 同步：遍历注册表逐个按 catalogHash 增量同步（单个失败不中断），返回每源 {changed,reason,models}",
  "POST /admin/wren/datasources/{name}/test":
    "连接测试（PG SELECT 1 / CH 内省 LIMIT 1；body 可给未落库载荷），不落注册表",
  // ---- 运维 ----
  "GET /terminal": "TUI 测试页（浏览器 xterm 前端；sid 经 query 传入）",
  "GET /terminal/assets/{file}": "TUI 测试页静态资产（xterm.js/css/fit，白名单直读）",
  "GET /terminal/ws/{sid}": "TUI 终端桥 WebSocket 升级（token 可经 query；握手即交接会话写权）",
  "GET /healthz": "存活探针（排空期间返回 503 以摘流量）",
  "GET /readyz": "就绪探针（数据根可写）",
  "GET /metrics": "Prometheus 指标：会话数、流式槽位、用量与成本、限流与预算拒绝",
  "GET /openapi.json": "本契约文档（OpenAPI 3.1）",
};

/** 响应模型（指向 components.schemas）。 */
const RESPONSES: Record<string, string> = {
  "POST /api/sessions": "SessionCreated",
  "GET /api/sessions": "SessionList",
  "GET /api/sessions/search": "SessionSearch",
  "GET /api/sessions/{sid}": "Session",
  "PATCH /api/sessions/{sid}": "SessionPatchResult",
  "DELETE /api/sessions/{sid}": "SessionDeleteResult",
  "GET /api/sessions/{sid}/state": "SessionState",
  "GET /api/sessions/{sid}/bootstrap": "Bootstrap",
  "GET /api/sessions/{sid}/status": "SessionStatus",
  "GET /api/sessions/{sid}/events": "EventStream",
  "GET /api/sessions/{sid}/events/replay": "EventReplay",
  "GET /api/sessions/{sid}/usage": "SessionUsage",
  "GET /api/sessions/{sid}/agents": "AgentRoster",
  "GET /api/sessions/{sid}/agents/definitions": "AgentDefinitions",
  "GET /api/sessions/{sid}/approvals": "ApprovalList",
  "GET /api/sessions/{sid}/snapshots": "SnapshotList",
  "GET /api/sessions/{sid}/snapshots/{snapId}": "Snapshot",
  "GET /api/sessions/{sid}/models": "ModelPicker",
  "GET /api/me/models": "ModelCatalog",
  "GET /api/me/providers": "ProviderList",
  "GET /api/me/models/config": "ModelsConfig",
  "GET /api/me/webhooks": "WebhookList",
  "GET /api/sessions/{sid}/webhooks": "WebhookList",
  "GET /api/me/hooks": "HookList",
  "GET /api/sessions/{sid}/hooks": "HookList",
  "GET /api/me/tools/http": "HttpToolList",
  "GET /api/sessions/{sid}/tools/http": "HttpToolList",
  "GET /api/me/agents": "AgentDefinitionList",
  "GET /api/me/agents/{name}": "AgentDefinition",
  "GET /api/me/limits": "Limits",
  "GET /api/me/usage": "UsageBuckets",
  "GET /api/me/skills": "SkillList",
  "GET /api/me/plugins": "PluginList",
  "GET /api/me/context-files": "ContextFileList",
  "GET /api/me/config/schema": "ConfigSchema",
  "GET /api/sessions/{sid}/file": "FileContent",
  "GET /api/sessions/{sid}/tree": "FileTree",
  "GET /api/sessions/{sid}/git/status": "GitStatus",
  "GET /api/sessions/{sid}/git/log": "GitLog",
  "GET /api/sessions/{sid}/git/diff": "GitDiff",
  "GET /api/sessions/{sid}/jobs": "JobTree",
  "GET /internal/audit": "AuditPage",
  "GET /internal/users/{uid}/summary": "UserSummary",
  "GET /internal/trash": "TrashList",
  "POST /internal/maintenance/export": "BundleManifest",
  "POST /internal/maintenance/import": "ImportResult",
  "GET /admin/kb/{slug}/tree": "KbTree",
};

/** 响应模型定义（components.schemas）。 */
const RESPONSE_SCHEMAS: Record<string, Record<string, unknown>> = {
  SessionCreated: {
    type: "object",
    properties: {
      id: { type: "string" },
      workspaceId: { type: "string", description: "恒等于会话 id（1:1）" },
      status: { type: "string" },
      model: {
        type: "object",
        nullable: true,
        properties: { provider: { type: "string" }, modelId: { type: "string" } },
      },
      warnings: { type: "array", items: { type: "string" }, description: "如显式模型不可用已回落" },
    },
  },
  SessionList: {
    type: "object",
    properties: {
      sessions: { type: "array", items: { $ref: "#/components/schemas/Session" } },
      total: { type: "integer" },
      page: { type: "integer" },
      perPage: { type: "integer" },
    },
  },
  Session: {
    type: "object",
    properties: {
      id: { type: "string" },
      user_id: { type: "string" },
      workspace_id: { type: "string" },
      parent_id: { type: "string", nullable: true, description: "分叉血缘" },
      title: { type: "string" },
      status: { type: "string", enum: ["active", "archived", "deleted"] },
      session_file: { type: "string", nullable: true },
      model_provider: { type: "string", nullable: true },
      model_id: { type: "string", nullable: true },
      live: {
        type: "object",
        properties: { present: { type: "boolean" }, status: { type: "string", nullable: true } },
      },
      usage: { type: "object", additionalProperties: true },
    },
  },
  SessionSearch: {
    type: "object",
    properties: {
      q: { type: "string" },
      total: { type: "integer" },
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            title: { type: "string", nullable: true },
            status: { type: "string" },
            matches: { type: "integer" },
            snippet: { type: "string", nullable: true },
          },
        },
      },
    },
  },
  SessionPatchResult: { type: "object", properties: { id: { type: "string" }, status: { type: "string" } } },
  SessionDeleteResult: { type: "object", properties: { id: { type: "string" }, status: { type: "string" } } },
  SessionState: {
    type: "object",
    properties: {
      sessionId: { type: "string" },
      status: { type: "string", enum: ["idle", "streaming"] },
      model: {
        type: "object",
        nullable: true,
        properties: { provider: { type: "string" }, modelId: { type: "string" } },
      },
      thinkingLevel: { type: "string", nullable: true },
      availableThinkingLevels: { type: "array", items: { type: "string" } },
      queue: { type: "object", additionalProperties: true },
      tools: {
        type: "object",
        properties: {
          active: { type: "array", items: { type: "string" } },
          all: { type: "array", items: { type: "string" } },
        },
      },
      contextUsage: { type: "object", nullable: true },
      messageCount: { type: "integer" },
    },
  },
  Bootstrap: {
    type: "object",
    properties: {
      session: { type: "object", additionalProperties: true },
      state: { type: "object", additionalProperties: true },
      modes: { type: "object", additionalProperties: true },
      approvals: { type: "array", items: { type: "object", additionalProperties: true } },
      commands: { type: "object", additionalProperties: true },
      events: {
        type: "object",
        properties: { latestSeq: { type: "integer" }, sse: { type: "string" }, replay: { type: "string" } },
      },
    },
  },
  SessionStatus: {
    type: "object",
    properties: {
      sessionId: { type: "string" },
      status: { type: "string", enum: ["idle", "streaming"] },
      model: { type: "object", nullable: true },
      thinkingLevel: { type: "string", nullable: true },
      pendingApprovals: { type: "integer" },
      queueCount: { type: "integer" },
      latestSeq: { type: "integer" },
    },
  },
  EventStream: {
    description: "text/event-stream；每帧 id=会话内序号 event=类型 data=单行 JSON",
    type: "string",
  },
  EventReplay: {
    type: "object",
    properties: {
      events: { type: "array", items: { $ref: "#/components/schemas/GatewayEventEnvelope" } },
      count: { type: "integer" },
      nextSince: { type: "integer" },
      latestSeq: { type: "integer" },
      truncated: { type: "boolean" },
      bufferLimit: { type: "integer" },
    },
  },
  SessionUsage: {
    type: "object",
    properties: {
      summary: { type: "object", additionalProperties: true },
      turns: { type: "array", items: { type: "object", additionalProperties: true } },
    },
  },
  AgentRoster: {
    type: "object",
    properties: {
      agents: { type: "array", items: { type: "object", additionalProperties: true } },
      live: { type: "boolean" },
    },
  },
  AgentDefinitions: {
    type: "object",
    properties: {
      total: { type: "integer" },
      definitions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            advertised: { type: "boolean", description: "是否出现在系统提示词/工具描述里" },
            tools: { type: "array", items: { type: "string" }, nullable: true },
            model: { type: "string", nullable: true },
            thinkingLevel: { type: "string", nullable: true },
            spawns: { type: "array", items: { type: "string" }, nullable: true },
            prewalk: { type: "string", nullable: true },
            advisor: { type: "string", nullable: true },
          },
        },
      },
    },
  },
  ApprovalList: {
    type: "object",
    properties: {
      approvals: {
        type: "array",
        items: {
          type: "object",
          properties: { approvalId: { type: "string" }, tool: { type: "string" }, args: { type: "object" } },
        },
      },
      policy: { type: "object", nullable: true },
      live: { type: "boolean" },
    },
  },
  Snapshot: {
    type: "object",
    properties: {
      id: { type: "string" },
      session_id: { type: "string" },
      kind: { type: "string", enum: ["auto", "manual"] },
      trigger: { type: "string" },
      entry_count: { type: "integer" },
      turn: { type: "integer", nullable: true },
      created_at: { type: "string" },
      expires_at: { type: "string", nullable: true },
    },
  },
  SnapshotList: {
    type: "object",
    properties: { snapshots: { type: "array", items: { $ref: "#/components/schemas/Snapshot" } } },
  },
  ModelCatalog: {
    type: "object",
    properties: {
      total: { type: "integer" },
      providers: { type: "array", items: { type: "string" } },
      models: {
        type: "array",
        items: {
          type: "object",
          properties: {
            provider: { type: "string" },
            modelId: { type: "string" },
            name: { type: "string", nullable: true },
            contextWindow: { type: "integer", nullable: true },
            maxTokens: { type: "integer", nullable: true },
            cost: { type: "object", nullable: true },
          },
        },
      },
    },
  },
  ModelPicker: {
    type: "object",
    properties: {
      models: { type: "array", items: { type: "object", additionalProperties: true } },
      current: { type: "object", nullable: true },
      thinkingLevels: { type: "array", items: { type: "string" } },
      live: { type: "boolean" },
    },
  },
  ProviderList: {
    type: "object",
    properties: {
      providers: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            configured: { type: "boolean" },
            available: { type: "boolean", description: "未禁用且有可解析凭据" },
            disabled: { type: "boolean" },
            baseUrl: { type: "string", nullable: true },
            api: { type: "string", nullable: true },
            hasApiKey: { type: "boolean", description: "只给是否存在，不给明文" },
            availableModels: { type: "integer" },
          },
        },
      },
      disabledProviders: { type: "array", items: { type: "string" } },
      counts: { type: "object", additionalProperties: { type: "integer" } },
    },
  },
  ModelsConfig: {
    type: "object",
    properties: { format: { type: "string" }, config: { type: "object", additionalProperties: true } },
  },
  WebhookList: {
    type: "object",
    properties: {
      webhooks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            url: { type: "string" },
            events: { type: "array", items: { type: "string" } },
            sessionId: { type: "string", nullable: true },
            createdAt: { type: "string" },
          },
        },
      },
    },
  },
  HookList: {
    type: "object",
    properties: {
      hooks: { type: "array", items: { type: "object", additionalProperties: true } },
      events: { type: "array", items: { type: "string" }, description: "21 个可桥接事件" },
      decideEvents: { type: "array", items: { type: "string" }, description: "其中支持同步决策的子集" },
    },
  },
  HttpToolList: {
    type: "object",
    properties: {
      tools: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            label: { type: "string" },
            description: { type: "string" },
            parameters: { type: "object", description: "JSON Schema" },
            url: { type: "string" },
            timeoutMs: { type: "integer" },
            sessionId: { type: "string", nullable: true },
          },
        },
      },
      userLevel: { type: "array", items: { type: "object", additionalProperties: true } },
    },
  },
  AgentDefinitionList: {
    type: "object",
    properties: {
      agents: { type: "array", items: { type: "object", additionalProperties: true } },
      dir: { type: "string" },
      precedence: { type: "string" },
    },
  },
  AgentDefinition: {
    type: "object",
    properties: {
      name: { type: "string" },
      description: { type: "string", nullable: true },
      tools: { type: "array", items: { type: "string" }, nullable: true },
      model: { type: "array", items: { type: "string" }, nullable: true },
      thinkingLevel: { type: "string", nullable: true },
      spawns: { type: "string", nullable: true },
      autoloadSkills: { type: "array", items: { type: "string" }, nullable: true },
      prewalk: { type: "string", nullable: true },
      advisor: { type: "string", nullable: true },
      instructions: { type: "string" },
      frontmatter: { type: "object", additionalProperties: true },
    },
  },
  Limits: {
    type: "object",
    properties: {
      limits: { type: "object", additionalProperties: true },
      usage: { type: "object", additionalProperties: true },
      rpmWindow: { type: "object", additionalProperties: true },
    },
  },
  UsageBuckets: {
    type: "object",
    properties: {
      buckets: {
        type: "array",
        items: {
          type: "object",
          properties: {
            key: { type: "string" },
            turns: { type: "integer" },
            inputTokens: { type: "integer" },
            outputTokens: { type: "integer" },
            totalTokens: { type: "integer" },
            costUsd: { type: "number" },
          },
        },
      },
    },
  },
  SkillList: {
    type: "object",
    properties: {
      skills: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            description: { type: "string", nullable: true },
            scope: { type: "string" },
          },
        },
      },
    },
  },
  PluginList: {
    type: "object",
    properties: {
      plugins: {
        type: "array",
        items: {
          type: "object",
          properties: { name: { type: "string" }, scope: { type: "string" }, bytes: { type: "integer" } },
        },
      },
    },
  },
  ContextFileList: {
    type: "object",
    properties: {
      files: {
        type: "array",
        items: { type: "object", properties: { name: { type: "string" }, bytes: { type: "integer" } } },
      },
      supported: { type: "array", items: { type: "string" } },
    },
  },
  ConfigSchema: {
    type: "object",
    properties: { version: { type: "integer" }, models: { type: "object" }, agents: { type: "object" } },
  },
  FileContent: {
    type: "object",
    properties: {
      path: { type: "string" },
      encoding: { type: "string" },
      content: { type: "string" },
      size: { type: "integer" },
    },
  },
  FileTree: {
    type: "object",
    properties: {
      tree: { type: "array", items: { type: "object", additionalProperties: true } },
      truncated: { type: "boolean" },
    },
  },
  GitStatus: {
    type: "object",
    properties: {
      branch: { type: "string", nullable: true },
      upstream: { type: "string", nullable: true },
      ahead: { type: "integer" },
      behind: { type: "integer" },
      entries: { type: "array", items: { type: "object", additionalProperties: true } },
    },
  },
  GitLog: {
    type: "object",
    properties: {
      commits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            hash: { type: "string" },
            author: { type: "string" },
            date: { type: "string" },
            subject: { type: "string" },
          },
        },
      },
    },
  },
  GitDiff: { type: "object", properties: { diff: { type: "string" }, truncated: { type: "boolean" } } },
  JobTree: {
    type: "object",
    properties: {
      tree: { type: "object", nullable: true },
      snapshot: { type: "object", nullable: true },
      live: { type: "boolean" },
    },
  },
  AuditPage: {
    type: "object",
    properties: {
      page: { type: "integer" },
      perPage: { type: "integer" },
      total: { type: "integer" },
      entries: { type: "array", items: { type: "object", additionalProperties: true } },
    },
  },
  UserSummary: {
    type: "object",
    properties: {
      user_id: { type: "string" },
      status: { type: "string" },
      limits: { type: "object", additionalProperties: true },
      active_sessions: { type: "integer" },
      live_sessions: { type: "integer" },
      streaming_sessions: { type: "integer" },
    },
  },
  TrashList: {
    type: "object",
    properties: {
      sessions: { type: "array", items: { type: "object", additionalProperties: true } },
      tenants: { type: "array", items: { type: "object", additionalProperties: true } },
    },
  },
  BundleManifest: {
    type: "object",
    properties: {
      bundlePath: { type: "string" },
      manifest: {
        type: "object",
        properties: {
          formatVersion: { type: "integer" },
          dbSchemaVersion: { type: "integer" },
          exportedAt: { type: "string" },
          counts: { type: "object", additionalProperties: { type: "integer" } },
          files: { type: "array", items: { type: "string" } },
          sha256: { type: "string" },
        },
      },
    },
  },
  ImportResult: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      counts: { type: "object", additionalProperties: { type: "integer" } },
      restoredFrom: { type: "string" },
      backupDir: { type: "string" },
      removedFiles: { type: "integer" },
    },
  },
  KbTree: {
    type: "object",
    properties: {
      slug: { type: "string" },
      title: { type: "string", nullable: true },
      groups: {
        type: "array",
        description: "分组嵌套树（物化路径逐级）",
        items: { type: "object", additionalProperties: true },
      },
      docs: {
        type: "array",
        description: "未分组文档卡片（挂根部）",
        items: { type: "object", additionalProperties: true },
      },
    },
  },
};

/** 标签（按领域细分；ops 单独一组）。 */
const TAG_DESCRIPTIONS: Array<{ name: string; description: string }> = [
  { name: "session-core", description: "会话生命周期：创建/列表/详情/归档/删除/分叉/快照" },
  { name: "session-conversation", description: "对话通道：prompt/steer/inject/业务事件/队列" },
  { name: "session-observe", description: "状态与观测：state/bootstrap/status/事件流与回放/用量" },
  { name: "session-panel", description: "控制台面板：命令/模型/思考/todo/上下文/模式/维护" },
  { name: "session-agent", description: "Agent Hub：名册/定义/transcript/chat/kill/revive" },
  { name: "session-workspace", description: "会话工作区：文件读写/上传/git/worktree" },
  { name: "session-tools", description: "会话工具面：运行时工具集/工具发现/MCP/LSP/异步任务" },
  { name: "config-models", description: "用户级模型配置：目录/models.yml/provider/凭据/角色/探针" },
  { name: "config-automation", description: "用户级自动化：审批策略与授权/钩子/回调/业务工具/上下文文件" },
  { name: "config-discovery", description: "用户级发现项与用量：skills/plugins/MCP 开关/限额/用量/schema" },
  { name: "internal", description: "内部生命周期契约（/internal/*）：上游服务专用，分享令牌拒绝" },
  { name: "admin", description: "全局资源管理（/admin/*）：需上游注入 X-Admin-Id" },
  { name: "ops", description: "运维探针（healthz/readyz/metrics/openapi），内网无凭据" },
];

/** 路径 → 标签。 */
function tagFor(p: string): string {
  if (p.startsWith("/admin")) return "admin";
  if (p.startsWith("/internal")) return "internal";
  if (p === "/healthz" || p === "/readyz" || p === "/metrics" || p === "/openapi.json") return "ops";
  if (p.startsWith("/api/me")) {
    if (/^\/api\/me\/(models|providers|model-roles)/.test(p)) return "config-models";
    if (/^\/api\/me\/(approval|hooks|webhooks|tools|context-files|agents)/.test(p)) return "config-automation";
    return "config-discovery";
  }
  if (/\/agents(\/|$)/.test(p)) return "session-agent";
  if (/\/git(\/|$)|\/file|\/files|\/tree/.test(p)) return "session-workspace";
  if (/\/mcp|\/lsp|\/tools|\/jobs/.test(p)) return "session-tools";
  if (/\/(commands|models|thinking|todos|context|modes|plan|maintenance|session-tree|skills)/.test(p))
    return "session-panel";
  if (/\/(state|bootstrap|status|events|usage|stats|messages|dump|integration)/.test(p)) return "session-observe";
  if (
    /\/(prompt|steer|inject|business-events|follow-up|abort|queue|interrupt|title|name|cycle|reset|handoff|compact|fresh|export|model|branch|fork|restore-interrupted|messages\/custom)/.test(
      p,
    )
  )
    return "session-conversation";
  return "session-core";
}

/**
 * 组装单个操作的 OpenAPI 条目：摘要 / 参数 / 请求体 / 响应全部查表。
 * 查不到摘要说明该路由没在 SUMMARIES 登记——由合约测试守住覆盖率 100%。
 */
function operationFor(method: string, p: string, rawPath: string): Record<string, unknown> {
  const key = `${method.toUpperCase()} ${p}`;
  const params: unknown[] = [...rawPath.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => ({
    name: m[1],
    in: "path",
    required: true,
    schema: { type: "string" },
  }));
  for (const q of QUERIES[key] ?? []) {
    params.push({
      name: q.name,
      in: "query",
      required: false,
      schema: q.schema ?? { type: "string" },
      description: q.description,
    });
  }

  const responses: Record<string, unknown> = {
    "401": { description: "认证失败", content: { "application/json": { schema: ERROR_SCHEMA_REF } } },
  };
  for (const code of ERRORS[key] ?? []) {
    const [status, ...rest] = code.split(" ");
    responses[status] = {
      description: rest.join(" "),
      content: { "application/json": { schema: ERROR_SCHEMA_REF } },
    };
  }
  // 200 响应模型：登记过的指向 components.schemas，其余给通用对象
  const responseSchema = RESPONSES[key];
  responses["200"] = responseSchema
    ? {
        description: "OK",
        content: { "application/json": { schema: { $ref: `#/components/schemas/${responseSchema}` } } },
      }
    : { description: "OK", content: { "application/json": { schema: { type: "object" } } } };

  const op: Record<string, unknown> = {
    tags: [tagFor(p)],
    summary: SUMMARIES[key] ?? `${method.toUpperCase()} ${p}`,
    parameters: params,
    responses,
  };

  // 请求体
  const bodyType = BODIES[key];
  if (bodyType === "kbUploadZip" || bodyType === "kbUploadPdf") {
    // multipart 最小描述（参照 importSession 的原文通道特判）
    op.requestBody = {
      required: true,
      content: {
        "multipart/form-data": {
          schema:
            bodyType === "kbUploadZip"
              ? {
                  type: "object",
                  required: ["zip"],
                  properties: {
                    zip: { type: "string", format: "binary", description: "MinerU ParseOutcome zip（一包一文档）" },
                    group: { type: "string", description: "分组物化路径（如 A/B/C；缺省归根）" },
                  },
                }
              : {
                  type: "object",
                  required: ["doc", "pdf"],
                  properties: {
                    doc: { type: "string", description: "已入库的文档名" },
                    pdf: { type: "string", format: "binary", description: "原始 PDF（写 docs/<doc>/source.pdf）" },
                  },
                },
        },
      },
    };
  } else if (bodyType) {
    if (bodyType === "importSession") {
      op.requestBody = {
        required: true,
        content: { "text/plain": { schema: { type: "string", description: "会话 JSONL 原文（NDJSON，≤20MB）" } } },
      };
    } else {
      op.requestBody = {
        required: true,
        content: { "application/json": { schema: (BODY as Record<string, unknown>)[bodyType] ?? { type: "object" } } },
      };
    }
  }

  // 幂等语义（DESIGN §7）
  if (method.toUpperCase() === "POST" && (p === "/api/sessions" || p === "/api/sessions/{sid}/snapshots")) {
    params.push({
      name: "Idempotency-Key",
      in: "header",
      schema: { type: "string" },
      description: "24h 窗口内同 user+scope 重放同响应（仅缓存 2xx）",
    });
  }
  return op;
}

/** 从根 Hono 实例生成 /openapi.json 文档（GET /openapi.json 直接消费）。 */
export function buildOpenApi(app: Hono): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  const routes = (app as unknown as { routes: Array<{ method: string; path: string }> }).routes ?? [];
  let opCount = 0;
  let documentedCount = 0;
  for (const route of routes) {
    if (route.method === "ALL") continue;
    const raw = route.path.startsWith("/") ? route.path : `/${route.path}`;
    const p = raw.replace(/:([A-Za-z0-9_]+)/g, "{$1}"); // Hono :uid → OpenAPI {uid}
    paths[p] ??= {};
    opCount++;
    if (SUMMARIES[`${route.method.toUpperCase()} ${p}`]) documentedCount++;
    paths[p][route.method.toLowerCase()] = operationFor(route.method, p, raw);
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "omp gateway",
      version: "0.2.0",
      description:
        "多租户 omp 会话引擎（Hono + @oh-my-pi/pi-coding-agent 进程内 SDK）。语义与分层规则见 docs/DESIGN.md；" +
        "运维手册见 docs/SOP.md；SSE 事件契约见 contracts/gateway-events.v1.schema.json。" +
        "认证：Authorization: Bearer <service-token> + X-User-Id；分享令牌经 X-Share-Token（绑定单会话，view/control 两级）。",
    },
    servers: [{ url: "/" }],
    tags: TAG_DESCRIPTIONS,
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
        shareToken: { type: "apiKey", in: "header", name: "x-share-token" },
      },
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: {
              type: "object",
              required: ["code", "message"],
              properties: {
                code: { type: "string", description: "按 code 分支，勿解析 message（见 x-gateway-error-codes）" },
                message: { type: "string" },
                details: { type: "object", description: "可选（流式队列统计/限额信息等）" },
              },
            },
          },
        },
        GatewayEventEnvelope: {
          type: "object",
          required: ["seq", "ts", "type"],
          properties: {
            seq: { type: "integer", description: "会话内单调，SSE id: 与 Last-Event-ID 回放游标" },
            ts: { type: "integer", description: "epoch ms" },
            type: { type: "string", enum: [...GATEWAY_EVENT_TYPES] },
            correlation: {
              type: "object",
              description: "存在即属于某业务事件响应链（POST business-events 触发的 turn）",
              properties: { eventId: { type: "string" }, type: { type: "string" } },
            },
          },
        },
        ...RESPONSE_SCHEMAS,
      },
    },
    "x-gateway-events": {
      transport: "SSE (GET /api/sessions/:sid/events) 或 GET /:sid/events/replay（JSON 回放）",
      envelope: { $ref: "#/components/schemas/GatewayEventEnvelope" },
      types: GATEWAY_EVENT_TYPES,
      reconnect: "Last-Event-ID 回放（仅消息/工具类）+ replay.state 状态帧；先订阅后 prompt",
    },
    "x-gateway-error-codes": GATEWAY_ERROR_CODES,
    "x-gateway-coverage": {
      operations: opCount,
      documented: documentedCount,
      /** 摘要覆盖率（1 = 全部操作都有操作级描述） */
      summaryCoverage: opCount > 0 ? documentedCount / opCount : 1,
      queryParams: Object.keys(QUERIES).length,
      responseModels: Object.keys(RESPONSE_SCHEMAS).length,
      tags: TAG_DESCRIPTIONS.map((t) => t.name),
    },
    "x-headers": {
      "X-User-Id": "上游注入的用户标识（svc-token 必带）",
      "X-Request-Id": "全链路透传，缺失生成",
      "Idempotency-Key": "写操作幂等（建会话/建快照，24h 重放）",
      "X-Share-Token": "分享令牌（绑定单会话；view 只读 / control 对话写）",
    },
  };
}
