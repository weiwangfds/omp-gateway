/**
 * 长驻子进程监督（DESIGN §40，M33）：端口探活、pid 存活、日志重定向 spawn、定点杀。
 * 目前只有 wren 家族消费本模块（registry/service/wren-daemon）；qmd 的 daemon 由
 * entrypoint 启动，不经这里。
 *
 * 探活语义与拆分前一致：向环回端口 POST 一个空 JSON（路径默认 /mcp），拿到任意 HTTP
 * 响应即视为在听（daemon 对裸 POST 回 400 也算）；连接失败/超时才是在听为 false。
 */
import { closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";

/** wren/qmd 的 MCP HTTP 端点路径（FastMCP streamable-http，实测 /mcp）。 */
export const MCP_PROBE_PATH = "/mcp";

/** 环回端口是否已有服务在听（任意 HTTP 响应都算）。 */
export async function isPortListening(port: number, probePath = MCP_PROBE_PATH): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}${probePath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(2_000),
    });
    return true;
  } catch {
    return false;
  }
}

/** pid 存活检查（signal 0；容器重启后旧 pid 自然失效，误判面仅限同容器生命周期）。 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface SpawnDaemonInput {
  bin: string;
  args: string[];
  env: Record<string, string | undefined>;
  /** 日志文件名（<logDir>/<logLabel>.log，追加写）。 */
  logLabel: string;
}

export interface SpawnDaemonResult {
  ok: boolean;
  pid?: number;
  logPath?: string;
  error?: string;
}

/**
 * DaemonSupervisor：长驻进程的生命周期原语。日志目录由构造参数决定，
 * 探活路径默认 /mcp（qmd/wren 同构）。spawn 不等待就绪——就绪轮询由调用方负责
 * （各 daemon 的启动窗口不同）。
 */
export class DaemonSupervisor {
  private readonly logDir: string;
  private readonly probePath: string;

  constructor(opts: { logDir: string; probePath?: string }) {
    this.logDir = opts.logDir;
    this.probePath = opts.probePath ?? MCP_PROBE_PATH;
  }

  isPortListening(port: number): Promise<boolean> {
    return isPortListening(port, this.probePath);
  }

  isPidAlive(pid: number): boolean {
    return isPidAlive(pid);
  }

  /**
   * spawn 长驻进程：stdin ignore、stdout/stderr 追加到 <logDir>/<logLabel>.log。
   * spawn 本身失败不抛（返回 {ok:false,error}）；日志文件打开失败照旧上抛（与拆分前一致）。
   */
  spawnDaemon(input: SpawnDaemonInput): SpawnDaemonResult {
    try {
      mkdirSync(this.logDir, { recursive: true });
    } catch {}
    const logPath = path.join(this.logDir, `${input.logLabel}.log`);
    const logFd = openSync(logPath, "a");
    try {
      const proc = Bun.spawn([input.bin, ...input.args], {
        env: input.env,
        stdin: "ignore",
        stdout: logFd,
        stderr: logFd,
      });
      return { ok: true, pid: proc.pid, logPath };
    } catch (err) {
      return { ok: false, logPath, error: String(err) };
    } finally {
      closeSync(logFd);
    }
  }

  /**
   * 定点杀：Windows 走 taskkill /F /T（含子进程树，python daemon 常带 uvicorn 子进程），
   * POSIX 走 SIGTERM（优雅退出）。失败返回 {ok:false,error} 供调用方告警。
   */
  killPid(pid: number): { ok: boolean; error?: string } {
    try {
      if (process.platform === "win32") {
        const r = Bun.spawnSync(["taskkill", "/F", "/T", "/PID", String(pid)], {
          stdout: "ignore",
          stderr: "ignore",
        });
        return r.exitCode === 0 ? { ok: true } : { ok: false, error: `taskkill exit ${r.exitCode}` };
      }
      process.kill(pid, "SIGTERM");
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }
}

export { sleepMs };
