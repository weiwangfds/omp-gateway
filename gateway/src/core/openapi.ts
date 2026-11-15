import type { Hono } from "hono";

/**
 * OpenAPI 3.1 契约生成器（DESIGN §12 契约冻结，§33 后随实现演进）。
 *
 * 三层来源：
 *  1. 路由表内省（paths/methods/路径参数，route() 已合并挂载前缀）
 *  2. ROUTE_DOCS 精选操作文档（摘要/请求体/错误码——集成端高频面逐个维护）
 *  3. FAMILY_SUMMARY 族摘要（其余操作按路径前缀覆盖，保证 100% 有摘要）
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
  FILE_TOO_LARGE: "413 文件超限（读 25MB/写 5MB/插件 2MB）",
  SNAPSHOT_EMPTY: "409 零 turn 会话无可快照内容",
  ALREADY_EXISTS: "409 资源已存在",
  MAINTENANCE_BUSY: "409 迁移操作进行中",
  MANIFEST_INVALID: "400 迁移 bundle manifest 缺失/不符",
  SCHEMA_VERSION_MISMATCH: "400 DB schema 版本高于当前网关",
  GATEWAY_NOT_DRAINED: "409 export/import 要求实例已 drain",
  BUNDLE_INCOMPLETE: "400 bundle 校验和/计数对账失败",
  DRAINING: "503 实例关停中，切流到其他实例",
  GATEWAY_UNCONFIGURED: "503 未配置 svc-token（运维问题）",
};

const ERROR_SCHEMA_REF = { $ref: "#/components/schemas/Error" };

/** 通用响应（全部操作都默认携带；ROUTE_DOCS 可追加专属错误）。 */
function baseResponses(): Record<string, unknown> {
  return {
    "200": { description: "OK", content: { "application/json": { schema: { type: "object" } } } },
    "401": { description: "认证失败", content: { "application/json": { schema: ERROR_SCHEMA_REF } } },
  };
}

/** 追加操作专属错误响应（code 形如 "409 SESSION_BUSY"）。 */
function errorResponses(codes: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const code of codes) {
    const [status, ...rest] = code.split(" ");
    out[status] = {
      description: rest.join(" "),
      content: { "application/json": { schema: ERROR_SCHEMA_REF } },
    };
  }
  return out;
}

/** 常用请求体（轻量 JSON Schema；复杂语义由 ROUTE_DOCS.summary 补充说明）。 */
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
} as const;

type RouteDoc = {
  summary: string;
  body?: { type: string; description?: string };
  errors?: string[];
};

/**
 * 精选操作文档（集成端高频面逐条维护；键 = "METHOD /openapi路径"）。
 * 未覆盖的操作由 FAMILY_SUMMARY 兜底，不要求逐条登记。
 */
