// 集成端 HTTP 工具（tenant-store 拆分，DESIGN §31）
import { db } from "./db.ts";

// ---- 集成端 HTTP 工具（DESIGN §24）----

export interface HttpToolRow {
  id: string;
  user_id: string;
  /** NULL=用户级（该用户所有会话）；非空=仅绑定会话 */
  session_id?: string | null;
  name: string;
  label: string;
  description: string;
  parameters_json: string;
  url: string;
  secret: string;
  timeout_ms: number;
  approval: string | null;
  disabled: number;
  created_at: string;
}

/** 注册/更新 HTTP 工具（按 id 幂等；secret 为 whsec_ 密钥）。 */
export function upsertHttpTool(row: {
  id: string;
  user_id: string;
  session_id?: string | null;
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  url: string;
  secret: string;
  timeout_ms?: number;
  approval?: string | null;
}): void {
  db.run(
    `INSERT INTO http_tools (id, user_id, session_id, name, label, description, parameters_json, url, secret, timeout_ms, approval)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET label=excluded.label, description=excluded.description,
       parameters_json=excluded.parameters_json, url=excluded.url, secret=excluded.secret,
       timeout_ms=excluded.timeout_ms, approval=excluded.approval, disabled=0`,
    [
      row.id,
      row.user_id,
      row.session_id ?? null,
      row.name,
      row.label,
      row.description,
      JSON.stringify(row.parameters),
      row.url,
      row.secret,
      row.timeout_ms ?? 30_000,
      row.approval ?? null,
    ],
  );
}

/** 严格作用域查找（注册/更新用：会话级不会回落到用户级，避免 id 复用）。 */
export function findHttpToolScoped(userId: string, name: string, sessionId: string | null): HttpToolRow | undefined {
  return (
    sessionId
      ? db
          .query("SELECT * FROM http_tools WHERE user_id = ? AND name = ? AND session_id = ? AND disabled = 0")
          .get(userId, name, sessionId)
      : db
          .query("SELECT * FROM http_tools WHERE user_id = ? AND name = ? AND session_id IS NULL AND disabled = 0")
          .get(userId, name)
  ) as HttpToolRow | undefined;
}

/** 工具列表（secret 脱敏；opts.sessionId 过滤会话级）。 */
export function listHttpTools(
  userId: string,
  withSecret = false,
  opts?: { sessionId?: string },
): Array<Record<string, unknown>> {
  const rows = (
    opts?.sessionId
      ? db
          .query("SELECT * FROM http_tools WHERE user_id = ? AND session_id = ? AND disabled = 0 ORDER BY name")
          .all(userId, opts.sessionId)
      : db.query("SELECT * FROM http_tools WHERE user_id = ? AND disabled = 0 ORDER BY name").all(userId)
  ) as HttpToolRow[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    sessionId: r.session_id ?? null,
    label: r.label,
    description: r.description,
    parameters: JSON.parse(r.parameters_json),
    url: r.url,
    timeoutMs: r.timeout_ms,
    approval: r.approval,
    createdAt: r.created_at,
    ...(withSecret ? { secret: r.secret } : {}),
  }));
}

/** 会话构造用（含 secret）：用户级 + 该会话级，同名会话级优先。 */
export function httpToolRowsForSession(userId: string, sessionId?: string | null): HttpToolRow[] {
  const rows = db
    .query(
      "SELECT * FROM http_tools WHERE user_id = ? AND disabled = 0 AND (session_id IS NULL OR session_id = ?) ORDER BY name",
    )
    .all(userId, sessionId ?? "") as HttpToolRow[];
  const byName = new Map<string, HttpToolRow>();
  for (const r of rows) {
    const prev = byName.get(r.name);
    // 会话级覆盖用户级
    if (!prev || (prev.session_id === null && r.session_id !== null)) byName.set(r.name, r);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 删除工具（软删 disabled=1，保留审计痕迹）。
 * 传 sessionId 只删会话级同名；不传只删用户级——不跨作用域级联。
 */
export function deleteHttpTool(userId: string, name: string, sessionId?: string | null): boolean {
  if (sessionId) {
    return (
      db.run("UPDATE http_tools SET disabled = 1 WHERE user_id = ? AND name = ? AND session_id = ? AND disabled = 0", [
        userId,
        name,
        sessionId,
      ]).changes > 0
    );
  }
  return (
    db.run(
      "UPDATE http_tools SET disabled = 1 WHERE user_id = ? AND name = ? AND session_id IS NULL AND disabled = 0",
      [userId, name],
    ).changes > 0
  );
}
