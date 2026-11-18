/**
 * 会话 JSONL 校验/导入/下载（DESIGN §25）：逐行结构校验（对齐 omp 检查清单），
 * 缺 model_change 时自动补一条（否则 revive 必失败），下载带 NDJSON 头。
 */
import type { Hono } from "hono";
import * as fs from "node:fs/promises";
import path from "node:path";
import { audit, getSession, insertSession } from "../core/tenant-store.ts";
import { userSessionsDir, userWorkspace, toStorePath, fromStorePath } from "../core/paths.ts";

type Env = { Variables: { userId: string } };

export interface ImportDeps {
  jsonError: (c: any, status: any, code: string, message: string, details?: unknown) => any;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

const SID_SAFE_RE = /^[A-Za-z0-9_-]{8,128}$/;

interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  header?: { id: string; version: number; timestamp?: string; cwd?: string; title?: string };
  titleRecord?: { title?: string; source?: string };
  entries: any[];
  lastModel?: { provider: string; modelId: string };
}

/**
 * 会话文件校验（DESIGN §25，对齐 omp docs/session-format 的导入检查清单）：
 * 逐行 JSON → 可选 title 记录 → header(session) → entries（type/id/timestamp/parentId）
 * → id 唯一 → parent 解析 → 无环 → 引用（firstKeptEntryId/targetId/toolCallId）可解析。
 */
export function validateSessionJsonl(text: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { ok: false, errors: ["empty file"], warnings, entries: [] };

  const objs: any[] = [];
  for (let i = 0; i < lines.length; i++) {
    let o: any;
    try {
      o = JSON.parse(lines[i]);
    } catch {
      errors.push(`line ${i + 1}: invalid JSON`);
      continue;
    }
    if (typeof o !== "object" || o === null || Array.isArray(o)) {
      errors.push(`line ${i + 1}: not a JSON object`);
      continue;
    }
    objs.push(o);
  }
  if (errors.length) return { ok: false, errors, warnings, entries: [] };

  let titleRecord: ValidationResult["titleRecord"] | undefined;
  if (objs[0]?.type === "title" && objs[0]?.v === 1) {
    titleRecord = { title: objs[0].title, source: objs[0].source };
    objs.shift();
  }
  const header = objs[0];
  if (header?.type !== "session") {
    errors.push("first logical record must be type=session");
  } else {
    if (typeof header.id !== "string" || !header.id) errors.push("header.id must be a non-empty string");
    else if (!SID_SAFE_RE.test(header.id)) errors.push("header.id contains unsafe characters (allowed: A-Za-z0-9_-)");
    const v = header.version ?? 1;
    if (typeof v !== "number" || v < 1 || v > 3) errors.push(`unsupported session version: ${String(v)}`);
    if (header.type === "session" && typeof header.cwd !== "string") warnings.push("header.cwd missing");
  }

  const entries = objs.slice(1);
  const ids = new Set<string>();
  for (const e of entries) {
    if (typeof e.type !== "string" || !e.type) errors.push(`entry missing type`);
    if (typeof e.id !== "string" || !e.id) errors.push(`entry missing id`);
    else if (ids.has(e.id)) errors.push(`duplicate entry id: ${e.id}`);
    else ids.add(e.id);
    if (typeof e.timestamp !== "string") warnings.push(`entry ${String(e.id)}: missing timestamp`);
    if (e.parentId !== null && e.parentId !== undefined && typeof e.parentId !== "string") {
      errors.push(`entry ${String(e.id)}: invalid parentId`);
    }
  }

  if (errors.length === 0) {
    const map = new Map<string, any>(entries.map((e) => [e.id, e]));
    for (const e of entries) {
      if (e.parentId && !ids.has(e.parentId)) errors.push(`entry ${e.id}: parent ${e.parentId} not found`);
    }
    for (const e of entries) {
      if (errors.length > 20) break;
      const seen = new Set<string>();
      let cur = e;
      while (cur?.parentId) {
        if (seen.has(cur.parentId)) {
          errors.push(`cycle detected at entry ${e.id}`);
          break;
        }
        seen.add(cur.parentId);
        cur = map.get(cur.parentId);
        if (!cur) break;
      }
    }
    const toolCallIds = new Set<string>();
    for (const e of entries) {
      if (e.type === "message" && Array.isArray(e.message?.content)) {
        for (const b of e.message.content) if (b?.type === "toolCall" && b.id) toolCallIds.add(String(b.id));
      }
    }
    for (const e of entries) {
      if (e.type === "compaction" && e.firstKeptEntryId && !ids.has(e.firstKeptEntryId)) {
        errors.push(`compaction ${e.id}: firstKeptEntryId ${e.firstKeptEntryId} not found`);
      }
      if (e.type === "label" && e.targetId && !ids.has(e.targetId)) {
        errors.push(`label ${e.id}: targetId ${e.targetId} not found`);
      }
      if (e.type === "message" && e.message?.role === "toolResult" && e.message.toolCallId && toolCallIds.size > 0) {
        if (!toolCallIds.has(String(e.message.toolCallId))) warnings.push(`toolResult ${e.id}: dangling toolCallId`);
      }
    }
  }

  // 最后一条 model_change 作为初始模型
  let lastModel: { provider: string; modelId: string } | undefined;
  for (const e of entries) {
    if (e.type === "model_change" && typeof e.model === "string" && e.model.includes("/")) {
      // JS 的 split("/", 2) 会丢弃分隔符后的剩余段（"a/b/c" 丢 "c"）——只按首个 / 切
      const slash = e.model.indexOf("/");
      const provider = e.model.slice(0, slash);
      const modelId = e.model.slice(slash + 1);
      if (provider && modelId) lastModel = { provider, modelId };
    }
  }

  return {
    ok: errors.length === 0,
    errors: errors.slice(0, 50),
    warnings: warnings.slice(0, 50),
    header: header
      ? {
          id: String(header.id ?? ""),
          version: Number(header.version ?? 1),
          timestamp: header.timestamp,
          cwd: header.cwd,
          title: header.title,
        }
      : undefined,
    titleRecord,
    entries,
    lastModel,
  };
}