const ROUTE_DOCS: Record<string, RouteDoc> = {
  // ---- 会话生命周期 ----
  "POST /api/sessions": {
    summary: "建会话（幂等：Idempotency-Key 24h 重放）",
    body: { type: "createSession" },
    errors: ["409 SESSION_LIMIT", "403 PROVIDER_NOT_ALLOWED", "404 MODEL_NOT_FOUND", "503 DRAINING"],
  },
  "GET /api/sessions": { summary: "会话列表（分页 + 内联 live/usage/contextPercent/lastMessage）", errors: [] },
  "GET /api/sessions/search": { summary: "会话正文搜索（扫 JSONL，回 snippet）", errors: ["400 BAD_REQUEST"] },
  "GET /api/sessions/{sid}": { summary: "会话详情（元数据 + live 状态 + usage）", errors: ["404 NOT_FOUND"] },
  "PATCH /api/sessions/{sid}": { summary: "改标题 / 归档↔恢复（归档即释放进程态）", errors: ["404 NOT_FOUND"] },
  "DELETE /api/sessions/{sid}": {
    summary: "删除会话（pre_delete 自动快照 → trash 30 天可找回）",
    errors: ["400 CONFIRM_REQUIRED"],
  },
  // ---- 对话 ----
  "POST /api/sessions/{sid}/prompt": {
    summary: "发起 turn：202 准许即返回，结果走 SSE；wait=true 同步等终态",
    body: { type: "prompt" },
    errors: [
      "400 BAD_REQUEST",
      "409 SESSION_NOT_LIVE",
      "409 MODEL_UNAVAILABLE",
      "409 SESSION_STREAMING",
      "429 STREAM_QUEUE_TIMEOUT",
      "429 RATE_LIMITED",
      "402 BUDGET_EXCEEDED",
      "403 INPUT_BLOCKED",
    ],
  },
  "POST /api/sessions/{sid}/steer": {
    summary: "向正在流式的会话插入引导（不打断当前 turn）",
    body: { type: "prompt" },
    errors: ["409 MODEL_UNAVAILABLE", "429 STREAM_QUEUE_TIMEOUT"],
  },
  "POST /api/sessions/{sid}/abort": { summary: "中止当前 turn（202）", errors: [] },
  "POST /api/sessions/{sid}/inject": {
    summary: "提示词注入：context（不耗模型）/ user（触发 turn，可同步等待）",
    body: { type: "inject" },
    errors: ["400 BAD_REQUEST", "409 NOT_SUPPORTED", "409 INJECT_FAILED", "429 RATE_LIMITED"],
  },
  "POST /api/sessions/{sid}/business-events": {
    summary: "业务事件注入：登记 → 广播 → 可选触发 turn（事件带 correlation 关联）",
    body: { type: "businessEvent" },
    errors: ["400 BAD_REQUEST", "409 BUSINESS_EVENT_INJECT_FAILED"],
  },
  // ---- 状态/观测 ----
  "GET /api/sessions/{sid}/state": {
    summary: "状态快照一次拿全（模型/思考/队列/工具/上下文/消息数）",
    errors: ["409 SESSION_NOT_LIVE"],
  },
  "GET /api/sessions/{sid}/bootstrap": {
    summary: "集成端初始化聚合：session/state/modes/approvals/commands/events 游标",
    errors: [],
  },
  "GET /api/sessions/{sid}/status": { summary: "轻量轮询（status/model/approvals 计数/queue/latestSeq）", errors: [] },
  "GET /api/sessions/{sid}/events": {
    summary: "SSE 事件流（先订阅后 prompt；Last-Event-ID 重连；?types= 过滤）",
    errors: [],
  },
  "GET /api/sessions/{sid}/events/replay": {
    summary: "JSON 回放（SSE 断线补齐/轮询；环形缓冲最近 500 条）",
    errors: [],
  },
  "GET /api/sessions/{sid}/usage": { summary: "会话用量（汇总 + 最近 50 turn 明细）", errors: [] },
  // ---- 审批 ----
  "GET /api/sessions/{sid}/approvals": { summary: "待审批清单（M6：超时后端自动拒绝）", errors: [] },
  "POST /api/sessions/{sid}/approvals/{approvalId}": {
    summary: "审批决定（404=已决/超时）",
    body: { type: "approvalDecision" },
    errors: ["400 BAD_REQUEST", "404 NOT_FOUND"],
  },
  // ---- 快照 ----
  "GET /api/sessions/{sid}/snapshots": { summary: "快照列表", errors: [] },
  "GET /api/sessions/{sid}/snapshots/{snapId}": {
    summary: "单个快照元数据（id/trigger/entry_count/turn；文件路径不外泄）",
    errors: ["404 NOT_FOUND"],
  },
  "POST /api/sessions/{sid}/snapshots": {
    summary: "手动快照（幂等；零 turn 会话 409 SNAPSHOT_EMPTY）",
    errors: ["409 SNAPSHOT_EMPTY"],
  },
  "POST /api/sessions/{sid}/snapshots/{snapId}/restore": {
    summary: "快照恢复：fork（默认，安全）或 rollback（同 sid 换文件，先打 pre_restore 快照）",
    errors: ["404 NOT_FOUND", "409 SESSION_STREAMING"],
  },
  "DELETE /api/sessions/{sid}/snapshots/{snapId}": { summary: "删除快照", errors: ["404 NOT_FOUND"] },
  // ---- 派生 ----
  "POST /api/sessions/{sid}/fork": {
    summary: "分叉：无 entryId=血缘分叉；有 entryId=SDK 原地分支后换绑",
    errors: ["409 SESSION_NOT_LIVE", "409 FORK_FAILED", "409 FORK_REJECTED"],
  },
  "POST /api/sessions/{sid}/branch": {
    summary: "条目级编辑分支（返回编辑器草稿：选中消息文本/图片）",
    errors: ["400 BAD_REQUEST", "409 BRANCH_FAILED", "409 BRANCH_CANCELLED"],
  },
  // ---- Agent Hub ----
  "GET /api/sessions/{sid}/agents": { summary: "子代理名册（live 状态）", errors: [] },
  "GET /api/sessions/{sid}/agents/definitions": { summary: "本会话可见 agent 定义 + advertised 标记", errors: [] },
  "POST /api/sessions/{sid}/agents/{aid}/chat": {
    summary: "向子代理发消息（parked/killed 先自动复活）",
    errors: ["404 NOT_FOUND", "409 AGENT_NOT_LIVE", "409 AGENT_CHAT_FAILED"],
  },
  "POST /api/sessions/{sid}/agents/{aid}/kill": {
    summary: "中止子代理（tombstone；transcript 留盘可复活）",
    errors: ["404 NOT_FOUND"],
  },
  "POST /api/sessions/{sid}/agents/{aid}/revive": {
    summary: "从持久化 transcript 忠实重建子代理",
    errors: ["404 NOT_FOUND", "409 AGENT_ALREADY_LIVE", "409 NOT_REVIVABLE", "409 REVIVE_FAILED"],
  },
  // ---- 回调与钩子 ----
  "POST /api/me/webhooks": {
    summary: "注册用户级回调（HMAC 签名推送；secret 仅创建响应返回一次）",
    body: { type: "webhookRegister" },
    errors: ["400 BAD_REQUEST", "403 FORBIDDEN"],
  },
  "POST /api/sessions/{sid}/webhooks": {
    summary: "注册会话级回调（只收该会话事件）",
    body: { type: "webhookRegister" },
    errors: ["400 BAD_REQUEST", "403 FORBIDDEN"],
  },
  "POST /api/me/hooks": {
    summary: "注册用户级生命周期钩子（notify 异步 / decide 同步决策）",
    body: { type: "hookRegister" },
    errors: ["400 BAD_REQUEST", "403 FORBIDDEN"],
  },
  "POST /api/sessions/{sid}/hooks": {
    summary: "注册会话级钩子",
    body: { type: "hookRegister" },
    errors: ["400 BAD_REQUEST", "403 FORBIDDEN"],
  },
  "GET /api/me/hooks": { summary: "钩子清单 + 21 事件契约（decide 事件子集）", errors: [] },
  // ---- HTTP 工具 ----
  "PUT /api/me/tools/http/{name}": {
    summary: "注册用户级 HTTP 工具（业务函数暴露给 agent；注册后热应用）",
    body: { type: "httpToolRegister" },
    errors: ["400 BAD_REQUEST", "400 INVALID_NAME", "403 FORBIDDEN", "413 PAYLOAD_TOO_LARGE"],
  },
  "PUT /api/sessions/{sid}/tools/http/{name}": {
    summary: "注册会话级 HTTP 工具（同名覆盖用户级）",
    body: { type: "webhookRegister" },
    errors: ["400 BAD_REQUEST", "400 INVALID_NAME"],
  },
  // ---- 模型与配置（结构化 JSON，DESIGN §30） ----
  "GET /api/me/models": { summary: "模型目录（含 cost/contextWindow 能力；?find= 搜索）", errors: [] },
  "PUT /api/me/models/config": {
    summary: "models.yml 写入：application/json=结构化（校验+格式化）；text/yaml=原文",
    body: { type: "modelsConfigJson" },
    errors: ["400 INVALID_CONFIG", "400 INVALID_PROVIDER", "400 INVALID_JSON"],
  },
  "GET /api/me/models/config": {
    summary: "models.yml 原文；?format=json 返回结构化视图",
    errors: ["400 INVALID_YAML"],
  },
  "PUT /api/me/models/providers/{provider}": {
    summary: "单 provider 整体替换（省略字段即删除；其他 provider 不动）",
    errors: ["400 INVALID_CONFIG", "400 INVALID_PROVIDER"],
  },
  "POST /api/me/models/credentials": {
    summary: "凭据注入（合并进 models.yml 的 provider.apiKey）",
    errors: ["400 BAD_REQUEST"],
  },
  "POST /api/me/models/test": {
    summary: "模型探针：独立内存会话发一条探针，测 TTFT/总时长/错误",
    errors: ["400 BAD_REQUEST", "404 MODEL_NOT_FOUND"],
  },
  "GET /api/me/config/schema": {
    summary: "配置自描述：provider/model/agent 字段清单与示例（前端表单生成用）",
    errors: [],
  },
  "PUT /api/me/agents/{name}": {
    summary: "Agent 定义写入：application/json=结构化（字段白名单）；text/markdown=原文",
    body: { type: "agentDefinition" },
    errors: ["400 INVALID_AGENT", "400 INVALID_FRONTMATTER", "400 INVALID_NAME"],
  },
  "POST /api/me/agents": {
    summary: "创建 Agent 定义（name 取自 body；同名 409）",
    errors: ["400 INVALID_AGENT", "400 INVALID_NAME", "409 ALREADY_EXISTS"],
  },
  "GET /api/me/agents/{name}": {
    summary: "Agent 定义原文；?format=json 返回规范字段+frontmatter",
    errors: ["404 NOT_FOUND"],
  },
  "PUT /api/me/approval": {
    summary: "审批策略：mode（4 档）+ 按工具 policies（整体替换）",
    errors: ["400 BAD_REQUEST"],
  },
  "PUT /api/me/providers/settings": {
    summary: "disabledProviders 开关（对新会话生效；live 会话保留 registry）",
    errors: ["400 BAD_REQUEST"],
  },
  "GET /api/me/providers": {
    summary: "Provider 结构化视图（configured/available/disabled；apiKey 不返回明文）",
    errors: ["400 INVALID_YAML"],
  },
  "GET /api/me/limits": { summary: "配额：限额/本月用量/预算余额/RPM 窗口", errors: [] },
  // ---- 会话文件/导入 ----
  "POST /api/sessions/validate": {
    summary: "会话 JSONL dry-run 校验（不落库）",
    errors: ["400 BAD_REQUEST", "413 PAYLOAD_TOO_LARGE"],
  },
  "POST /api/sessions/import": {
    summary: "导入会话 JSONL（校验 → 补 model_change → 建文件与 DB 行）",
    body: { type: "string", description: "JSONL 原文" },
    errors: ["400 INVALID_SESSION_FILE", "409 ALREADY_EXISTS", "413 PAYLOAD_TOO_LARGE"],
  },
  "GET /api/sessions/{sid}/session-file": {
    summary: "下载原始 JSONL（NDJSON attachment）",
    errors: ["404 NOT_FOUND", "409 SESSION_NOT_LIVE", "413 PAYLOAD_TOO_LARGE"],
  },
  // ---- 文件/git ----
  "GET /api/sessions/{sid}/file": {
    summary: "读文件（JSON 信封 {path,encoding,content,size}）",
    errors: ["400 BAD_REQUEST", "404 NOT_FOUND"],
  },
  "PUT /api/sessions/{sid}/file": {
    summary: "写文件（utf8/base64；≤5MB）",
    errors: ["400 PATH_FORBIDDEN", "413 FILE_TOO_LARGE"],
  },
  "GET /api/sessions/{sid}/file/raw": {
    summary: "原始字节流（Range 支持拖动；图像/PDF 直接预览）",
    errors: ["404 NOT_FOUND", "416 INVALID_RANGE"],
  },
  "POST /api/sessions/{sid}/git/commit": {
    summary: "stage（all 或路径白名单）后提交",
    errors: ["409 NOT_A_GIT_REPO", "409 GIT_FAILED"],
  },
  "POST /api/sessions/{sid}/git/worktrees": {
    summary: "新建 worktree（路径必须位于用户数据根内）",
    errors: ["400 PATH_FORBIDDEN", "409 NOT_A_GIT_REPO"],
  },
  // ---- 内部契约 ----
  "POST /internal/users/{uid}/provision": { summary: "懒 provision：建目录骨架 + 租户行（幂等）", errors: [] },
  "PATCH /internal/users/{uid}/limits": {
    summary: "限额 PATCH（合并语义：maxSessions/maxConcurrent/allowedProviders）",
    errors: [],
  },
  "DELETE /internal/users/{uid}": {
    summary: "级联删除：dispose 全部 live → deleted（30d trash 后物理清除）",
    errors: ["400 CONFIRM_REQUIRED"],
  },
  "GET /internal/trash": { summary: "trash 列表（会话/租户，30d 窗口）", errors: [] },
  "POST /internal/trash/sessions/{sid}/restore": {
    summary: "trash 找回会话（清 deleted_at，状态回 active）",
    errors: ["404 NOT_FOUND"],
  },
  "POST /internal/drain": {
    summary: "滚动发布排空：开启后建会话 503、healthz 503（再次调用同一端点关闭）",
    errors: [],
  },
  "POST /internal/maintenance/export": {
    summary: "环境导出：drain → dispose 全部 live → VACUUM INTO + 文件树 + manifest（sha256/计数）",
    errors: ["409 MAINTENANCE_BUSY", "500 EXPORT_FAILED"],
  },
  "POST /internal/maintenance/import": {
    summary: "环境导入：manifest/sha256 校验 → 原子换树 → 重开库 → 计数对账；失败自动回滚",
    body: { type: "migrationImport" },
    errors: [
      "400 MANIFEST_INVALID",
      "400 SCHEMA_VERSION_MISMATCH",
      "400 BUNDLE_INCOMPLETE",
      "403 PATH_FORBIDDEN",
      "500 IMPORT_FAILED",
    ],
  },
  // ---- 管理 ----
  "PUT /admin/global/skills/{name}": {
    summary: "全局 skill 写入（所有用户可见；用户同名覆盖）",
    errors: ["400 INVALID_NAME"],
  },
  "PUT /admin/global/mcp": { summary: "全局 MCP 配置（合成进各用户 workspace）", errors: ["400 INVALID_JSON"] },
};

