/**
 * 环境迁移（DESIGN §32）：export 打包一致 bundle，import 应用到目标环境。
 * 两个操作互斥（模块级 busy 标记）。
 *
 * 导出：drain → dispose 全部 live 会话（文件树静默，与 DB 快照对齐）→ VACUUM INTO +
 * users/ + global/ + manifest.json（sha256 / 计数 / 文件清单）。
 *
 * 导入：manifest + sha256 校验 → 静默本实例 → **复制覆盖**（不 rename 目录：
 * Windows 绑定挂载上目录 rename 会 EACCES）→ 按 manifest 文件清单删掉本地多余文件 →
 * 换 gateway.db → 重开库 → 计数对账。导入前的环境先复制到 <dataRoot>.bak-<ts> 备查。
 *
 * bundle 内路径为相对路径（INV-1），导入实例的 GATEWAY_DATA_ROOT 位置可以不同。
 */
import { Hono } from "hono";
import * as fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.ts";
import { registry } from "../core/session-registry.ts";
import { backupToFile, closeDb, collectCounts, reopenDb, SCHEMA_VERSION } from "../core/store/db.ts";
import { audit } from "../core/tenant-store.ts";
import { disposeSession } from "../core/session-factory.ts";
import { draining } from "../middleware/auth.ts";

type Env = { Variables: { userId: string } };

export const maintenanceApp = new Hono<Env>();

/** 慢操作互斥（export/import 不能并发）。 */
let busy = false;

const MANIFEST_VERSION = 1;

async function sha256File(file: string): Promise<string> {
  const buf = await Bun.file(file).bytes();
  return new Bun.CryptoHasher("sha256").update(buf).digest("hex");
}

/**
 * drain 并释放全部 live 会话（导出/导入都需要文件树静默）。
 * 返回调用前的 drain 状态，调用方在结束时恢复（失败路径不能把网关永久留在排空态）。
 */
async function quiesce(): Promise<boolean> {
  const wasDraining = draining.value;
  draining.value = true;
  for (const ctx of [...registry.values()]) {
    await disposeSession(ctx).catch(() => {});
  }
  const deadline = Date.now() + 10_000;
  while ([...registry.values()].length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return wasDraining;
}

function assertInsideRoot(root: string, target: string): string {
  const resolved = path.resolve(target);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`path escapes allowed root: ${target}`);
  }
  return resolved;
}

/** 递归列出目录下的全部文件（相对 POSIX 路径），用于 manifest 文件清单与差集删除。 */
async function listFilesRel(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFilesRel(path.join(dir, e.name), rel)));
    else out.push(rel);
  }
  return out;
}

