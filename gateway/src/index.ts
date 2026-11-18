/**
 * 网关进程入口：路由组装、定时任务启停、优雅关停。
 *
 * 挂载拓扑：/api（上游转发，X-User-Id + svc-token）、/internal（生命周期契约，同凭据）、
 * /admin（全局管理，X-Admin-Id）、/（ops，内网无凭据）。关停顺序：先 beginDispose 封闸
 * 防 new work，再等全部 dispose 落定，最后停 server。
 */
import { Hono } from "hono";
import { websocket as bunWebSocket } from "hono/bun";
import { config } from "./config.ts";
import { authMiddleware, requireFullAuth, requireAdmin } from "./middleware/auth.ts";
import { ensureGlobalScaffold } from "./core/paths.ts";
import { ensureQmdMcpRegistered } from "./core/kb/qmd.ts";
import { ensureWrenDatasources, startWrenAutoSync, stopWrenAutoSync, syncAll } from "./core/wren.ts";
import { refreshAllKbSkills } from "./core/kb/skill.ts";
import { sessionsApp } from "./routes/sessions.ts";
import { terminalApp } from "./routes/terminal.ts";
import { usageApp } from "./routes/usage.ts";
import { configResourcesApp } from "./routes/config-resources.ts";
import { agentConfigApp } from "./routes/agent-config.ts";
import { adminApp } from "./routes/admin.ts";
import { internalApp } from "./routes/internal.ts";
import { maintenanceApp } from "./routes/maintenance.ts";
import { opsApp } from "./routes/ops.ts";
import { registry } from "./core/session-registry.ts";
import { startIdleCuller, stopIdleCuller } from "./jobs/idle-culler.ts";
import { startTrashPurger, stopTrashPurger } from "./jobs/trash-purger.ts";
import { startSnapshotPruner, stopSnapshotPruner } from "./jobs/snapshot-pruner.ts";
import { startBackupJob } from "./jobs/backup.ts";
import { buildOpenApi } from "./core/openapi.ts";
import { disposeSession } from "./core/session-factory.ts";

const app = new Hono();

// X-Request-Id 全链路（DESIGN §7）：透传上游的，缺失则生成
app.use("*", async (c, next) => {
  const rid = c.req.header("x-request-id") ?? crypto.randomUUID();
  c.header("X-Request-Id", rid);
  await next();
});

// CORS（DESIGN §21 集成面）：GATEWAY_CORS_ORIGINS 非空时启用（浏览器直连/分享页场景）。
// 默认架构是 BFF 代理，无需开启；预检必须在认证前短路。
if (config.corsOrigins.length > 0) {
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin && (config.corsOrigins.includes("*") || config.corsOrigins.includes(origin))) {
      c.header("Access-Control-Allow-Origin", config.corsOrigins.includes("*") ? "*" : origin);
      c.header("Vary", "Origin");
      c.header(
        "Access-Control-Allow-Headers",
        "authorization,content-type,x-user-id,x-admin-id,x-share-token,x-request-id,idempotency-key,last-event-id",
      );
      c.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,PATCH,OPTIONS");
      c.header("Access-Control-Expose-Headers", "X-Request-Id,Idempotency-Replayed,Retry-After");
      c.header("Access-Control-Max-Age", "600");
    }
    if (c.req.method === "OPTIONS") return c.body(null, 204);
    await next();
  });
}

// 对外 API（上游转发：X-User-Id + service-token）
const api = new Hono();
api.use("*", authMiddleware);
// 请求体上限（自保护，DESIGN §13）：默认 20MB
const BODY_LIMIT = Number(process.env.GATEWAY_BODY_LIMIT_MB ?? 20) * 1024 * 1024;
api.use("*", async (c, next) => {
  const len = Number(c.req.header("content-length") ?? 0);
  if (len > BODY_LIMIT)
    return c.json({ error: { code: "PAYLOAD_TOO_LARGE", message: `body exceeds ${BODY_LIMIT} bytes` } }, 413);
  await next();
});
api.route("/sessions", sessionsApp);
api.route("/", usageApp);
api.route("/", configResourcesApp);
api.route("/", agentConfigApp);
app.route("/api", api);

