/**
 * wren MCP daemon 生命周期（DESIGN §39.2 步骤 5 + §40）：基于 core/daemon 的
 * DaemonSupervisor——端口已被监听则复用存量；PUT/rebuild 先定点杀旧实例再拉，
 * 让新 MDL 快照生效（§39.5.1）。日志落 <WREN_HOME>/logs/<name>.log。
 */
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { DaemonSupervisor } from "../daemon.ts";
import { truncate } from "../proc.ts";
import { WREN_LOG, wrenHome, wrenSubprocessEnv } from "./env.ts";
import { MCP_PATH } from "./mcp.ts";
import { wrenProjectDir, type WrenDsEntry } from "./registry.ts";

/** daemon 端口就绪等待上限（含 python 冷启动 + uvicorn 起服，实测 ~10s） */
export const DAEMON_WAIT_MS = 40_000;
/** 杀 daemon 后等端口释放的窗口 */
const PORT_RELEASE_WAIT_MS = 8_000;

const supervisor = (): DaemonSupervisor => new DaemonSupervisor({ logDir: path.join(wrenHome(), "logs") });

/**
 * 步骤 5：MCP daemon。启动路径（restartDaemon=false）端口已被监听则复用存量不重启；
 * PUT/rebuild 路径（restartDaemon=true）由调用方先 killWrenDaemonFor 再进这里。
 * 成功后把 pid 写回 entry.daemonPid（调用方持久化注册表）。
 */
export async function ensureWrenDaemon(bin: string, name: string, entry: WrenDsEntry): Promise<boolean> {
  const sup = supervisor();
  if (await sup.isPortListening(entry.port)) {
    console.log(`${WREN_LOG} ${name}: 端口 ${entry.port} 已有服务在听，复用存量 daemon`);
    return true;
  }
  const spawned = sup.spawnDaemon({
    bin,
    args: [
      "serve",
      "mcp",
      "--transport",
      "http",
      "--host",
      "127.0.0.1",
      "--port",
      String(entry.port),
      "--project",
      wrenProjectDir(name),
      "--quiet",
    ],
    env: wrenSubprocessEnv(),
    logLabel: name,
  });
  if (!spawned.ok || spawned.pid == null) {
    console.error(`${WREN_LOG} ${name}: daemon spawn failed: ${truncate(spawned.error ?? "unknown error")}`);
    return false;
  }
  const { pid, logPath } = spawned;
  entry.daemonPid = pid;
  console.log(`${WREN_LOG} ${name}: daemon pid=${pid} → http://127.0.0.1:${entry.port}${MCP_PATH} (log: ${logPath})`);
  const deadline = Date.now() + DAEMON_WAIT_MS;
  while (Date.now() < deadline) {
    if (await sup.isPortListening(entry.port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error(
    `${WREN_LOG} ${name}: daemon ${DAEMON_WAIT_MS}ms 内未监听 ${entry.port}（进程保留，稍后可自愈；日志见 ${logPath}）`,
  );
  return false;
}

/** 杀掉注册表端口上的旧 daemon（pid 定点杀；端口不在听 → no-op）。返回是否杀过。 */
export async function killWrenDaemonFor(entry: Pick<WrenDsEntry, "port" | "daemonPid">): Promise<boolean> {
  const sup = supervisor();
  if (!(await sup.isPortListening(entry.port))) return false;
  const pid = entry.daemonPid;
  if (pid && sup.isPidAlive(pid)) {
    const killed = sup.killPid(pid);
    if (!killed.ok) console.error(`${WREN_LOG} kill daemon pid=${pid}: ${truncate(killed.error ?? "kill failed")}`);
  } else {
    console.error(`${WREN_LOG} 端口 ${entry.port} 在听但无可杀 pid（daemonPid=${pid ?? "无"}），跳过定点杀`);
    return false;
  }
  const deadline = Date.now() + PORT_RELEASE_WAIT_MS;
  while (Date.now() < deadline) {
    if (!(await sup.isPortListening(entry.port))) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  console.error(`${WREN_LOG} 端口 ${entry.port} 杀 pid=${pid} 后仍未释放（PORT_RELEASE_WAIT_MS 内）`);
  return false;
}

/** models/ 下已生成的 model 数（*.yml，含 agent enrich 的）。 */
export async function countWrenModels(name: string): Promise<number> {
  const dir = path.join(wrenProjectDir(name), "models");
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  let n = 0;
  for (const e of entries) {
    if (existsSync(path.join(dir, e, "metadata.yml"))) n++;
  }
  return n;
}
