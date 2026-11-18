/**
 * 无人值守 schema 同步（v3/M34，DESIGN §39.2.2）：drift 检测 + 增量落盘 + daemon 重启。
 *
 * 原理：每次内省算全目录哈希（catalogHash，schema.table.column:type 规范化排序 →
 * sha256 前 12）与注册表基线比对——相同短路（零成本）；不同才走 planModelWrites 的
 * 六情形增量（指纹一致不落盘 → agent enrich 安全；手建 model 永不删）→ `context build`
 * → daemon 定点重启（新 MDL 快照生效）。内省/连接失败 → 不改任何模型文件，注册表记
 * lastSyncError，旧模型继续服务。全程经 enqueueWrenOp 与启动 provision / admin 写操作串行。
 *
 * 调度：WREN_AUTO_SYNC_MIN（分钟，默认 1440=24h；0=关闭；非法回落默认）。启动入口先
 * 做一次 syncAll（provision 已基线 catalogHash → 无变化零 rebuild），随后
 * startWrenAutoSync 挂 unref 定时器（首轮延迟一个间隔，不抢启动）。
 */
import { truncate } from "../proc.ts";
import { DAEMON_WAIT_MS, countWrenModels, ensureWrenDaemon, killWrenDaemonFor } from "./daemon.ts";
import { WREN_LOG, resolveWrenBin } from "./env.ts";
import { selectIntrospector, type WrenCatalogRow } from "./introspect/index.ts";
import { catalogHash, catalogOf, omitsCatalog, planModelWrites } from "./models.ts";
import { enqueueWrenOp } from "./operation-queue.ts";
import { applyModelPlan, readExistingModels, runWrenCommand } from "./project.ts";
import { loadWrenRegistry, saveWrenRegistry, type WrenDsEntry, wrenProjectDir } from "./registry.ts";

export interface WrenSyncResult {
  changed: boolean;
  reason: string;
  models: number;
}

/** setInterval 最大安全延迟 ~2^31ms（约 35791 分钟）——上限夹到 30 天，超出视为非法。 */
const AUTO_SYNC_MAX_MIN = 43_200;
const AUTO_SYNC_DEFAULT_MIN = 1_440;

/** 无人值守同步间隔（分钟）：默认 1440（24h）；0 = 关闭；非整数/负数/超上限 → 回落默认。 */
export const wrenAutoSyncMinutes = (): number => {
  const n = Number(process.env.WREN_AUTO_SYNC_MIN ?? AUTO_SYNC_DEFAULT_MIN);
  if (!Number.isInteger(n) || n < 0 || n > AUTO_SYNC_MAX_MIN) return AUTO_SYNC_DEFAULT_MIN;
  return n;
};

/** 模块级定时器句柄（startWrenAutoSync 幂等；stopWrenAutoSync 优雅关停用）。 */
let autoSyncTimer: ReturnType<typeof setInterval> | null = null;

/** 注册表增量补丁（调用方已持有 wren 操作锁；写失败仅告警不抛）。 */
async function patchEntry(name: string, patch: Partial<WrenDsEntry>): Promise<void> {
  const reg = await loadWrenRegistry();
  const entry = reg[name];
  if (!entry) return;
  reg[name] = { ...entry, ...patch };
  await saveWrenRegistry(reg).catch((err) =>
    console.error(`${WREN_LOG} ${name}: 注册表写入失败（同步状态丢失，非致命）: ${truncate(String(err))}`),
  );
}

/** context build + daemon 定点重启（先杀旧实例让新 MDL 快照生效，再拉新并回写 pid）。 */
async function buildAndRestart(
  name: string,
  entry: WrenDsEntry,
  bin: string,
): Promise<{ ok: boolean; reason: string }> {
  const build = await runWrenCommand(
    bin,
    ["context", "build", "--path", wrenProjectDir(name)],
    `context build (${name})`,
  );
  if (!build.ok) return { ok: false, reason: "context build failed" };
  await killWrenDaemonFor(entry);
  delete entry.daemonPid; // 旧 daemon 已杀，pid 立即失效——防 spawn 失败时 stale pid 落盘（OS 复用 pid 后会误杀无辜进程）
  const up = await ensureWrenDaemon(bin, name, entry); // spawn 成功时把新 pid 写回 entry.daemonPid
  await patchEntry(name, { daemonPid: up ? entry.daemonPid : undefined }); // undefined = 从注册表清除该键
  if (!up) return { ok: false, reason: `daemon 未在 ${DAEMON_WAIT_MS}ms 内监听 ${entry.port}` };
  return { ok: true, reason: "synced" };
}

/**
 * 单数据源 drift 同步：内省 → catalogHash 比对 → 增量落盘 → build → daemon 重启 →
 * 更新注册表基线。changed=true 仅当模型文件实际变化或 force 重启了 daemon。
 */
