/**
 * SDK 桥·历史面：会话条目（entry 寻址键）+ 标签、快照 CRUD 与 restore{fork|rollback}、
 * HTML 导出。DB 里的 session_file / file_path 为相对路径，使用前 fromStorePath 解析。
 */
import type { Hono } from "hono";
import type { SdkEnv, SdkShared } from "./shared.ts";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fromStorePath, toStorePath, userWorkspace } from "../../core/paths.ts";
import { createGatewaySession, disposeSession } from "../../core/session-factory.ts";
import { registry } from "../../core/session-registry.ts";
import {
  createSnapshot,
  deleteSnapshot,
  getSnapshotMeta,
  listSnapshotMetas,
  materializeRollbackFile,
} from "../../core/snapshot-service.ts";
import { audit, getSnapshot, insertSession, touchSession } from "../../core/tenant-store.ts";

/** 历史面：entries+标签、快照 CRUD/restore、export。 */
export function mountHistoryRoutes(app: Hono<SdkEnv>, shared: SdkShared): void {
  const { live, jsonError, ownedSession } = shared;

  // ---- 会话条目（entry id 是 fork{entryId}/branch 的寻址键；UI "从这里编辑" 依赖）----
  // 增强（DESIGN §25，对齐 docs/session-format）：类型过滤 ?type=、标签、分页
  app.get("/:sid/entries", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    const sm = (
      r.ctx.session as unknown as {
        sessionManager?: { getEntries?: () => Array<any>; getLabel?: (id: string) => string | undefined };
      }
    ).sessionManager;
    const entries = sm?.getEntries?.() ?? [];
    const typeFilter = (c.req.query("type") ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const allow = (t: string) => typeFilter.length === 0 || typeFilter.includes(t);
    const list = entries
      .filter((e: any) => e?.id && allow(String(e.type)))
      .map((e: any) => ({
        id: String(e.id),
        type: String(e.type),
        parentId: e.parentId ? String(e.parentId) : null,
        timestamp: e.timestamp ? String(e.timestamp) : null,
        role: e.message?.role ?? null,
        label: (() => {
          try {
            return sm?.getLabel?.(String(e.id)) ?? null;
          } catch {
            return null;
          }
        })(),
        preview:
          typeof e.message?.content?.[0]?.text === "string" ? String(e.message.content[0].text).slice(0, 120) : null,
      }));
    const offset = Math.max(Number(c.req.query("offset") ?? 0), 0);
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 1000), 1), 2000);
    return c.json({ total: list.length, entries: list.slice(offset, offset + limit), offset, limit });
  });

  // 条目标签（session-format 的 label entry）：网页书签/标重点；DELETE 移除
  app.put("/:sid/entries/:entryId/label", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    const body = await c.req.json().catch(() => null as any);
    const label = typeof body?.label === "string" ? body.label.trim() : "";
    if (!label) return jsonError(c, 400, "BAD_REQUEST", "body.label (non-empty string) required; use DELETE to remove");
    const sm = (
      r.ctx.session as unknown as {
        sessionManager?: {
          appendLabelChange?: (id: string, label: string | undefined) => string;
          getEntries?: () => Array<any>;
        };
      }
    ).sessionManager;
    if (typeof sm?.appendLabelChange !== "function") return jsonError(c, 409, "NOT_SUPPORTED", "labels unavailable");
    const exists = (sm.getEntries?.() ?? []).some((e: any) => e?.id === c.req.param("entryId"));
    if (!exists) return jsonError(c, 404, "NOT_FOUND", "entry not found");
    sm.appendLabelChange(c.req.param("entryId"), label);
    audit("session.entry.label", "session", r.row.id, c.get("userId"), { entryId: c.req.param("entryId"), label });
    return c.json({ ok: true, entryId: c.req.param("entryId"), label });
  });

  app.delete("/:sid/entries/:entryId/label", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    const sm = (
      r.ctx.session as unknown as {
        sessionManager?: {
          appendLabelChange?: (id: string, label: string | undefined) => string;
          getEntries?: () => Array<any>;
        };
      }
    ).sessionManager;
    if (typeof sm?.appendLabelChange !== "function") return jsonError(c, 409, "NOT_SUPPORTED", "labels unavailable");
    const exists = (sm.getEntries?.() ?? []).some((e: any) => e?.id === c.req.param("entryId"));
    if (!exists) return jsonError(c, 404, "NOT_FOUND", "entry not found");
    sm.appendLabelChange(c.req.param("entryId"), undefined);
    audit("session.entry.unlabel", "session", r.row.id, c.get("userId"), { entryId: c.req.param("entryId") });
    return c.json({ ok: true, entryId: c.req.param("entryId"), label: null });
  });

  // ---- 快照（M4，DESIGN §5）：CRUD + restore{fork|rollback} ----
  const snapErr = (c2: any, err: unknown) => {
    const code = (err as any)?.code;
    if (code === "SNAPSHOT_EMPTY") return jsonError(c2, 409, "SNAPSHOT_EMPTY", (err as Error).message);
    if (code === "SESSION_NOT_LIVE") return jsonError(c2, 409, "SESSION_NOT_LIVE", (err as Error).message);
    return jsonError(c2, 500, "SNAPSHOT_FAILED", err instanceof Error ? err.message : String(err));
  };

  app.get("/:sid/snapshots", (c) => {
    const row = ownedSession(c.req.param("sid"), c.get("userId"));
    if (!row) return jsonError(c, 404, "NOT_FOUND", "session not found");
    return c.json({ snapshots: listSnapshotMetas(row.id) });
  });

  app.post("/:sid/snapshots", async (c) => {
    const row = ownedSession(c.req.param("sid"), c.get("userId"));
    if (!row) return jsonError(c, 404, "NOT_FOUND", "session not found");
    const body = await c.req.json().catch(() => ({}) as any);
    const userId = c.get("userId");
    // 幂等：Idempotency-Key 24h 窗口内重放同快照响应
    const key = c.req.header("idempotency-key");
    if (key) {
      const { createHash } = await import("node:crypto");
      const keyHash = createHash("sha256").update(`${userId}:snapshot.create:${key}`).digest("hex");
      const { idempotencyGet } = await import("../../core/tenant-store.ts");
      const hit = idempotencyGet(keyHash);
      if (hit) {
        c.header("Idempotency-Replayed", "true");
        return c.json(JSON.parse(hit.response_json), hit.status_code as any);
      }
      try {
        const meta = await createSnapshot(userId, row.id, {
          kind: "manual",
          trigger: "manual",
          name: typeof body?.name === "string" ? body.name : undefined,
          note: typeof body?.note === "string" ? body.note : undefined,
          expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
        });
        const { idempotencyPut } = await import("../../core/tenant-store.ts");
        idempotencyPut(keyHash, 201, JSON.stringify(meta));
        audit("snapshot.create", "session", row.id, userId, { snapshotId: meta.id });
        return c.json(meta, 201);
      } catch (err) {
        return snapErr(c, err);
      }
    }
    try {
      const meta = await createSnapshot(userId, row.id, {
        kind: "manual",
        trigger: "manual",
        name: typeof body?.name === "string" ? body.name : undefined,
        note: typeof body?.note === "string" ? body.note : undefined,
        expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
      });
      audit("snapshot.create", "session", row.id, userId, { snapshotId: meta.id });
      return c.json(meta, 201);
    } catch (err) {
      return snapErr(c, err);
    }
  });

  app.get("/:sid/snapshots/:snapId", (c) => {
    const row = ownedSession(c.req.param("sid"), c.get("userId"));
    if (!row) return jsonError(c, 404, "NOT_FOUND", "session not found");
    const meta = getSnapshotMeta(row.id, c.req.param("snapId"));
    return meta ? c.json(meta) : jsonError(c, 404, "NOT_FOUND", "snapshot not found");
  });

  app.delete("/:sid/snapshots/:snapId", async (c) => {
    const row = ownedSession(c.req.param("sid"), c.get("userId"));
    if (!row) return jsonError(c, 404, "NOT_FOUND", "session not found");
    const ok = await deleteSnapshot(row.id, c.req.param("snapId"));
    return ok ? c.json({ ok: true }) : jsonError(c, 404, "NOT_FOUND", "snapshot not found");
  });

  // restore：fork（默认，安全）= forkFrom(快照文件)+workspace 拷贝 → 新 sid；rollback（破坏性，仅 idle）
  app.post("/:sid/snapshots/:snapId/restore", async (c) => {
    const row = ownedSession(c.req.param("sid"), c.get("userId"));
    if (!row) return jsonError(c, 404, "NOT_FOUND", "session not found");
    const body = await c.req.json().catch(() => ({}) as any);
    const mode = body?.mode === "rollback" ? "rollback" : "fork";
    const snap = getSnapshot(row.id, c.req.param("snapId"));
    if (!snap) return jsonError(c, 404, "NOT_FOUND", "snapshot not found");
    const userId = c.get("userId");
    const sourceWorkspace = userWorkspace(row.user_id, row.workspace_id);

    if (mode === "fork") {
      const newSid = crypto.randomUUID();
      const { ctx, session } = await createGatewaySession({
        userId,
        sid: newSid,
        forkFrom: fromStorePath(snap.file_path),
        copyWorkspaceFrom: sourceWorkspace,
      });
      registry.register(ctx);
      insertSession({
        id: newSid,
        user_id: userId,
        workspace_id: newSid,
        parent_id: row.id,
        title: body?.title ? String(body.title) : row.title ? `${row.title} (restored)` : "restored",
        session_file: session.sessionFile ? toStorePath(session.sessionFile) : null,
        model_provider: row.model_provider,
        model_id: row.model_id,
      });
      audit("snapshot.restore_fork", "snapshot", snap.id, userId, { newSessionId: newSid });
      return c.json({ mode, id: newSid, parentId: row.id, workspaceId: newSid }, 201);
    }

    // rollback：仅 idle；先自动打 pre_restore 快照（可反悔），再换文件同 sid 重建
    if (row.status !== "active") return jsonError(c, 409, "SESSION_ARCHIVED", "rollback requires an active session");
    const existing = registry.get(row.id);
    if (existing?.streaming) return jsonError(c, 409, "SESSION_STREAMING", "rollback requires idle session");
    let preRestoreId: string | undefined;
    try {
      const pre = await createSnapshot(userId, row.id, { kind: "auto", trigger: "pre_restore", turn: null });
      preRestoreId = pre.id;
    } catch {
      // 空/无文件会话：无需反悔快照
    }
    // 释放 live 进程态
    if (existing) await disposeSession(existing);
    let newFile: string;
    try {
      newFile = await materializeRollbackFile(userId, row.id, snap);
    } catch (err) {
      return snapErr(c, err);
    }
    const { ctx: newCtx, session } = await createGatewaySession({ userId, sid: row.id, resumeSessionFile: newFile });
    registry.register(newCtx);
    touchSession(row.id, { session_file: toStorePath(session.sessionFile ?? newFile) });
    audit("snapshot.restore_rollback", "snapshot", snap.id, userId, { preRestoreSnapshotId: preRestoreId });
    return c.json({
      mode,
      restoredFrom: snap.id,
      preRestoreSnapshotId: preRestoreId ?? null,
      sessionFile: session.sessionFile ?? newFile,
    });
  });

  // ---- 导出 / 文本转写 / fresh ----
  app.post("/:sid/export", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    const stem = (r.row.session_file ? path.basename(r.row.session_file).replace(/\.jsonl$/i, "") : r.row.id).slice(
      0,
      60,
    );
    const exportsDir = path.join(r.ctx.workspaceDir, "exports");
    await fs.mkdir(exportsDir, { recursive: true });
    const outPath = path.join(exportsDir, `omp-session-${stem}.html`);
    const written = await (r.ctx.session as unknown as { exportToHtml: (p?: string) => Promise<string> }).exportToHtml(
      outPath,
    );
    const size = (await fs.stat(written)).size;
    audit("session.export", "session", r.row.id, c.get("userId"), { bytes: size });
    return c.json({ path: path.relative(r.ctx.workspaceDir, written).replace(/\\/g, "/"), bytes: size });
  });
}
