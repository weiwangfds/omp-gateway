/**
 * TUI 终端桥的活跃守卫（DESIGN §41.9）：终端桥打开期间，同一会话不允许网关侧
 * 复活/续写（getOrRevive 抛 TUI_ACTIVE）——omp TUI 进程与网关 SessionManager 同时
 * 打开同一 JSONL 会形成双写。独立小模块避免 routes/shared ⇄ routes/terminal 循环依赖。
 */
const active = new Set<string>();

export function markTuiActive(sid: string): void {
  active.add(sid);
}

export function markTuiClosed(sid: string): void {
  active.delete(sid);
}

/** 该会话是否正被前端 TUI 占用（getOrRevive 据此拒绝复活）。 */
export function isTuiActive(sid: string): boolean {
  return active.has(sid);
}
