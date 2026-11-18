/**
 * 子进程执行底座（DESIGN §40，M33）：argv 数组 spawn、超时强杀、输出截断、失败告警。
 * wren / qmd 的 CLI 包装共用（原先两份 runWren/runQmd 各写一遍 spawn+timeout+日志）。
 *
 * 安全：参数只允许来自部署方 env 与已校验白名单；用户输入必须过白名单后再进 argv。
 * Bun.spawn 数组传参无 shell 解析，但 argv 值仍会进入目标 CLI 语义，白名单不可省。
 */
import { existsSync } from "node:fs";
import path from "node:path";

/** 日志里 stdout/stderr 的截断长度（与拆分前一致）。 */
export const LOG_TRUNCATE = 2048;
/** 单条命令默认超时（wren context build / qmd update 大语料可到分钟级）。 */
export const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/** 日志截断：超长追加标记。 */
export const truncate = (s: string): string =>
  s.length > LOG_TRUNCATE ? `${s.slice(0, LOG_TRUNCATE)}…(truncated)` : s;

/**
 * bin 解析：绝对/相对路径直接判存在，裸名走 PATH。找不到返回 null
 * （调用方按各自 no-op 语义降级，不 spawn）。
 */
export function resolveBin(name: string): string | null {
  if (path.isAbsolute(name) || name.includes("/") || name.includes("\\")) {
    return existsSync(name) ? name : null;
  }
  return Bun.which(name);
}

export interface RunCommandOptions {
  bin: string;
  args: string[];
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  label?: string;
  logPrefix?: string;
}

export interface RunCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
  /** bin 不在（PATH/路径均不可用）——调用方按 no-op 语义处理，区别于命令执行失败。 */
  missing?: boolean;
}

/**
 * 跑一条命令并等待结束（超时强杀）。失败 console.error 告警（label + argv 前 4 项 +
 * 截断的 stdout/stderr），出口 best-effort：不抛，调用方看 ok/error。
 */
export async function runCommand(opts: RunCommandOptions): Promise<RunCommandResult> {
  const bin = resolveBin(opts.bin);
  if (!bin) return { ok: false, stdout: "", stderr: "", missing: true };
  const logPrefix = opts.logPrefix ?? "[gateway:proc]";
  const label = opts.label ?? opts.bin;
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([bin, ...opts.args], {
      env: opts.env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
  } catch (err) {
    console.error(`${logPrefix} ${label}: spawn failed: ${truncate(String(err))}`);
    return { ok: false, stdout: "", stderr: "", error: String(err) };
  }
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {}
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text().catch(() => ""),
      new Response(proc.stderr as ReadableStream).text().catch(() => ""),
      proc.exited,
    ]);
    const ok = proc.exitCode === 0;
    if (!ok) {
      console.error(
        `${logPrefix} ${label}: exit=${proc.exitCode} argv=${JSON.stringify(opts.args.slice(0, 4))} ` +
          `stdout=${truncate(stdout)} stderr=${truncate(stderr)}`,
      );
    }
    return { ok, stdout, stderr, error: ok ? undefined : `exit ${proc.exitCode}` };
  } finally {
    clearTimeout(timer);
  }
}
