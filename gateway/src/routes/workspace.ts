/**
 * workspace 文件/git 路由的**组合根**（DESIGN §17 / §31）。
 *
 * - shared.ts  归属 → workspace 目录、归档只读、FileGuard/Git 错误映射
 * - files.ts   文件树/索引/读写/raw/上传/mkdir/rename/delete
 * - git.ts     status/log/diff/branches/commit/worktree
 *
 * 文件面作用于会话 workspace（与 live 进程态无关；dispose 后仍可访问）。
 */
import type { Hono } from "hono";
import { mountWorkspaceFileRoutes } from "./workspace/files.ts";
import { mountWorkspaceGitRoutes } from "./workspace/git.ts";
import { createWorkspaceShared, type WorkspaceEnv, type WorkspaceRowFn } from "./workspace/shared.ts";

export function mountWorkspaceRoutes(app: Hono<WorkspaceEnv>, ownedSession: WorkspaceRowFn): void {
  const shared = createWorkspaceShared(ownedSession);
  mountWorkspaceFileRoutes(app, shared);
  mountWorkspaceGitRoutes(app, shared);
}