/**
 * 会话导入/导出（DESIGN §25）：
 * - POST /api/sessions/validate —— dry-run 校验（不落库）
 * - POST /api/sessions/import   —— 上传 JSONL 导入为会话（校验→写文件→建 workspace→DB 行）
 * - GET  /api/sessions/:sid/session-file —— 下载原始 JSONL（备份/迁移）
 */
export function mountSessionImport(app: Hono<Env>, deps: ImportDeps): void {
  const { jsonError } = deps;

  app.post("/validate", async (c) => {
    const text = await c.req.text();
    if (!text) return jsonError(c, 400, "BAD_REQUEST", "body must be session JSONL text");
    if (text.length > 20 * 1024 * 1024) return jsonError(c, 413, "PAYLOAD_TOO_LARGE", "session file exceeds 20MB");
    const v = validateSessionJsonl(text);
    return c.json({
      valid: v.ok,
      errors: v.errors,
      warnings: v.warnings,
      stats: { entries: v.entries.length, version: v.header?.version ?? null, sessionId: v.header?.id ?? null },
    });
  });

  app.post("/import", async (c) => {
    const userId = c.get("userId");
    const text = await c.req.text();
    if (!text) return jsonError(c, 400, "BAD_REQUEST", "body must be session JSONL text");
    if (text.length > 20 * 1024 * 1024) return jsonError(c, 413, "PAYLOAD_TOO_LARGE", "session file exceeds 20MB");
    const v = validateSessionJsonl(text);
    if (!v.ok || !v.header?.id || !v.header) {
      return jsonError(c, 400, "INVALID_SESSION_FILE", "session file failed validation", {
        errors: v.errors,
        warnings: v.warnings,
      });
    }
    const sid = v.header.id;
    if (getSession(sid)) {
      return jsonError(c, 409, "ALREADY_EXISTS", `session ${sid} already exists (import is not an overwrite)`);
    }
    // 模型自洽（DESIGN §25）：文件无 model_change 时补一条（用户首个可用模型），
    // 否则 SDK 恢复模型会失败（Could not restore model），导入的会话无法 revive。
    let text2 = text;
    let injectedModel: { provider: string; modelId: string } | null = null;
    if (!v.lastModel) {
      try {
        const { getUserContext } = await import("../core/user-context.ts");
        const uctx = await getUserContext(userId);
        const first = uctx.modelRegistry.getAvailable()[0] as unknown as { provider?: string; id?: string } | undefined;
        if (first?.provider && first?.id) {
          injectedModel = { provider: first.provider, modelId: first.id };
          const lastEntry = v.entries.at(-1);
          const id = `mchg${Date.now().toString(36)}`.slice(0, 8);
          const rec = {
            type: "model_change",
            id,
            parentId: lastEntry?.id ?? null,
            timestamp: new Date().toISOString(),
            model: `${injectedModel.provider}/${injectedModel.modelId}`,
          };
          text2 = `${text.replace(/\n$/, "")}\n${JSON.stringify(rec)}\n`;
        }
      } catch {}
    }
    // 写入用户会话目录（omp 命名约定：<fs-safe-timestamp>_<session-id>.jsonl）
    const dir = userSessionsDir(userId);
    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `${stamp}_${sid}.jsonl`);
    await fs.writeFile(file, text2.endsWith("\n") ? text2 : `${text2}\n`, "utf8");
    // workspace（会话:workspace=1:1）
    await fs.mkdir(userWorkspace(userId, sid), { recursive: true });
    const title = v.titleRecord?.title ?? v.header.title ?? "";
    insertSession({
      id: sid,
      user_id: userId,
      workspace_id: sid,
      title,
      session_file: toStorePath(file),
      model_provider: (v.lastModel ?? injectedModel)?.provider ?? null,
      model_id: (v.lastModel ?? injectedModel)?.modelId ?? null,
    });
    audit("session.import", "session", sid, userId, { entries: v.entries.length, bytes: text.length });
    return c.json(
      {
        id: sid,
        sessionFile: file,
        entries: v.entries.length + (injectedModel ? 1 : 0),
        title,
        ...(injectedModel ? { injectedModel } : {}),
        warnings: v.warnings,
        // 导入的会话可经任意 /api/sessions/:sid/* 端点使用（按 sessionFile 复活）
        next: `/api/sessions/${sid}/bootstrap`,
      },
      201,
    );
  });

  app.get("/:sid/session-file", async (c) => {
    const row = getSession(c.req.param("sid"));
    if (!row || row.user_id !== c.get("userId")) return jsonError(c, 404, "NOT_FOUND", "session not found");
    const stored = (row as unknown as { session_file?: string | null }).session_file;
    if (!stored) return jsonError(c, 409, "NOT_FOUND", "session has no file yet (no turn recorded)");
    const file = fromStorePath(stored);
    const st = await fs.stat(file).catch(() => null);
    if (!st?.isFile()) return jsonError(c, 404, "NOT_FOUND", "session file missing");
    if (st.size > 20 * 1024 * 1024) return jsonError(c, 413, "PAYLOAD_TOO_LARGE", "session file exceeds 20MB");
    const text = await fs.readFile(file, "utf8");
    return c.body(text, 200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename="${path.basename(file)}"`,
      "x-omp-session-id": row.id,
      "x-omp-session-version": String(st.size),
    });
  });
}
