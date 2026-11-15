/**
 * SDK 桥·会话派生：fork（无 entryId 走血缘分叉；有 entryId 走 SDK 原地分支后换绑）、
 * branch（编辑点分支）、fresh。fork 降级语义：零 turn 会话无 JSONL，新建并保留血缘。
 */
import type { Hono } from "hono";
import type { SdkEnv, SdkShared } from "./shared.ts";
import { fromStorePath, toStorePath, userWorkspace } from "../../core/paths.ts";
import { createGatewaySession } from "../../core/session-factory.ts";
import { registry, SessionCtx } from "../../core/session-registry.ts";
import { audit, insertSession } from "../../core/tenant-store.ts";

/** 会话派生：fork（血缘分叉/条目分叉）、branch（编辑点分支）、fresh。 */
export function mountLifecycleRoutes(app: Hono<SdkEnv>, shared: SdkShared): void {
  const { live, jsonError, ownedSession } = shared;

  // ---- fork：无 entryId → forkFrom（源不动）；有 entryId → SDK 原地分支后换绑到新 sid ----
  app.post("/:sid/fork", async (c) => {
    const row = ownedSession(c.req.param("sid"), c.get("userId"));
    if (!row) return jsonError(c, 404, "NOT_FOUND", "session not found");
    if (!row.session_file) return jsonError(c, 409, "SESSION_NOT_LIVE", "source session has no file");
    const body = await c.req.json().catch(() => ({}) as any);
    const userId = c.get("userId");
    const newSid = crypto.randomUUID();
    const sourceWorkspace = userWorkspace(row.user_id, row.workspace_id);

    // entryId 分叉：SDK 在原会话上切到新文件（含工具批切齐/血缘头），网关把 live 换绑到新 sid
    if (body?.entryId != null) {
      const r0 = await live(c);
      if ("error" in r0) return r0.error;
      if (r0.ctx.streaming) return jsonError(c, 409, "SESSION_STREAMING", "fork requires idle session");
      const s = r0.ctx.session as unknown as {
        fork: (e?: string, o?: { requireIdle?: boolean }) => Promise<boolean>;
        sessionFile?: string;
      };
      let ok = false;
      try {
        ok = await s.fork(String(body.entryId), { requireIdle: true });
      } catch (err) {
        return jsonError(c, 409, "FORK_FAILED", err instanceof Error ? err.message : String(err));
      }
      if (!ok) return jsonError(c, 409, "FORK_REJECTED", "fork was rejected (hook cancelled or session not persisted)");
      const newFile = s.sessionFile ?? null;
      // live 上下文迁到新 sid；旧 sid 保留原文件可随时复活
      registry.unregister(row.id);
      r0.ctx.detachForRebind(newSid, "fork");
      const newCtx = new SessionCtx(newSid, userId, sourceWorkspace, r0.ctx.session);
      newCtx.unsubscribeEvent = r0.ctx.session.subscribe((evt) => newCtx.dispatchOmp(evt));
      registry.register(newCtx);
      insertSession({
        id: newSid,
        user_id: userId,
        workspace_id: newSid,
        parent_id: row.id,
        title: typeof body?.title === "string" ? body.title : row.title ? `${row.title} (fork)` : "fork",
        session_file: newFile ? toStorePath(newFile) : null,
        model_provider: row.model_provider,
        model_id: row.model_id,
      });
      audit("session.fork_entry", "session", row.id, userId, { newSessionId: newSid, entryId: String(body.entryId) });
      return c.json({ id: newSid, parentId: row.id, workspaceId: newSid }, 201);
    }

    // 从未产生 turn 的会话没有 JSONL 文件——fork 降级为"新建 + 保留血缘"
    const sourceFile = row.session_file ? fromStorePath(row.session_file) : "";
    const sourceExists = sourceFile ? await Bun.file(sourceFile).exists() : false;
    try {
      const { ctx, session } = await createGatewaySession({
        userId,
        sid: newSid,
        ...(sourceExists ? { forkFrom: sourceFile } : {}),
        // 1:1 原则：分叉会话获得自己的 workspace = 源 workspace 的完整拷贝（代码快照）
        copyWorkspaceFrom: sourceWorkspace,
      });
      registry.register(ctx);
      insertSession({
        id: newSid,
        user_id: userId,
        workspace_id: newSid,
        parent_id: row.id,
        title: typeof body?.title === "string" ? body.title : row.title ? `${row.title} (fork)` : "fork",
        session_file: session.sessionFile ?? null,
        model_provider: row.model_provider,
        model_id: row.model_id,
      });
      audit("session.fork", "session", row.id, userId, { newSessionId: newSid });
      return c.json({ id: newSid, parentId: row.id, workspaceId: newSid }, 201);
    } catch (err) {
      return jsonError(c, 500, "FORK_FAILED", err instanceof Error ? err.message : String(err));
    }
  });

  // ---- branch：条目级"从这里编辑"（pi-web Edit-from-here 语义）----
  // 原地切到分支文件（工具批切齐），返回编辑器草稿（选中用户消息文本/图片）；live 换绑到新 sid。
  app.post("/:sid/branch", async (c) => {
    const r0 = await live(c);
    if ("error" in r0) return r0.error;
    if (r0.ctx.streaming) return jsonError(c, 409, "SESSION_STREAMING", "branch requires idle session");
    const body = await c.req.json().catch(() => null as any);
    if (typeof body?.entryId !== "string" || !body.entryId)
      return jsonError(c, 400, "BAD_REQUEST", "body.entryId required");
    const userId = c.get("userId");
    const newSid = crypto.randomUUID();
    const s = r0.ctx.session as unknown as {
      branch: (e: string) => Promise<{ selectedText: string; selectedImages: unknown[]; cancelled: boolean }>;
      sessionFile?: string;
    };
    let result: { selectedText: string; selectedImages: unknown[]; cancelled: boolean };
    try {
      result = await s.branch(body.entryId);
    } catch (err) {
      return jsonError(c, 409, "BRANCH_FAILED", err instanceof Error ? err.message : String(err));
    }
    if (result.cancelled) return jsonError(c, 409, "BRANCH_CANCELLED", "branch was cancelled by a hook");
    registry.unregister(r0.row.id);
    r0.ctx.detachForRebind(newSid, "branch");
    const newCtx = new SessionCtx(newSid, userId, r0.ctx.workspaceDir, r0.ctx.session);
    newCtx.unsubscribeEvent = r0.ctx.session.subscribe((evt) => newCtx.dispatchOmp(evt));
    registry.register(newCtx);
    insertSession({
      id: newSid,
      user_id: userId,
      workspace_id: newSid,
      parent_id: r0.row.id,
      title: r0.row.title ? `${r0.row.title} (branch)` : "branch",
      session_file: s.sessionFile ? toStorePath(s.sessionFile) : null,
      model_provider: r0.row.model_provider,
      model_id: r0.row.model_id,
    });
    audit("session.branch", "session", r0.row.id, userId, { newSessionId: newSid, entryId: body.entryId });
    return c.json(
      {
        id: newSid,
        parentId: r0.row.id,
        workspaceId: newSid,
        selectedText: result.selectedText,
        selectedImages: result.selectedImages,
      },
      201,
    );
  });

  app.post("/:sid/fresh", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    if (r.ctx.streaming) return jsonError(c, 409, "SESSION_STREAMING", "fresh requires idle session");
    const result = (r.ctx.session as unknown as { freshSession: () => unknown }).freshSession();
    if (result === undefined)
      return jsonError(c, 409, "FRESH_REJECTED", "fresh was rejected (streaming or not applicable)");
    audit("session.fresh", "session", r.row.id, c.get("userId"));
    return c.json({ result });
  });
}
