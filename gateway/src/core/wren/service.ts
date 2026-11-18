/**
 * WrenService（Facade + Template Method，DESIGN §40）：per 数据源供应的固定八步骨架
 * profile → scaffold → introspect → generate → build → daemon → mcp → skill。
 *
 * 语义约束（与拆分前逐字对齐）：
 *   - 任一步失败按现有语义降级：profile/scaffold/bind/build 失败即返回（lastError 记因）；
 *     内省失败非致命（保留空骨架继续 build）；daemon 失败只记 lastError，mcp 不注册。
 *   - 密钥 env 无条件注入（网关重启后 profile 已存在、跳过 add，daemon 仍需展开占位符）。
 *   - 日志前缀仍是 [gateway:wren]；全部出口 best-effort，不阻塞启动。
 */
import { mkdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import { isPortListening } from "../daemon.ts";
import { truncate } from "../proc.ts";
import { DAEMON_WAIT_MS, countWrenModels, ensureWrenDaemon, killWrenDaemonFor } from "./daemon.ts";
import { WREN_LOG, parseWrenDatasources, resolveWrenBin, wrenBin, wrenHome, type WrenDatasourceSpec } from "./env.ts";
import { introspectWrenDatasource } from "./introspect/index.ts";
import { registerWrenMcpServers, removeWrenMcpServer } from "./mcp.ts";
import { catalogHash, catalogOf, omitsCatalog, planModelWrites } from "./models.ts";
import { enqueueWrenOp } from "./operation-queue.ts";
import {
  applyModelPlan,
  buildProfilePayloadFor,
  ensureWrenProfile,
  ensureWrenSkeleton,
  readExistingModels,
  redactConnection,
  runWrenCommand,
} from "./project.ts";
import { loadWrenRegistry, mergeWrenSeeds, saveWrenRegistry, wrenProjectDir, type WrenDsEntry } from "./registry.ts";
import { materializeDataQuerySkill, refreshDataQuerySkill } from "./skill.ts";

export class WrenService {
  /**
   * 全量幂等 provision（模板方法：固定八步，子步可覆盖）。任何子步失败记入返回
   * entry.lastError（非致命：骨架/daemon 尽量照常）。restartDaemon=true（PUT/rebuild）
   * 先杀旧 daemon 再拉，让重生成/重编译的 MDL 快照生效（§39.5.1）；启动路径 false
   * （端口在听即复用）。调用方负责把返回 entry 写回注册表。
   */
  async provision(
    name: string,
    entry: WrenDsEntry,
    bin: string,
    opts?: { restartDaemon?: boolean },
  ): Promise<WrenDsEntry> {
    const out: WrenDsEntry = { ...entry, lastError: null };
    try {
      // 1. 密钥 env 注入（无条件——daemon/会话 shell 依赖它展开占位符）
      const payload = this.stepSecrets(name, entry);
      // 2. profile
      if (!(await this.stepProfile(name, bin, payload))) {
        out.lastError = "profile add failed";
        return out;
      }
      // 3. 骨架 + profile 绑定
      if (!(await this.stepScaffold(name, bin))) {
        out.lastError = "context init failed";
        return out;
      }
      if (!(await this.stepBindProfile(name, bin))) {
        out.lastError = "context set-profile failed";
        return out;
      }
      // 4. 内省 + 生成 models（失败非致命）→ context build
      await this.stepIntrospectAndGenerate(name, entry, out);
      if (!(await this.stepBuild(name, bin, out))) return out;
      // 5. daemon（restartDaemon=true 先杀旧的，让新 MDL 快照生效）
      if (await this.stepDaemon(name, entry, out, bin, opts)) {
        // 6. mcp.json ensure（PUT/rebuild 路径没有启动流程的批量注册）
        await this.stepMcp(name, entry);
      }
      // 7-8. skill（默认 no-op：由 ensureAll 批量物化 / admin 路由 refresh 触发）
      await this.stepSkill(out);
      return out;
    } catch (err) {
      console.error(`${WREN_LOG} ${name}: ${truncate(String(err))}（provision 失败，非致命）`);
      return { ...out, lastError: truncate(String(err)) };
    }
  }

  /** 删除数据源生命周期：杀 daemon → mcp.json 移除 → 项目目录删除（调用方移除注册表）。 */
  async deprovision(name: string, entry: WrenDsEntry): Promise<void> {
    try {
      await killWrenDaemonFor(entry);
    } catch (err) {
      console.error(`${WREN_LOG} ${name}: 杀 daemon 失败（继续清理）: ${truncate(String(err))}`);
    }
    try {
      await removeWrenMcpServer(name);
    } catch (err) {
      console.error(`${WREN_LOG} ${name}: mcp.json 移除失败（继续清理）: ${truncate(String(err))}`);
    }
    try {
      await fs.rm(wrenProjectDir(name), { recursive: true, force: true });
    } catch (err) {
      console.error(`${WREN_LOG} ${name}: 项目目录删除失败: ${truncate(String(err))}`);
    }
  }

  /**
   * 网关启动入口（main() 在 ensureQmdMcpRegistered 之后调用一次）：
   * WREN_MCP!=1 → no-op；读注册表 → env 种子合并（仅补缺失名，admin 条目优先）→
   * 全量 provision（幂等；daemon 端口已监听则注入 env 复用）；wren 不在 PATH →
   * 只物化 skill 骨架 + 告警。单个数据源失败只跳过，绝不阻塞启动。
   */
  async ensureAll(): Promise<void> {
    if (process.env.WREN_MCP !== "1") return;
    const bin = resolveWrenBin();
    const reg = await loadWrenRegistry();
    const seeds = parseWrenDatasources();
    for (const r of seeds.rejected) console.error(`${WREN_LOG} 种子数据源 ${r.name} 跳过：${r.reason}`);
    if (!bin && Object.keys(reg).length === 0 && seeds.specs.length === 0) return;
    if (!bin) {
      console.error(
        `${WREN_LOG} wren 未找到（WREN_BIN=${wrenBin()}，PATH/路径均不可用）：数据源挂接全部跳过，仅物化 data-query skill 骨架`,
      );
      const specs: WrenDatasourceSpec[] = [
        ...Object.entries(reg).map(([name, e]) => ({
          name,
          datasource: e.datasource,
          connection: e.connection,
          port: e.port,
        })),
        ...seeds.specs,
      ];
      await materializeDataQuerySkill(specs, null);
      return;
    }
    await enqueueWrenOp(async () => {
      try {
        mkdirSync(wrenHome(), { recursive: true });
      } catch {}
      const added = await mergeWrenSeeds(reg, seeds.specs);
      if (added.length > 0) {
        await saveWrenRegistry(reg).catch((err) =>
          console.error(`${WREN_LOG} 注册表写入失败（继续 provision）: ${truncate(String(err))}`),
        );
      }
      const ready: WrenDatasourceSpec[] = [];
      for (const name of Object.keys(reg).sort()) {
        const entry = await this.provision(name, reg[name], bin, { restartDaemon: false });
        reg[name] = entry;
        if (!entry.lastError) {
          ready.push({ name, datasource: entry.datasource, connection: entry.connection, port: entry.port });
        }
        await saveWrenRegistry(reg).catch(() => {});
      }
      await registerWrenMcpServers(ready);
      await materializeDataQuerySkill(ready, bin);
    });
  }

  /** admin 写操作后刷新 data-query skill（幂等；实现见 skill.ts，保留原日志语义）。 */
  async refreshSkill(): Promise<void> {
    await refreshDataQuerySkill();
  }

  /** GET 响应 DTO：connection 脱敏（password 恒为 ******）+ 运行态（state/daemon/models/sync）。 */
  async entryDto(name: string, entry: WrenDsEntry): Promise<Record<string, unknown>> {
    const alive = await isPortListening(entry.port);
    return {
      name,
      datasource: entry.datasource,
      tables: entry.tables,
      port: entry.port,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      state: entry.lastError ? "error" : "ready",
      lastError: entry.lastError,
      daemon: { port: entry.port, alive },
      models: await countWrenModels(name),
      connection: redactConnection(entry.connection),
      // 同步观测字段（§39.2.2；脱敏规则不变——仅连接字段脱敏）
      catalogHash: entry.catalogHash ?? null,
      lastSyncedAt: entry.lastSyncedAt ?? null,
      lastSyncError: entry.lastSyncError ?? null,
    };
  }

  // ---- Template Method 子步（默认实现；子类可覆盖，保持顺序不变） ----

  /** 步骤 1：连接字段 → profile 载荷，并把密钥明文注入进程 env。 */
  protected stepSecrets(name: string, entry: WrenDsEntry): Record<string, unknown> {
    const { payload, secrets } = buildProfilePayloadFor(name, entry.datasource, entry.connection);
    for (const [k, v] of Object.entries(secrets)) process.env[k] = v;
    return payload;
  }

  /** 步骤 2：profiles.yml 登记（已存在跳过；--no-validate 留给查询期校验）。 */
  protected stepProfile(name: string, bin: string, payload: Record<string, unknown>): Promise<boolean> {
    return ensureWrenProfile(bin, name, payload);
  }

  /** 步骤 3a：项目骨架（context init --empty；wren_project.yml 已存在不覆盖）。 */
  protected stepScaffold(name: string, bin: string): Promise<boolean> {
    return ensureWrenSkeleton(bin, name);
  }

  /** 步骤 3b：项目绑定 profile（context set-profile）。 */
  protected async stepBindProfile(name: string, bin: string): Promise<boolean> {
    const bind = await runWrenCommand(
      bin,
      ["context", "set-profile", name, "--path", wrenProjectDir(name)],
      `context set-profile (${name})`,
    );
    return bind.ok;
  }

  /**
   * 步骤 4a：内省 + 增量生成 models（失败非致命：保留空骨架继续 build）。
   * 增量按表指纹（§39.2.2）：指纹一致不落盘（agent enrich 安全），指纹变化只重写结构
   * 并保留 agent 的 description；表消失的网关生成目录随收敛移除，手建 model 永不删。
   * 成功后基线 catalogHash——启动 syncAll 即零 drift，无变化不 build/重启。
   */
  protected async stepIntrospectAndGenerate(name: string, entry: WrenDsEntry, out: WrenDsEntry): Promise<void> {
    try {
      const rows = await introspectWrenDatasource(entry);
      const existing = await readExistingModels(name);
      const plan = planModelWrites({
        existing,
        rows,
        tables: entry.tables,
        catalog: catalogOf(entry),
        omitCatalog: omitsCatalog(entry.datasource),
      });
      await applyModelPlan(name, plan);
      // generatedModels 只收网关生成的 model：旧清单中仍存在的 ∪ 本轮写入
      const surviving = (out.generatedModels ?? []).filter((m) => existing.has(m) && !plan.deletes.includes(m));
      out.generatedModels = [...new Set([...surviving, ...Object.keys(plan.writes)])];
      out.catalogHash = catalogHash(rows);
      console.log(
        `${WREN_LOG} ${name}: 内省完成，${out.generatedModels.length} 个网关 model 在册 ` +
          `（rewrite ${Object.keys(plan.writes).length} / delete ${plan.deletes.length} / keep ${plan.unchanged.length}）`,
      );
    } catch (err) {
      out.lastError = `introspect: ${truncate(String(err))}`;
      console.error(`${WREN_LOG} ${name}: 内省失败（保留空骨架，非致命）: ${truncate(String(err))}`);
    }
  }

  /** 步骤 4b：context build（空模型集也产出 target/mdl.json）。 */
  protected async stepBuild(name: string, bin: string, out: WrenDsEntry): Promise<boolean> {
    const build = await runWrenCommand(
      bin,
      ["context", "build", "--path", wrenProjectDir(name)],
      `context build (${name})`,
    );
    if (!build.ok) {
      out.lastError = out.lastError ?? "context build failed";
      return false;
    }
    return true;
  }

  /** 步骤 5：daemon（restartDaemon=true 先定点杀旧实例；就绪轮询在 ensureWrenDaemon 内）。 */
  protected async stepDaemon(
    name: string,
    entry: WrenDsEntry,
    out: WrenDsEntry,
    bin: string,
    opts?: { restartDaemon?: boolean },
  ): Promise<boolean> {
    if (opts?.restartDaemon) await killWrenDaemonFor(out);
    if (!(await ensureWrenDaemon(bin, name, out))) {
      out.lastError = out.lastError ?? `daemon 未在 ${DAEMON_WAIT_MS}ms 内监听 ${entry.port}`;
      return false;
    }
    return true;
  }

  /** 步骤 6：`wren-<name>` 注册进 global/mcp.json（幂等合并，only-own-key）。 */
  protected stepMcp(name: string, entry: WrenDsEntry): Promise<void> {
    return registerWrenMcpServers([{ name, port: entry.port }]);
  }

  /**
   * 步骤 7/8：skill。单源 provision 默认不物化——保持拆分前语义：启动路径由 ensureAll
   * 在全量 provision 后一次性物化，admin 路由在写操作后调 refreshDataQuerySkill。
   * 留作 Template Method 钩子（子类可覆盖）。
   */
  protected async stepSkill(_out: WrenDsEntry): Promise<void> {}
}

/** 默认实例：保持原自由函数 API（外部 import 零改动）。 */
const defaultWrenService = new WrenService();

export const provisionWrenDatasource = (
  name: string,
  entry: WrenDsEntry,
  bin: string,
  opts?: { restartDaemon?: boolean },
): Promise<WrenDsEntry> => defaultWrenService.provision(name, entry, bin, opts);

export const deprovisionWrenDatasource = (name: string, entry: WrenDsEntry): Promise<void> =>
  defaultWrenService.deprovision(name, entry);

export const ensureWrenDatasources = (): Promise<void> => defaultWrenService.ensureAll();

export const wrenEntryDto = (name: string, entry: WrenDsEntry): Promise<Record<string, unknown>> =>
  defaultWrenService.entryDto(name, entry);
