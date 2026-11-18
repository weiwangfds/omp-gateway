/**
 * wren 运行时操作互斥（Command 队列，DESIGN §40）：PUT/DELETE/rebuild 与启动
 * provision 串行化，防注册表/daemon 竞态。所有入口共用同一条 promise 链。
 */
let wrenOpChain: Promise<unknown> = Promise.resolve();

/** 入队一条写操作（前一条失败不阻塞后续；返回本条结果/异常）。 */
export function enqueueWrenOp<T>(fn: () => Promise<T>): Promise<T> {
  const next = wrenOpChain.then(fn, fn);
  wrenOpChain = next.catch(() => {});
  return next;
}

/** admin API 共用别名：PUT/DELETE/rebuild 串行化入口（语义同 enqueueWrenOp）。 */
export const runWrenAdminOp = enqueueWrenOp;
