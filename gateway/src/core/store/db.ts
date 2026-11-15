import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { config } from "../../config.ts";
import { toStorePath } from "../paths.ts";

/**
 * SQLite 连接与 schema（DESIGN §31 / §32）。
 *
 * - 进程内单连接（单线程同步语句天然串行，无锁竞争）；busy_timeout 防外部读者短暂持锁。
 * - `db` 用 let 导出：import 导入新库后 `reopenDb()` 换绑（ESM live binding，各 store 模块自动可见），
 *   因此 **store 模块不得持有模块级 prepared statement**（sessions.ts 已内联）。
 * - `PRAGMA user_version` 记录 schema 版本；boot 时向前检查（新库文件 → 拒绝启动），
 *   0→1 迁移把历史绝对路径归一化为相对路径（INV-1）。
 */

export const SCHEMA_VERSION = 1;

function openDb(): Database {
  // 模块加载即开库：确保数据根目录先存在（修复首启 SQLITE_CANTOPEN）
  mkdirSync(config.dataRoot, { recursive: true });
  const d = new Database(path.join(config.dataRoot, "gateway.db"), { create: true });
  d.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  return d;
}

export let db: Database = openDb();

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tenants (
  user_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','deleted')),
  limits_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  path TEXT NOT NULL,
  ref_count INTEGER NOT NULL DEFAULT 0,
  pending_delete INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  parent_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','deleted')),
  session_file TEXT,
  model_provider TEXT,
  model_id TEXT,
  entry_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  archived_at TEXT,
  deleted_at TEXT,
  last_live_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, status);

CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('auto','manual')),
  trigger TEXT NOT NULL,
  name TEXT,
  note TEXT,
  entry_count INTEGER NOT NULL,
  turn INTEGER,
  model_provider TEXT,
  model_id TEXT,
  file_path TEXT,
  materialized INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actor TEXT NOT NULL,
  on_behalf_of TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  detail_json TEXT
);

CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn INTEGER,
  model_provider TEXT,
  model_id TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  ttft_ms INTEGER,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_usage_user_at ON usage(user_id, at);
CREATE INDEX IF NOT EXISTS idx_usage_session ON usage(session_id);

