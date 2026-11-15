import { resolveInside } from "./files.ts";

/** git 基础操作（DESIGN §15）：子进程执行（参数数组，无 shell 拼接），超时 + 输出截断。 */

/** git 失败的统一异常：code 决定 HTTP 状态（NOT_A_GIT_REPO→409、GIT_TIMEOUT→504、其余→500）。 */
export class GitError extends Error {
  constructor(
    public code: "NOT_A_GIT_REPO" | "GIT_TIMEOUT" | "GIT_FAILED" | "GIT_UNAVAILABLE",
    message: string,
    public stderr?: string,
  ) {
    super(message);
  }
}

const MAX_OUTPUT = 2 * 1024 * 1024; // 2MB
const DEFAULT_TIMEOUT_MS = 15_000;

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * 在 workspace 内执行 git 子命令（参数数组，无 shell 拼接）。
 * 超时强杀进程；stdout/stderr 各截断到 2MB，防大 diff 撑爆内存。
 */
export async function runGit(workspaceDir: string, args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<GitResult> {
  // cwd 必须在 workspace 内（本模块全部调用点传 "." 与受守卫的相对路径）
  const cwd = await resolveInside(workspaceDir, ".");
  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  } catch (err) {
    throw new GitError("GIT_UNAVAILABLE", `git spawn failed: ${String(err)}`);
  }
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {}
  }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);
    if (timeoutMs > 0 && exitCode === null) throw new GitError("GIT_TIMEOUT", `git ${args[0]} timed out`);
    return { code: exitCode ?? 0, stdout: stdout.slice(0, MAX_OUTPUT), stderr: stderr.slice(0, MAX_OUTPUT) };
  } finally {
    clearTimeout(timer);
  }
}

async function assertRepo(workspaceDir: string): Promise<void> {
  const r = await runGit(workspaceDir, ["rev-parse", "--is-inside-work-tree"], 5_000);
  if (r.code !== 0 || r.stdout.trim() !== "true")
    throw new GitError("NOT_A_GIT_REPO", "workspace is not a git repository", r.stderr);
}

export interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  entries: Array<{ x: string; y: string; path: string; origPath?: string }>;
}

/** porcelain v1 status 解析：分支/上游/ahead-behind + 逐文件变更（rename 拆 origPath）。 */
export async function gitStatus(workspaceDir: string): Promise<GitStatus> {
  await assertRepo(workspaceDir);
  // -uall：展开未跟踪目录内的文件（对齐 VS Code 文件树预期）
  const r = await runGit(workspaceDir, ["status", "--porcelain=v1", "-b", "-uall"]);
  if (r.code !== 0) throw new GitError("GIT_FAILED", "git status failed", r.stderr);
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const entries: GitStatus["entries"] = [];
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("## ")) {
      const noCommits = line.match(/^## No commits yet on (.+)$/);
      const m = noCommits ?? line.match(/^## ([^.\s]+)(\.{3}(\S+))?(?:\s+\[ahead (\d+), behind (\d+)\])?/);
      if (m) {
        branch = m[1];
        upstream = m[3] ?? null;
        ahead = Number(m[4] ?? 0);
        behind = Number(m[5] ?? 0);
      }
      continue;
    }
    if (line.length < 4) continue;
    const x = line[0];
    const y = line[1];
    let rest = line.slice(3);
    let origPath: string | undefined;
    const arrow = rest.match(/^(.+) -> (.+)$/);
    if (arrow) {
      origPath = arrow[1];
      rest = arrow[2];
    }
    entries.push({ x, y, path: rest, origPath });
  }
  return { branch, upstream, ahead, behind, entries };
}

/** 提交历史（%h/%an/%aI/%s 制表符分隔；空仓库返回空数组而非报错）。 */
export async function gitLog(
  workspaceDir: string,
  limit = 20,
): Promise<Array<{ hash: string; author: string; date: string; subject: string }>> {
  await assertRepo(workspaceDir);
  const n = Math.min(Math.max(limit, 1), 100);
  const r = await runGit(workspaceDir, ["log", `--max-count=${n}`, "--pretty=format:%h%x09%an%x09%aI%x09%s"]);
  if (r.code !== 0) {
    if (/does not have any commits yet|fatal: your current branch/.test(r.stderr) && r.stdout === "") return [];
    throw new GitError("GIT_FAILED", "git log failed", r.stderr);
  }
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, author, date, ...subj] = line.split("\t");
      return { hash, author, date, subject: subj.join("\t") };
    });
}

/** diff 输出；base 为 ref 表达式（拒绝 "-" 开头防 flag 注入），truncated 标记 2MB 截断。 */
export async function gitDiff(
  workspaceDir: string,
  opts: { path?: string; staged?: boolean; stat?: boolean; base?: string } = {},
): Promise<{ diff: string; truncated: boolean }> {
  await assertRepo(workspaceDir);
  const args = ["diff", "--no-color"];
  if (opts.stat) args.push("--stat");
  if (opts.staged) args.push("--cached");
  if (opts.base) {
    // base 为 ref 表达式；防 flag 注入（参数数组无 shell，但仍拒绝以 "-" 开头）
    if (!/^[A-Za-z0-9._~^:/\\-]{1,120}$/.test(opts.base) || opts.base.startsWith("-")) {
      throw new GitError("GIT_FAILED", "invalid base ref");
    }
    args.push(opts.base);
  }
  if (opts.path) args.push("--", (await resolveInside(workspaceDir, opts.path)).slice(workspaceDir.length + 1) || ".");
  const r = await runGit(workspaceDir, args);
  if (r.code !== 0) throw new GitError("GIT_FAILED", "git diff failed", r.stderr);
  const truncated = r.stdout.length >= MAX_OUTPUT;
  return { diff: r.stdout, truncated };
}