/**
 * 族摘要（longest-prefix 兜底）：未进 ROUTE_DOCS 的操作按前缀取摘要，
 * 保证 /openapi.json 里没有 "GET /path" 这种零信息条目。
 */
const FAMILY_SUMMARY: Array<[string, string]> = [
  ["/api/me/context-files", "用户级上下文文件（AGENTS/RULES/APPEND_SYSTEM/SYSTEM）"],
  ["/api/me/mcp/settings", "MCP 用户级开关（disabledServers 优先级最高）"],
  ["/api/me/mcp", "MCP 原始配置读写"],
  ["/api/me/skills", "skill 清单与用户级 CRUD"],
  ["/api/me/plugins", "插件清单与用户级 CRUD"],
  ["/api/me/model-roles", "模型角色（@role 别名与 cycleOrder）"],
  ["/api/me/usage", "用户用量聚合（day/model/session 分桶）"],
  ["/api/me/projects", "按仓库聚合会话（origin url 维度）"],
  ["/api/me/approval/grants", "持久授权清单（approval-cache.db 直读/清空）"],
  ["/api/me/approval", "审批策略读写"],
  ["/api/me/webhooks", "用户级回调管理"],
  ["/api/me/hooks", "用户级钩子管理"],
  ["/api/me/tools/http", "用户级 HTTP 工具管理"],
  ["/api/me/agents", "Agent 定义管理（结构化 JSON/原文双通道）"],
  ["/api/me/models", "模型目录与配置"],
  ["/api/me/providers", "Provider 视图与开关"],
  ["/api/me", "用户级配置与集成资源"],
  ["/api/sessions/{sid}/entries", "会话条目（fork/branch 寻址键）"],
  ["/api/sessions/{sid}/files", "workspace 文件"],
  ["/api/sessions/{sid}/file", "workspace 文件读写"],
  ["/api/sessions/{sid}/git", "workspace git"],
  ["/api/sessions/{sid}/jobs", "异步任务"],
  ["/api/sessions/{sid}/agents", "Agent Hub"],
  ["/api/sessions/{sid}/mcp", "MCP 明细与重连/资源"],
  ["/api/sessions/{sid}/messages", "消息与自定义消息通道"],
  ["/api/sessions/{sid}/queue", "消息队列管理"],
  ["/api/sessions/{sid}/share-link", "分享链接"],
  ["/api/sessions/{sid}/snapshots", "快照"],
  ["/api/sessions/{sid}/tools", "运行时工具集与 HTTP 工具"],
  ["/api/sessions/{sid}/webhooks", "会话级回调"],
  ["/api/sessions/{sid}/hooks", "会话级钩子"],
  ["/api/sessions/{sid}/thinking", "思考档位"],
  ["/api/sessions/{sid}/todos", "todo 面板"],
  ["/api/sessions/{sid}/models", "模型选择器"],
  ["/api/sessions/{sid}", "会话能力面（live 语义：未命中按文件复活）"],
  ["/internal/users/{uid}/usage", "上游计费/展示用量聚合"],
  ["/internal/users/{uid}/summary", "用户状态与 live/streaming 计数"],
  ["/internal/users/{uid}/webhooks", "用户回调（内部视角）"],
  ["/internal/webhooks", "用户回调（内部视角：注册/列表/注销）"],
  ["/internal/users/{uid}", "用户生命周期（provision/summary/limits/级联删除）"],
  ["/internal/trash", "trash 找回"],
  ["/internal/audit", "审计查询"],
  ["/internal/maintenance", "环境迁移"],
  ["/admin/global", "全局资源管理（所有用户可见）"],
  ["/healthz", "存活探针"],
  ["/readyz", "就绪探针（数据根可写 + DB 可用）"],
  ["/metrics", "Prometheus 指标"],
  ["/openapi.json", "本契约文档"],
];

