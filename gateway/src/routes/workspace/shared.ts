/**
 * workspace 路由共享守卫（DESIGN §17 / §31）：
 * 归属 → workspace 目录定位；归档会话只读；FileGuard/Git 错误统一映射。
 */
import { FileGuardError } from "../../core/files.ts";
import { GitError } from "../../core/git.ts";
import { userWorkspace } from "../../core/paths.ts";
import type { SessionRow } from "../../core/tenant-store.ts";

export type WorkspaceEnv = { Variables: { userId: string } };

export type WorkspaceRowFn = (sid: string, userId: string) => SessionRow | undefined;

export interface WorkspaceShared {
  ws: (c: any) => { dir: string; row: SessionRow } | { err: Response };
  writeGuard: (c: any, row: SessionRow) => Response | null;
  guardErr: (c: any, err: unknown) => Response;
}

export function createWorkspaceShared(ownedSession: WorkspaceRowFn): WorkspaceShared {
  const ws = (c: any): { dir: string; row: SessionRow } | { err: Response } => {
    const row = ownedSession(c.req.param("sid"), c.get("userId"));
    if (!row) return { err: c.json({ error: { code: "NOT_FOUND", message: "session not found" } }, 404) };
    return { dir: userWorkspace(row.user_id, row.workspace_id), row };
  };
  const writeGuard = (c: any, row: SessionRow): Response | null =>
    row.status !== "active"
      ? c.json({ error: { code: "SESSION_ARCHIVED", message: "archived session is read-only" } }, 409)
      : null;
  const guardErr = (c: any, err: unknown): Response => {
    if (err instanceof FileGuardError) return c.json({ error: { code: "PATH_FORBIDDEN", message: err.message } }, 400);
    if (err instanceof GitError) {
      const status = err.code === "NOT_A_GIT_REPO" ? 409 : err.code === "GIT_TIMEOUT" ? 504 : 500;
      return c.json(
        { error: { code: err.code, message: err.message, details: err.stderr?.slice(0, 2000) } },
        status as 409,
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    const code = msg === "FILE_TOO_LARGE" ? 413 : msg === "IS_DIRECTORY" ? 400 : msg === "INVALID_RANGE" ? 416 : null;
    if (code) return c.json({ error: { code, message: msg } }, code as 413);
    console.error("[workspace]", err);
    return c.json({ error: { code: "INTERNAL", message: "workspace operation failed" } }, 500);
  };
  return { ws, writeGuard, guardErr };
}