export async function syncDatasource(name: string, opts?: { force?: boolean }): Promise<WrenSyncResult> {
  return enqueueWrenOp(async () => {
    const reg = await loadWrenRegistry();
    const entry = reg[name];
    if (!entry) return { changed: false, reason: "not found", models: 0 };
    const bin = resolveWrenBin();
    if (!bin) {
      console.error(`${WREN_LOG} ${name}: sync 跳过——wren CLI 不可用`);
      return { changed: false, reason: "wren CLI unavailable", models: await countWrenModels(name) };
    }
    const introspector = selectIntrospector(entry.datasource);
    if (!introspector) {
      if (!opts?.force) return { changed: false, reason: "no introspector", models: await countWrenModels(name) };
      // force：无内省器（duckdb 等）→ 模型文件原样，仅重编译 + 重启 daemon
      const restarted = await buildAndRestart(name, entry, bin);
      if (!restarted.ok) {
        await patchEntry(name, { lastSyncError: restarted.reason });
        return { changed: false, reason: restarted.reason, models: await countWrenModels(name) };
      }
      await patchEntry(name, { lastSyncedAt: new Date().toISOString(), lastSyncError: null });
      console.log(`${WREN_LOG} ${name}: force 同步完成（无内省器，重编译 + 重启 daemon）`);
      return { changed: true, reason: "forced rebuild (no introspector)", models: await countWrenModels(name) };
    }
    let rows: WrenCatalogRow[];
    try {
      rows = await introspector.introspect(entry.connection);
    } catch (err) {
      const reason = `introspect failed: ${truncate(String(err))}`;
      console.error(`${WREN_LOG} ${name}: ${reason}（保留现有模型继续服务）`);
      await patchEntry(name, { lastSyncError: reason });
      return { changed: false, reason, models: await countWrenModels(name) };
    }
    const hash = catalogHash(rows);
    const drift = entry.catalogHash !== hash;
    const existing = await readExistingModels(name);
    const plan = planModelWrites({
      existing,
      rows,
      tables: entry.tables,
      catalog: catalogOf(entry),
      omitCatalog: omitsCatalog(entry.datasource),
    });
    const hasChanges = Object.keys(plan.writes).length > 0 || plan.deletes.length > 0;
    if (!drift && !hasChanges && !opts?.force) {
      return { changed: false, reason: "no drift", models: await countWrenModels(name) };
    }
    if (!hasChanges && !opts?.force) {
      // 目录变了但都落在白名单外/无模型差异：只刷新基线与观测字段，不 build、不重启
      const now = new Date().toISOString();
      await patchEntry(name, { catalogHash: hash, lastSyncedAt: now, lastDriftAt: now, lastSyncError: null });
      console.log(`${WREN_LOG} ${name}: 目录有变化但不影响白名单内模型（基线已刷新，跳过 rebuild）`);
      return { changed: false, reason: "catalog drift outside whitelist", models: await countWrenModels(name) };
    }
    await applyModelPlan(name, plan);
    // generatedModels 收敛：旧清单中仍存在的 ∪ 本轮写入（手建文件不在清单，永不删）
    const surviving = (entry.generatedModels ?? []).filter((m) => existing.has(m) && !plan.deletes.includes(m));
    const generatedModels = [...new Set([...surviving, ...Object.keys(plan.writes)])];
    const restarted = await buildAndRestart(name, entry, bin);
    if (!restarted.ok) {
      // 模型文件已更新但编译/重启失败：不基线 hash（下次 sync 重试 build），保留旧 daemon
      await patchEntry(name, {
        lastSyncError: restarted.reason,
        ...(drift ? { lastDriftAt: new Date().toISOString() } : {}),
        generatedModels,
      });
      return { changed: false, reason: restarted.reason, models: await countWrenModels(name) };
    }
    const now = new Date().toISOString();
    await patchEntry(name, {
      catalogHash: hash,
      lastSyncedAt: now,
      ...(drift ? { lastDriftAt: now } : {}),
      lastSyncError: null,
      generatedModels,
    });
    const models = await countWrenModels(name);
    console.log(
      `${WREN_LOG} ${name}: sync 完成（${restarted.reason}，rewrite ${Object.keys(plan.writes).length} / ` +
        `delete ${plan.deletes.length} / keep ${plan.unchanged.length}，models=${models}）`,
    );
    return { changed: true, reason: opts?.force && !hasChanges ? "forced rebuild" : restarted.reason, models };
  });
}

/** 全量同步：遍历注册表逐个 sync（单个失败不中断；WREN_MCP!=1 → 空数组）。 */
export async function syncAll(opts?: { force?: boolean }): Promise<WrenSyncResult[]> {
  if (process.env.WREN_MCP !== "1") return [];
  const reg = await loadWrenRegistry();
  const results: WrenSyncResult[] = [];
  for (const name of Object.keys(reg).sort()) {
    try {
      results.push(await syncDatasource(name, opts));
    } catch (err) {
      console.error(`${WREN_LOG} ${name}: sync 异常（继续下一个）: ${truncate(String(err))}`);
      results.push({ changed: false, reason: `sync failed: ${truncate(String(err))}`, models: 0 });
    }
  }
  return results;
}

/** 无人值守调度：每 WREN_AUTO_SYNC_MIN 分钟跑一次 syncAll（0 = 关闭；重复调用幂等）。 */
export function startWrenAutoSync(): void {
  const minutes = wrenAutoSyncMinutes();
  if (minutes === 0) {
    console.log(`${WREN_LOG} auto-sync 已关闭（WREN_AUTO_SYNC_MIN=0）`);
    return;
  }
  if (autoSyncTimer) return;
  autoSyncTimer = setInterval(() => {
    void syncAll()
      .then((results) => {
        const changed = results.filter((r) => r.changed);
        if (changed.length > 0) {
          console.log(`${WREN_LOG} auto-sync：${changed.length} 个数据源已同步更新（其余无 drift）`);
        }
      })
      .catch((err) => console.error(`${WREN_LOG} auto-sync 失败（下个周期重试）: ${truncate(String(err))}`));
  }, minutes * 60_000);
  (autoSyncTimer as { unref?: () => void }).unref?.(); // 不阻塞进程退出
  console.log(`${WREN_LOG} auto-sync 已排程：每 ${minutes} 分钟（WREN_AUTO_SYNC_MIN=${minutes}，首轮延迟一个间隔）`);
}

/** 停掉无人值守调度（优雅关停用；未启动时 no-op）。 */
export function stopWrenAutoSync(): void {
  if (!autoSyncTimer) return;
  clearInterval(autoSyncTimer);
  autoSyncTimer = null;
}