function tagFor(p: string): string {
  if (p.startsWith("/admin")) return "admin";
  if (p.startsWith("/internal")) return "internal";
  if (p.startsWith("/api/me")) return "api-config";
  if (p.startsWith("/api")) return "api-session";
  return "ops";
}

const TAG_DESCRIPTIONS: Array<{ name: string; description: string }> = [
  { name: "api-session", description: "会话能力面（/api/sessions/*）：对话、状态、快照、Agent Hub、文件与 git" },
  { name: "api-config", description: "用户级配置面（/api/me/*）：模型/审批/回调/钩子/HTTP 工具/上下文文件" },
  { name: "internal", description: "内部生命周期契约（/internal/*）：上游服务专用，分享令牌拒绝" },
  { name: "admin", description: "全局资源管理（/admin/*）：需上游注入 X-Admin-Id" },
  { name: "ops", description: "运维探针（healthz/readyz/metrics），内网无凭据" },
];

/** longest-prefix 族摘要；未命中返回 null（保持旧式 METHOD path）。 */
function familySummary(p: string): string | null {
  let best: string | null = null;
  for (const [prefix, summary] of FAMILY_SUMMARY) {
    if ((p === prefix || p.startsWith(`${prefix}/`)) && (best === null || prefix.length > (best?.length ?? 0))) {
      const candidate = FAMILY_SUMMARY.find(([pre]) => pre === prefix);
      if (candidate && (best === null || prefix.length > best.length)) best = prefix;
      void summary;
    }
  }
  if (!best) return null;
  return FAMILY_SUMMARY.find(([pre]) => pre === best)![1];
}