// ---- 导出：POST /internal/maintenance/export ----
maintenanceApp.post("/export", async (c) => {
  if (busy) return c.json({ error: { code: "MAINTENANCE_BUSY", message: "another export/import is running" } }, 409);
  busy = true;
  let wasDraining = false;
  try {
    wasDraining = await quiesce();

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const bundle = path.join(config.exportDir, `export-${stamp}`);
    await fs.mkdir(bundle, { recursive: true });

    // 1) DB 一致性快照（WAL 下 VACUUM INTO 自带锁语义，无需停写——但树已静默）
    const dbPath = path.join(bundle, "gateway.db");
    await backupToFile(dbPath);

    // 2) 文件树（users/ + global/）
    await fs.cp(path.join(config.dataRoot, "users"), path.join(bundle, "users"), { recursive: true });
    await fs.cp(path.join(config.dataRoot, "global"), path.join(bundle, "global"), { recursive: true });

    // 3) manifest（对账计数 + db 校验和 + 文件清单）
    const counts = collectCounts();
    const files = [
      ...(await listFilesRel(path.join(bundle, "users"))).map((f) => `users/${f}`),
      ...(await listFilesRel(path.join(bundle, "global"))).map((f) => `global/${f}`),
    ].sort();
    const manifest = {
      formatVersion: MANIFEST_VERSION,
      dbSchemaVersion: SCHEMA_VERSION,
      gatewayVersion: "0.2.0",
      exportedAt: new Date().toISOString(),
      sourceDataRoot: config.dataRoot, // 仅信息（INV-1：导入端不依赖）
      counts,
      files,
      sha256: await sha256File(dbPath),
    };
    await fs.writeFile(path.join(bundle, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    audit("maintenance.export", "bundle", bundle, "system", { counts });
    if (c.req.query("keepDrained") !== "1") draining.value = wasDraining;
    return c.json(
      {
        bundlePath: bundle,
        manifest,
        note: "live sessions were disposed for consistency; clients reconnect via bootstrap/revive",
      },
      202,
    );
  } catch (err) {
    draining.value = wasDraining;
    return c.json({ error: { code: "EXPORT_FAILED", message: err instanceof Error ? err.message : String(err) } }, 500);
  } finally {
    busy = false;
  }
});

// ---- 导入：POST /internal/maintenance/import ----
maintenanceApp.post("/import", async (c) => {
  if (busy) return c.json({ error: { code: "MAINTENANCE_BUSY", message: "another export/import is running" } }, 409);
  busy = true;
  let wasDraining = false;
  try {
    const body = await c.req.json().catch(() => ({}) as any);
    if (body?.confirm !== "REPLACE") {
      return c.json({ error: { code: "CONFIRM_REQUIRED", message: 'body.confirm must be "REPLACE"' } }, 400);
    }
    const raw = String(body?.path ?? "");
    const allowed = [...config.importDirs, config.backupDir ?? ""].filter(Boolean);
    let bundle: string | null = null;
    for (const root of allowed) {
      try {
        bundle = assertInsideRoot(root, raw);
        break;
      } catch {
        // 尝试下一个 allowlist 根
      }
    }
    if (!bundle) {
      return c.json(
        { error: { code: "PATH_FORBIDDEN", message: `bundle path must be inside one of: ${allowed.join(", ")}` } },
        403,
      );
    }

    // 1) manifest + 校验和
    let manifest: any;
    try {
      manifest = JSON.parse(await fs.readFile(path.join(bundle, "manifest.json"), "utf8"));
    } catch {
      return c.json({ error: { code: "MANIFEST_INVALID", message: "manifest.json missing or unparsable" } }, 400);
    }
    if (manifest?.formatVersion !== MANIFEST_VERSION) {
      return c.json(
        { error: { code: "MANIFEST_INVALID", message: `formatVersion ${manifest?.formatVersion} unsupported` } },
        400,
      );
    }
    if (manifest?.dbSchemaVersion > SCHEMA_VERSION) {
      return c.json(
        {
          error: {
            code: "SCHEMA_VERSION_MISMATCH",
            message: `bundle schema ${manifest.dbSchemaVersion} > supported ${SCHEMA_VERSION}`,
          },
        },
        400,
      );
    }
    const bundleDb = path.join(bundle, "gateway.db");
    if ((await sha256File(bundleDb)) !== manifest.sha256) {
      return c.json({ error: { code: "BUNDLE_INCOMPLETE", message: "gateway.db sha256 mismatch" } }, 400);
    }
    for (const dir of ["users", "global"]) {
      const st = await fs.stat(path.join(bundle, dir)).catch(() => null);
      if (!st?.isDirectory()) {
        return c.json({ error: { code: "BUNDLE_INCOMPLETE", message: `bundle missing ${dir}/` } }, 400);
      }
    }

    // 2) 静默本实例（导入期间拒绝新会话，live 全部释放）
    wasDraining = await quiesce();

    // 3) 备份当前环境（复制而非移动：目录 rename 在 Windows 绑定挂载上不可靠，
    //    且移动失败时的回滚会误删源目录）
    const bakDir = `${config.dataRoot}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await fs.mkdir(bakDir, { recursive: true });
    for (const name of ["users", "global"]) {
      const src = path.join(config.dataRoot, name);
      if (await fs.stat(src).catch(() => null)) {
        await fs.cp(src, path.join(bakDir, name), { recursive: true });
      }
    }
    for (const name of ["gateway.db", "gateway.db-wal", "gateway.db-shm"]) {
      const src = path.join(config.dataRoot, name);
      if (await fs.stat(src).catch(() => null)) {
        await fs.cp(src, path.join(bakDir, name));
      }
    }

    // 4) 应用 bundle：复制覆盖（不 rename 目录）
    closeDb();
    for (const dir of ["users", "global"]) {
      await fs.cp(path.join(bundle, dir), path.join(config.dataRoot, dir), { recursive: true, force: true });
    }
    // 4b) 删掉 bundle 中不存在的本地文件（bundle 为权威）
    const bundleFiles = new Set<string>(Array.isArray(manifest.files) ? manifest.files.map(String) : []);
    const removed: string[] = [];
    if (bundleFiles.size > 0) {
      for (const dir of ["users", "global"]) {
        const local = await listFilesRel(path.join(config.dataRoot, dir));
        for (const rel of local) {
          if (bundleFiles.has(`${dir}/${rel}`)) continue;
          await fs.rm(path.join(config.dataRoot, dir, ...rel.split("/")), { force: true }).catch(() => {});
          removed.push(`${dir}/${rel}`);
        }
      }
    }
    // 4c) 换库（closeDb 后 -wal/-shm 必须一起删，否则 SQLite 会读到旧 WAL）
    for (const name of ["gateway.db", "gateway.db-wal", "gateway.db-shm"]) {
      await fs.rm(path.join(config.dataRoot, name), { force: true }).catch(() => {});
    }
    await fs.copyFile(bundleDb, path.join(config.dataRoot, "gateway.db"));
    reopenDb();

    // 5) 对账
    const counts = collectCounts();
    for (const [k, v] of Object.entries(manifest.counts ?? {})) {
      if (counts[k] !== v) throw new Error(`count mismatch after import: ${k}=${counts[k]} expected ${v}`);
    }

    audit("maintenance.import", "bundle", bundle, "system", { counts });
    draining.value = wasDraining;
    return c.json({
      ok: true,
      counts,
      restoredFrom: manifest.exportedAt,
      backupDir: bakDir,
      removedFiles: removed.length,
      note: "previous environment copied to backupDir for manual rollback; delete it after verification",
    });
  } catch (err) {
    draining.value = wasDraining;
    return c.json({ error: { code: "IMPORT_FAILED", message: err instanceof Error ? err.message : String(err) } }, 500);
  } finally {
    busy = false;
  }
});