CREATE TABLE IF NOT EXISTS idempotency (
  key_hash TEXT PRIMARY KEY,
  status_code INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 集成端钩子（DESIGN §23）：在 agent 生命周期节点回调集成端 URL。
-- mode=notify 异步通知；mode=decide 同步等决策（tool_call 可 block/改参）。
CREATE TABLE IF NOT EXISTS integration_hooks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT,
  event TEXT NOT NULL,
  matcher_json TEXT,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'notify',
  timeout_ms INTEGER NOT NULL DEFAULT 3000,
  on_timeout TEXT NOT NULL DEFAULT 'allow',
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_integration_hooks_match ON integration_hooks(user_id, session_id, event) WHERE disabled = 0;

-- 集成端 HTTP 工具（DESIGN §24）：业务系统把自己的函数暴露给 agent（SDK customTools 的 HTTP 形态）。
-- session_id NULL=用户级（该用户所有会话）；非空=仅绑定会话（同名覆盖用户级）。
CREATE TABLE IF NOT EXISTS http_tools (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT,
  name TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT NOT NULL,
  parameters_json TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  timeout_ms INTEGER NOT NULL DEFAULT 30000,
  approval TEXT,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_http_tools_name ON http_tools(user_id, name) WHERE disabled = 0 AND session_id IS NULL;

CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  access TEXT NOT NULL CHECK (access IN ('view','control')),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_shares_session ON shares(session_id);

CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events_json TEXT NOT NULL DEFAULT '["*"]',
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

/** 列补齐迁移（旧库升级；新库 CREATE 已包含，报错吞掉即可）。 */
function runColumnMigrations(d: Database): void {
  // 会话级回调（DESIGN §22）：webhooks.session_id
  try {
    d.exec("ALTER TABLE webhooks ADD COLUMN session_id TEXT");
  } catch {
    // 列已存在
  }
  // 会话级 HTTP 工具（DESIGN §24）：http_tools.session_id
  try {
    d.exec("ALTER TABLE http_tools ADD COLUMN session_id TEXT");
  } catch {
    // 列已存在
  }
}

/** 0→1 迁移：历史绝对路径（session_file / snapshots.file_path）归一化为相对路径。 */
function normalizeLegacyAbsolutePaths(d: Database): void {
  const norm = (p: string): string | null => {
    if (!path.isAbsolute(p)) return null; // 已是相对，无需处理
    try {
      return toStorePath(p);
    } catch {
      return null; // dataRoot 之外的历史遗留：保持原样（运行时 fromStorePath 原样透传）
    }
  };
  const sessions = d.query("SELECT id, session_file FROM sessions WHERE session_file IS NOT NULL").all() as Array<{
    id: string;
    session_file: string;
  }>;
  for (const r of sessions) {
    const n = norm(r.session_file);
    if (n) d.run("UPDATE sessions SET session_file = ? WHERE id = ?", [n, r.id]);
  }
  const snaps = d.query("SELECT id, file_path FROM snapshots WHERE file_path IS NOT NULL").all() as Array<{
    id: string;
    file_path: string;
  }>;
  for (const r of snaps) {
    const n = norm(r.file_path);
    if (n) d.run("UPDATE snapshots SET file_path = ? WHERE id = ?", [n, r.id]);
  }
}

function assertSchemaVersion(d: Database): void {
  const uv = (d.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (uv > SCHEMA_VERSION) {
    throw new Error(
      `SCHEMA_VERSION_MISMATCH: gateway.db user_version=${uv} is newer than supported ${SCHEMA_VERSION}; upgrade the gateway or use a matching bundle`,
    );
  }
}

// ---- boot：建表 / 迁移 / 版本落位 ----
db.exec(SCHEMA_SQL);
runColumnMigrations(db);
const bootVersion = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
if (bootVersion < 1) normalizeLegacyAbsolutePaths(db);
if (bootVersion !== SCHEMA_VERSION) db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
assertSchemaVersion(db);

/**
 * 数据迁移导入后重开连接（gateway.db 文件已被整体替换）。
 * 仅在 drain + 无活跃会话时调用（maintenance/import）。
 */
export function reopenDb(): void {
  try {
    db.close();
  } catch {
    // 已关闭（maintenance/import 换文件前主动 close）——容忍
  }
  db = openDb();
  db.exec(SCHEMA_SQL);
  runColumnMigrations(db);
  const uv = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (uv < 1) normalizeLegacyAbsolutePaths(db);
  if (uv !== SCHEMA_VERSION) db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  assertSchemaVersion(db);
}

/** 主动关闭连接（maintenance/import 换文件前调用；Windows 上必须先关才能 rename）。 */
export function closeDb(): void {
  try {
    db.close();
  } catch {
    // 已关闭
  }
}

/** 迁移 manifest 对账用的一致计数（§32）。 */
export function collectCounts(): Record<string, number> {
  const one = (sql: string): number => (db.query(sql).get() as { n: number }).n;
  return {
    users: one("SELECT COUNT(*) AS n FROM tenants"),
    sessions: one("SELECT COUNT(*) AS n FROM sessions"),
    snapshots: one("SELECT COUNT(*) AS n FROM snapshots"),
    integrationHooks: one("SELECT COUNT(*) AS n FROM integration_hooks"),
    webhooks: one("SELECT COUNT(*) AS n FROM webhooks"),
    httpTools: one("SELECT COUNT(*) AS n FROM http_tools"),
  };
}

/** 一致性快照（M10）：VACUUM INTO 到目标路径（备份作业 / §32 导出用）。 */
export async function backupToFile(dest: string): Promise<void> {
  db.run(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
}

export function strftimeNow(): string {
  return new Date().toISOString();
}