/** 组装单个操作的 OpenAPI 条目。 */
function operationFor(method: string, p: string, rawPath: string): Record<string, unknown> {
  const doc = ROUTE_DOCS[`${method.toUpperCase()} ${p}`];
  const params = [...rawPath.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => ({
    name: m[1],
    in: "path",
    required: true,
    schema: { type: "string" },
  }));

  const op: Record<string, unknown> = {
    tags: [tagFor(p)],
    summary: doc?.summary ?? familySummary(p) ?? `${method.toUpperCase()} ${p}`,
    parameters: params,
    responses: { ...baseResponses(), ...(doc?.errors ? errorResponses(doc.errors) : {}) },
  };

  // 请求体（ROUTE_DOCS 声明了 body 才写 requestBody）
  if (doc?.body) {
    const inline = (BODY as Record<string, unknown>)[doc.body.type];
    if (inline) {
      op.requestBody = {
        required: true,
        content: { "application/json": { schema: inline } },
      };
    } else if (doc.body.type === "string") {
      // 原文通道（JSONL 导入 / YAML / Markdown）
      op.requestBody = { required: true, content: { "text/plain": { schema: { type: "string" } } } };
    } else {
      // 无预置 schema 的 JSON 体：给通用对象 + 语义描述
      op.requestBody = {
        required: true,
        content: { "application/json": { schema: { type: "object", description: doc.body.description } } },
      };
    }
  }

  // 幂等语义（DESIGN §7）
  if (method.toUpperCase() === "POST" && (p === "/api/sessions" || p === "/api/sessions/{sid}/snapshots")) {
    op.parameters = [
      ...(op.parameters as unknown[]),
      {
        name: "Idempotency-Key",
        in: "header",
        schema: { type: "string" },
        description: "24h 窗口内同 user+scope 重放同响应（仅缓存 2xx）",
      },
    ];
    (op.responses as Record<string, unknown>)["200"] = {
      description: "Idempotency-Replayed: true（命中重放）",
      content: { "application/json": { schema: { type: "object" } } },
    };
  }
  return op;
}