// 内部契约（同样需要 service-token；调用方是上游服务；分享令牌拒绝）
const internal = new Hono();
internal.use("*", authMiddleware);
internal.use("*", requireFullAuth);
internal.route("/", internalApp);
internal.route("/maintenance", maintenanceApp);
app.route("/internal", internal);

// 全局层管理（X-Admin-Token 专用）
const admin = new Hono();
admin.use("*", authMiddleware);
admin.use("*", requireAdmin);
admin.route("/", adminApp);
app.route("/admin", admin);

// 运维（内网，无凭据）
app.route("/", opsApp);

// TUI 终端桥（DESIGN §41.9）：浏览器 xterm ⇄ WS ⇄ PTY ⇄ omp 原生 TUI（测试用）
app.route("/terminal", terminalApp);

// 契约（DESIGN §17）：从根路由表内省生成的 OpenAPI 骨架
app.get("/openapi.json", (c) => c.json(buildOpenApi(app)));

/** 启动：缺 service-token 直接退出（防裸奔上内网）；任务定时器全部 unref。 */
async function main() {
  if (config.serviceTokens.length === 0) {
    console.error("[gateway] fatal: GATEWAY_SERVICE_TOKENS is not set (see .env.example)");
    process.exit(1);
  }
  await ensureGlobalScaffold();
  await ensureQmdMcpRegistered(); // KB_QMD_MCP=1 时把 qmd MCP 写进 global/mcp.json（幂等，失败仅告警）
  await ensureWrenDatasources(); // WREN_MCP=1 时 per 数据源自建 Wren 项目 + MCP daemon + 全局 skill（幂等，best-effort 不阻塞启动）
  await syncAll().catch((err) => console.error(`[gateway:wren] 启动 drift 检查失败（忽略，下个周期重试）: ${err}`)); // 启动即做一次 schema drift 检查：无变化零成本，有变化才增量 rebuild（§39.2.2）
  startWrenAutoSync(); // 无人值守周期同步（WREN_AUTO_SYNC_MIN，默认 1440 分钟；0=关闭）
  await refreshAllKbSkills(); // 存量 KB 的 SKILL.md/脚本按当前模板升级（一致不落盘，失败仅告警）
  startIdleCuller();
  startTrashPurger();
  startSnapshotPruner();
  const stopBackupJob = startBackupJob();

  const server = Bun.serve({
    port: config.port,
    fetch: app.fetch,
    // SSE 长静默（长工具执行期间无输出）不可被 idle 超时掐断；保活由 10s keep-alive 注释行负责
    idleTimeout: 255, // Bun 上限（秒）
    websocket: bunWebSocket, // TUI 终端桥（hono/bun 升级器经此分派 WS 帧）
  });
  console.log(`[gateway] omp gateway listening on http://127.0.0.1:${config.port} (data: ${config.dataRoot})`);

  /** 优雅关停（SIGINT/SIGTERM）：排空 live 会话后退出；postmortem 清理不阻断关停。 */
  let shuttingDown = false; // 防重入：连按 Ctrl+C 会并发跑两遍 drain（beginDispose/dispose 非幂等）
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const ctxs = [...registry.values()];
    console.log(`[gateway] ${signal} received: draining ${ctxs.length} live session(s)…`);
    stopIdleCuller();
    stopTrashPurger();
    stopSnapshotPruner();
    stopBackupJob();
    stopWrenAutoSync();
    for (const ctx of ctxs) ctx.session.beginDispose(); // 先封闸，防新工作进入
    await Promise.allSettled(ctxs.map((ctx) => disposeSession(ctx)));
    try {
      const { postmortem } = await import("@oh-my-pi/pi-utils");
      await postmortem.cleanup();
    } catch {
      // pi-utils 导出面差异不阻断关停
    }
    server.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main();