/** 全部分支（含远程，剥 remotes/ 前缀），current 标记当前分支。 */
export async function gitBranches(workspaceDir: string): Promise<Array<{ name: string; current: boolean }>> {
  await assertRepo(workspaceDir);
  const r = await runGit(workspaceDir, ["branch", "--all", "--no-color"]);
  if (r.code !== 0) throw new GitError("GIT_FAILED", "git branch failed", r.stderr);
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => ({ name: l.replace(/^\*\s+/, "").replace(/^remotes\//, ""), current: l.startsWith("* ") }));
}

/** stage（all 或白名单内相对路径）后提交；无变更抛 GIT_FAILED。 */
export async function gitCommit(
  workspaceDir: string,
  message: string,
  add?: string[] | "all",
): Promise<{ hash: string }> {
  await assertRepo(workspaceDir);
  if (add === "all") {
    const rAdd = await runGit(workspaceDir, ["add", "-A"]);
    if (rAdd.code !== 0) throw new GitError("GIT_FAILED", "git add -A failed", rAdd.stderr);
  } else if (Array.isArray(add) && add.length) {
    const safe = [];
    for (const p of add) safe.push((await resolveInside(workspaceDir, p)).slice(workspaceDir.length + 1) || ".");
    const rAdd = await runGit(workspaceDir, ["add", "--", ...safe]);
    if (rAdd.code !== 0) throw new GitError("GIT_FAILED", "git add failed", rAdd.stderr);
  }
  const rCommit = await runGit(workspaceDir, ["commit", "-m", message]);
  if (rCommit.code !== 0) {
    if (/nothing to commit/.test(rCommit.stderr + rCommit.stdout))
      throw new GitError("GIT_FAILED", "nothing to commit", rCommit.stderr);
    throw new GitError("GIT_FAILED", "git commit failed", rCommit.stderr);
  }
  const rHead = await runGit(workspaceDir, ["rev-parse", "--short", "HEAD"], 5_000);
  return { hash: rHead.stdout.trim() };
}

// ---- git worktree（pi-web 对标；路径守卫由路由层按用户根执行）----

export interface WorktreeInfo {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  detached: boolean;
}

/** porcelain worktree list 解析为结构化条目。 */
export async function gitWorktreeList(workspaceDir: string): Promise<WorktreeInfo[]> {
  await assertRepo(workspaceDir);
  const r = await runGit(workspaceDir, ["worktree", "list", "--porcelain"]);
  if (r.code !== 0) throw new GitError("GIT_FAILED", "git worktree list failed", r.stderr);
  const out: WorktreeInfo[] = [];
  let cur: Partial<WorktreeInfo> = {};
  const flush = () => {
    if (cur.path) {
      out.push({
        path: cur.path,
        head: cur.head ?? null,
        branch: cur.branch ?? null,
        bare: cur.bare ?? false,
        detached: cur.detached ?? false,
      });
    }
    cur = {};
  };
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      cur.path = line.slice("worktree ".length);
    } else if (line.startsWith("HEAD ")) cur.head = line.slice(5);
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (line === "bare") cur.bare = true;
    else if (line === "detached") cur.detached = true;
  }
  flush();
  return out;
}

/** 新建 worktree（可带 -b 新分支）；targetAbs 已由路由层按用户根守卫。 */
export async function gitWorktreeAdd(
  workspaceDir: string,
  targetAbs: string,
  opts: { newBranch?: string } = {},
): Promise<{ path: string }> {
  await assertRepo(workspaceDir);
  const args = ["worktree", "add"];
  if (opts.newBranch) args.push("-b", opts.newBranch);
  args.push(targetAbs);
  const r = await runGit(workspaceDir, args, 30_000);
  if (r.code !== 0) throw new GitError("GIT_FAILED", "git worktree add failed", r.stderr);
  return { path: targetAbs };
}

/** 移除 worktree（force 绕过脏检查）；targetAbs 已由路由层守卫。 */
export async function gitWorktreeRemove(workspaceDir: string, targetAbs: string, force = false): Promise<void> {
  await assertRepo(workspaceDir);
  const r = await runGit(workspaceDir, ["worktree", "remove", ...(force ? ["--force"] : []), targetAbs], 30_000);
  if (r.code !== 0) {
    if (/is not a working tree|not a working tree/i.test(r.stderr))
      throw new GitError("GIT_FAILED", "worktree not found", r.stderr);
    throw new GitError("GIT_FAILED", "git worktree remove failed", r.stderr);
  }
}