/** 从根 Hono 实例生成 /openapi.json 文档（GET /openapi.json 直接消费）。 */
export function buildOpenApi(app: Hono): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  const routes = (app as unknown as { routes: Array<{ method: string; path: string }> }).routes ?? [];
  for (const route of routes) {
    if (route.method === "ALL") continue;
    const raw = route.path.startsWith("/") ? route.path : `/${route.path}`;
    const p = raw.replace(/:([A-Za-z0-9_]+)/g, "{$1}"); // Hono :uid → OpenAPI {uid}
    paths[p] ??= {};
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
      },
    },
    "x-gateway-events": {
      transport: "SSE (GET /api/sessions/:sid/events) 或 GET /:sid/events/replay（JSON 回放）",
      envelope: { $ref: "#/components/schemas/GatewayEventEnvelope" },
      types: GATEWAY_EVENT_TYPES,
      reconnect: "Last-Event-ID 回放（仅消息/工具类）+ replay.state 状态帧；先订阅后 prompt",
    },
    "x-gateway-error-codes": GATEWAY_ERROR_CODES,
    "x-headers": {
      "X-User-Id": "上游注入的用户标识（svc-token 必带）",
      "X-Request-Id": "全链路透传，缺失生成",
      "Idempotency-Key": "写操作幂等（建会话/建快照，24h 重放）",
      "X-Share-Token": "分享令牌（绑定单会话；view 只读 / control 对话写）",
    },
  };
}
