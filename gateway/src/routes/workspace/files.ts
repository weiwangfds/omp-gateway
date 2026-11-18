/** workspace 文件面（DESIGN §17）：树/索引/读写/raw 流（Range）/上传/mkdir/rename/delete。 */
import type { Hono } from "hono";
import {
  FileGuardError,
  invalidateFileIndex,
  listTree,
  makeDir,
  queryFileIndex,
  readFileContent,
  readFileRaw,
  removePath,
  renamePath,
  resolveInside,
  writeFileBuffer,
  writeFileContent,
} from "../../core/files.ts";
import { audit } from "../../core/tenant-store.ts";
import type { WorkspaceEnv, WorkspaceShared } from "./shared.ts";

/**
 * 信任边界词法预检（第一道快拒）：拒绝含 `..` 段的相对路径，穿越请求不进任何文件 API。
 * 权威守卫仍是 resolveInside / 文件 API 内部的前缀 + realpath 双重校验（core/files.ts）。
 */
function rejectTraversal(rel: string): string {
  if (rel.split(/[\\/]/).includes("..")) throw new FileGuardError(rel);
  return rel;
}

/** 文件面：树/索引/读写/raw 流（Range）/上传/mkdir/rename/delete。 */
export function mountWorkspaceFileRoutes(app: Hono<WorkspaceEnv>, shared: WorkspaceShared): void {
  const { ws, writeGuard, guardErr } = shared;

  // ---- 文件树 / 索引 / 文件读写 ----

  app.get("/:sid/tree", async (c) => {
    const w = ws(c);
    if ("err" in w) return w.err;
    try {
      // 信任边界显式守卫：query param 先过词法预检 + resolveInside（词法前缀 + realpath 双重校验），
      // listTree 内部会再守一次——这里先拒，穿越请求不进文件 API
      const subPath = await resolveInside(w.dir, rejectTraversal(c.req.query("path") ?? "."));
      const out = await listTree(w.dir, {
        subPath,
        depth: Number(c.req.query("depth") ?? 3),
        maxEntries: Number(c.req.query("max") ?? 2000),
        includeHeavy: c.req.query("all") === "1",
      });
      return c.json(out);
    } catch (err) {
      return guardErr(c, err);
    }
  });

  // 扁平文件索引（pi-web file-index 对标：Ctrl+P 式模糊查找；写操作自动失效缓存）
  app.get("/:sid/files/index", async (c) => {
    const w = ws(c);
    if ("err" in w) return w.err;
    try {
      const out = await queryFileIndex(w.dir, c.req.query("q") ?? undefined, {
        limit: Number(c.req.query("limit") ?? 200),
        force: c.req.query("refresh") === "1",
      });
      return c.json(out);
    } catch (err) {
      return guardErr(c, err);
    }
  });

  app.get("/:sid/file", async (c) => {
    const w = ws(c);
    if ("err" in w) return w.err;
    const rel = rejectTraversal(c.req.query("path") ?? "");
    if (!rel) return c.json({ error: { code: "BAD_REQUEST", message: "path query required" } }, 400);
    try {
      // 信任边界显式守卫（同 tree 路由）：readFileContent 内部会再守一次
      await resolveInside(w.dir, rel);
      return c.json({ path: rel, ...(await readFileContent(w.dir, rel)) });
    } catch (err) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
        return c.json({ error: { code: "NOT_FOUND", message: "file not found" } }, 404);
      }
      return guardErr(c, err);
    }
  });

  // 原始字节流（图像/PDF/音视频直接预览；Range 支持拖动/分段）
  app.get("/:sid/file/raw", async (c) => {
    const w = ws(c);
    if ("err" in w) return w.err;
    const rel = rejectTraversal(c.req.query("path") ?? "");
    if (!rel) return c.json({ error: { code: "BAD_REQUEST", message: "path query required" } }, 400);
    try {
      const { buf, contentType, range } = await readFileRaw(w.dir, rel, c.req.header("range"));
      const headers: Record<string, string> = {
        "content-type": contentType,
        "accept-ranges": "bytes",
        "cache-control": "private, max-age=5",
      };
      if (range) {
        headers["content-range"] = `bytes ${range.start}-${range.end}/${range.total}`;
        return (c as any).body(new Uint8Array(buf), 206, headers);
      }
      return (c as any).body(new Uint8Array(buf), 200, headers);
    } catch (err) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
        return c.json({ error: { code: "NOT_FOUND", message: "file not found" } }, 404);
      }
      return guardErr(c, err);
    }
  });

  app.put("/:sid/file", async (c) => {
    const w = ws(c);
    if ("err" in w) return w.err;
    const blocked = writeGuard(c, w.row);
    if (blocked) return blocked;
    const rel = rejectTraversal(c.req.query("path") ?? "");
    const body = await c.req.json().catch(() => null as any);
    if (!rel || typeof body?.content !== "string") {
      return c.json({ error: { code: "BAD_REQUEST", message: "path query and body.content required" } }, 400);
    }
    try {
      const r = await writeFileContent(w.dir, rel, body.content, body.encoding === "base64" ? "base64" : "utf8");
      invalidateFileIndex(w.dir);
      return c.json({ path: rel, ...r });
    } catch (err) {
      return guardErr(c, err);
    }
  });

  // multipart 上传（前端 FormData 直传；field 名 files，目标目录 ?path=）
  app.post("/:sid/files/upload", async (c) => {
    const w = ws(c);
    if ("err" in w) return w.err;
    const blocked = writeGuard(c, w.row);
    if (blocked) return blocked;
    const relDir = rejectTraversal((c.req.query("path") ?? "").replace(/\\/g, "/").replace(/\/+$/, ""));
    try {
      const form = await c.req.parseBody();
      const written: Array<{ name: string; path: string; size: number }> = [];
      for (const [field, value] of Object.entries(form)) {
        if (!(value instanceof File)) continue;
        if (field !== "files" && !field.startsWith("files[")) continue;
        // 净化：仅取 basename，剥离路径与前导点，杜绝穿越与隐藏文件
        const name = (value.name.split(/[\\/]/).pop() ?? "upload.bin").replace(/^\.+/, "") || "upload.bin";
        const rel = relDir ? `${relDir}/${name}` : name;
        const buf = Buffer.from(await value.arrayBuffer());
        const r = await writeFileBuffer(w.dir, rel, buf);
        written.push({ name, path: rel, size: r.size });
      }
      if (!written.length)
        return c.json({ error: { code: "BAD_REQUEST", message: "no files field in multipart body" } }, 400);
      invalidateFileIndex(w.dir);
      audit("workspace.upload", "session", w.row.id, c.get("userId"), { count: written.length });
      return c.json({ written }, 201);
    } catch (err) {
      return guardErr(c, err);
    }
  });

  app.post("/:sid/file/mkdir", async (c) => {
    const w = ws(c);
    if ("err" in w) return w.err;
    const blocked = writeGuard(c, w.row);
    if (blocked) return blocked;
    const body = await c.req.json().catch(() => null as any);
    if (typeof body?.path !== "string")
      return c.json({ error: { code: "BAD_REQUEST", message: "body.path required" } }, 400);
    try {
      await makeDir(w.dir, rejectTraversal(body.path));
      return c.json({ ok: true, path: body.path }, 201);
    } catch (err) {
      return guardErr(c, err);
    }
  });

  app.post("/:sid/file/rename", async (c) => {
    const w = ws(c);
    if ("err" in w) return w.err;
    const blocked = writeGuard(c, w.row);
    if (blocked) return blocked;
    const body = await c.req.json().catch(() => null as any);
    if (typeof body?.from !== "string" || typeof body?.to !== "string") {
      return c.json({ error: { code: "BAD_REQUEST", message: "body.from/body.to required" } }, 400);
    }
    try {
      await renamePath(w.dir, rejectTraversal(body.from), rejectTraversal(body.to));
      invalidateFileIndex(w.dir);
      return c.json({ ok: true, from: body.from, to: body.to });
    } catch (err) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
        return c.json({ error: { code: "NOT_FOUND", message: "source not found" } }, 404);
      }
      return guardErr(c, err);
    }
  });

  app.delete("/:sid/file", async (c) => {
    const w = ws(c);
    if ("err" in w) return w.err;
    const blocked = writeGuard(c, w.row);
    if (blocked) return blocked;
    const rel = rejectTraversal(c.req.query("path") ?? "");
    if (!rel) return c.json({ error: { code: "BAD_REQUEST", message: "path query required" } }, 400);
    try {
      await removePath(w.dir, rel);
      invalidateFileIndex(w.dir);
      return c.json({ ok: true, path: rel });
    } catch (err) {
      return guardErr(c, err);
    }
  });
}
