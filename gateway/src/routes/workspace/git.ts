/** workspace git 面（DESIGN §17）：status/log/diff/branches/commit/worktree。 */
import type { Hono } from "hono";
import path from "node:path";
import {
  gitBranches,
  gitCommit,
  gitDiff,
  gitLog,
  gitStatus,
  gitWorktreeAdd,
  gitWorktreeList,
  gitWorktreeRemove,
} from "../../core/git.ts";
import { userRoot } from "../../core/paths.ts";
import type { WorkspaceEnv, WorkspaceShared } from "./shared.ts";

/** git 面：status/log/diff/branches/commit/worktree（用户根守卫）。 */
export function mountWorkspaceGitRoutes(app: Hono<WorkspaceEnv>, shared: WorkspaceShared): void {
  const { ws, writeGuard, guardErr } = shared;

  // ---- git 基础 ----

  app.get("/:sid/git/status", async (c) => {
    const w = ws(c);
    if ("err" in w) return w.err;
    try {
      return c.json(await gitStatus(w.dir));
    } catch (err) {
      return guardErr(c, err);
    }
  });

  app.get("/:sid/git/log", async (c) => {
    const w = ws(c);
    if ("err" in w) return w.err;
    try {
      return c.json({ commits: await gitLog(w.dir, Number(c.req.query("limit") ?? 20)) });
    } catch (err) {
      return guardErr(c, err);
    }
  });

  app.get("/:sid/git/diff", async (c) => {
    const w = ws(c);
    if ("err" in w) return w.err;
    try {
      return c.json(
        await gitDiff(w.dir, {
          path: c.req.query("path") ?? undefined,
          staged: c.req.query("staged") === "1",
          stat: c.req.query("stat") === "1",
          base: c.req.query("base") ?? undefined,
        }),
      );
    } catch (err) {
      return guardErr(c, err);
    }
  });

  app.get("/:sid/git/branches", async (c) => {
    const w = ws(c);
    if ("err" in w) return w.err;
    try {
      return c.json({ branches: await gitBranches(w.dir) });
    } catch (err) {
      return guardErr(c, err);
    }
  });

  app.post("/:sid/git/commit", async (c) => {
    const w = ws(c);
    if ("err" in w) return w.err;
    const blocked = writeGuard(c, w.row);
    if (blocked) return blocked;
    const body = await c.req.json().catch(() => null as any);
    if (typeof body?.message !== "string" || !body.message.trim()) {
      return c.json({ error: { code: "BAD_REQUEST", message: "body.message required" } }, 400);
    }
    if (body.add !== undefined && body.add !== "all" && !Array.isArray(body.add)) {
      return c.json({ error: { code: "BAD_REQUEST", message: 'body.add must be "all" or path array' } }, 400);
    }
    try {
      return c.json(await gitCommit(w.dir, body.message, body.add));
    } catch (err) {
      return guardErr(c, err);
    }
  });

  // ---- git worktree（pi-web 对标；worktree 路径必须在用户数据根内）----
  const guardUserRoot = (c: any, p: string): string | Response => {
    const resolved = path.resolve(userRoot(c.get("userId")), p);
    if (!resolved.startsWith(userRoot(c.get("userId")) + path.sep)) {
      return c.json({ error: { code: "PATH_FORBIDDEN", message: `worktree path escapes user root: ${p}` } }, 400);
    }
    return resolved;
  };

  app.get("/:sid/git/worktrees", async (c) => {
    const w = ws(c);
    if ("err" in w) return w.err;
    try {
      return c.json({ worktrees: await gitWorktreeList(w.dir) });
    } catch (err) {
      return guardErr(c, err);
    }
  });

  app.post("/:sid/git/worktrees", async (c) => {
    const w = ws(c);
    if ("err" in w) return w.err;
    const blocked = writeGuard(c, w.row);
    if (blocked) return blocked;
    const body = await c.req.json().catch(() => null as any);
    if (typeof body?.path !== "string" || !body.path.trim()) {
      return c.json({ error: { code: "BAD_REQUEST", message: "body.path required" } }, 400);
    }
    const target = guardUserRoot(c, body.path);
    if (typeof target !== "string") return target;
    try {
      return c.json(
        await gitWorktreeAdd(w.dir, target, {
          newBranch: typeof body?.newBranch === "string" ? body.newBranch : undefined,
        }),
        201,
      );
    } catch (err) {
      return guardErr(c, err);
    }
  });

  app.delete("/:sid/git/worktrees", async (c) => {
    const w = ws(c);
    if ("err" in w) return w.err;
    const blocked = writeGuard(c, w.row);
    if (blocked) return blocked;
    const p = c.req.query("path") ?? "";
    if (!p) return c.json({ error: { code: "BAD_REQUEST", message: "path query required" } }, 400);
    const target = guardUserRoot(c, p);
    if (typeof target !== "string") return target;
    try {
      await gitWorktreeRemove(w.dir, target, c.req.query("force") === "1");
      return c.json({ ok: true, path: target });
    } catch (err) {
      return guardErr(c, err);
    }
  });
}
