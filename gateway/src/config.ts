/**
 * 网关配置（DESIGN §7）：全部来自环境变量，模块加载时一次解析（.env.example 有全量说明）。
 * 调优只动环境变量，不改代码；限额类默认值见各项注释。
 */
import path from "node:path";

export interface GatewayConfig {
  port: number;
  /** 数据根目录（绝对路径）：global/ + users/<uid>/ + gateway.db */
  dataRoot: string;
  /** 生效的服务 token（逗号分隔，支持双 token 轮换窗口） */
  serviceTokens: string[];
  /** 会话空闲回收 TTL（无订阅者且 idle） */
  sessionIdleTtlMs: number;
  /** 每用户最大活跃会话数（懒 provision 时的默认限额） */
  defaultMaxSessions: number;
  /** 每用户最大并发 streaming 会话数 */
  defaultMaxConcurrent: number;
  /** 全局并发 streaming 上限（自保护，超限排队） */
  maxGlobalStreaming: number;
  /** 流式排队超时（超时返回 429 供上游退避重试） */
  streamQueueTimeoutMs: number;
  /** 流式槽位最大持有时长（防泄漏 backstop） */
  streamMaxHoldMs: number;
  /** sqlite 备份目录（M10：设置即启用定时 VACUUM INTO 快照；null=关闭） */
  backupDir: string | null;
  /** 备份间隔（分钟） */
  backupIntervalMin: number;
  /** OTEL 开关（M10：SDK telemetry:{}，无 OTEL SDK 注册时为 no-op tracer） */
  otel: boolean;
  /** webhook 目标 host 白名单（M10：逗号分隔；空=不限制——内网部署默认放行） */
  webhookHostAllowlist: string[];
  /** 浏览器直连 CORS 白名单（空=关闭；支持 "*"）。默认架构经 Python BFF，无需开启 */
  corsOrigins: string[];
  /** 迁移 bundle 导出目录（§32）；默认 dataRoot 同级的 gateway-exports */
  exportDir: string;
  /** 迁移 bundle 导入允许读取的根（逗号分隔；默认含 exportDir） */
  importDirs: string[];
}

function loadConfig(): GatewayConfig {
  const dataRoot = path.resolve(process.env.GATEWAY_DATA_ROOT ?? path.join(import.meta.dir, "..", "..", "data"));
  const tokens = (process.env.GATEWAY_SERVICE_TOKENS ?? process.env.GATEWAY_SERVICE_TOKEN ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const exportDir = path.resolve(
    process.env.GATEWAY_EXPORT_DIR ?? path.join(path.dirname(dataRoot), "gateway-exports"),
  );
  const importDirs = [
    ...new Set([
      exportDir,
      ...(process.env.GATEWAY_IMPORT_DIRS ?? "")
        .split(",")
        .map((s) => path.resolve(s.trim()))
        .filter(Boolean),
    ]),
  ];

  return {
    port: Number(process.env.GATEWAY_PORT ?? 8787),
    dataRoot,
    serviceTokens: tokens,
    sessionIdleTtlMs: Number(process.env.GATEWAY_SESSION_IDLE_TTL_MS ?? 30 * 60_000),
    defaultMaxSessions: Number(process.env.GATEWAY_DEFAULT_MAX_SESSIONS ?? 50),
    // 每用户可同时跑 10 个会话（产品要求，2026-11）
    defaultMaxConcurrent: Number(process.env.GATEWAY_DEFAULT_MAX_CONCURRENT ?? 10),
    maxGlobalStreaming: Number(process.env.GATEWAY_MAX_GLOBAL_STREAMING ?? 50),
    streamQueueTimeoutMs: Number(process.env.GATEWAY_STREAM_QUEUE_TIMEOUT_MS ?? 60_000),
    streamMaxHoldMs: Number(process.env.GATEWAY_STREAM_MAX_HOLD_MS ?? 600_000),
    backupDir: process.env.GATEWAY_BACKUP_DIR ? path.resolve(process.env.GATEWAY_BACKUP_DIR) : null,
    backupIntervalMin: Number(process.env.GATEWAY_BACKUP_INTERVAL_MIN ?? 60),
    otel: process.env.GATEWAY_OTEL === "1" || process.env.GATEWAY_OTEL === "true",
    webhookHostAllowlist: (process.env.GATEWAY_WEBHOOK_HOSTS_ALLOWLIST ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    corsOrigins: (process.env.GATEWAY_CORS_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    exportDir,
    importDirs,
  };
}

export const config = loadConfig();
