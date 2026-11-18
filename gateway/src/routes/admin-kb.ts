/**
 * KB 管理面（DESIGN §38.4）：/admin/kb/*，组合根模式挂 admin.ts（X-Admin-Id 门禁）。
 *
 * - 建/列/删 KB、zip 透传上传、PDF 补传与预览、分组树、删文档——全部端点见 openapi.ts 登记。
 * - 错误面：KbNameError / KbError / ManagementError 映射 400/404/409；审计 admin.kb.* 前缀。
 * - 上传体上限独立声明（KB_UPLOAD_MAX_MB，默认 2048MB，不借用 /api 的 20MB 全局面限制）；
 *   zip/pdf 均做魔数校验（PK\x03\x04 / %PDF）。
 */
import { Hono } from "hono";
import { config } from "../config.ts";
import { audit } from "../core/tenant-store.ts";
import { requireAdmin } from "../middleware/auth.ts";
import { ManagementError } from "../core/registry-management.ts";
import { assertKbExists, deleteDoc, ingestPdf, ingestZip, KbError, readDocPdf } from "../core/kb/ingest.ts";
import { KbNameError } from "../core/kb/names.ts";
import { kbEmbedRunning, kbEmbedStatus, kbQmdStatusProbe } from "../core/kb/qmd.ts";
import { buildTree, getDoc, openKbDb, removeKbDbFile } from "../core/kb/store.ts";
import { createKb, deleteKbSkillDir, getKbTitle, listKbs } from "../core/kb/skill.ts";

export const kbAdminApp = new Hono();
kbAdminApp.use("*", requireAdmin);

const actor = (c: any): string => c.get("adminId") ?? "admin";

/** 错误映射：KbNameError → 400；KbError → 400/404/409；ManagementError → 400/404/409。 */
const mgmtErr = (c: any, err: unknown) => {
  if (err instanceof KbNameError) return c.json({ error: { code: err.code, message: err.message } }, 400);
  if (err instanceof KbError) {
    const status = err.code === "INVALID_ZIP" ? 400 : err.code === "ALREADY_EXISTS" ? 409 : 404;
    return c.json({ error: { code: err.code, message: err.message } }, status);
  }
  if (err instanceof ManagementError) {
    const status = err.code === "NOT_FOUND" ? 404 : err.code === "ALREADY_EXISTS" ? 409 : 400;
    return c.json({ error: { code: err.code, message: err.message } }, status);
  }
  console.error("[admin-kb]", err);
  return c.json({ error: { code: "INTERNAL", message: "kb operation failed" } }, 500);
};

/** 上传体上限（KB_UPLOAD_MAX_MB）：按 content-length 先拒，413 PAYLOAD_TOO_LARGE。 */
const uploadTooLarge = (c: any): boolean => {
  const maxBytes = config.kbUploadMaxMb * 1024 * 1024;
  const len = Number(c.req.header("content-length") ?? 0);
  return len > maxBytes;
};

const tooLargeResp = (c: any) =>
  c.json(
    { error: { code: "PAYLOAD_TOO_LARGE", message: `body exceeds KB_UPLOAD_MAX_MB=${config.kbUploadMaxMb}` } },
    413,
  );

/** 从 multipart 取上传文件：优先具名字段，缺省回落第一个 File。 */
const pickFile = (form: Record<string, unknown>, field: string): File | null => {
  const named = form[field];
  if (named instanceof File) return named;
  for (const v of Object.values(form)) if (v instanceof File) return v;
  return null;
};

const formStr = (form: Record<string, unknown>, field: string): string | null => {
  const v = form[field];
  return typeof v === "string" ? v : null;
};

// ---- KB 生命周期 ----

/** 建 KB：skill 骨架（SKILL.md/kb.json/docs/scripts/assets）+ kb.db。 */
kbAdminApp.post("/", async (c) => {
  const body = await c.req.json().catch(() => null as any);
  const slug = typeof body?.slug === "string" ? body.slug : "";
  const title = typeof body?.title === "string" ? body.title : undefined;
  try {
    const meta = await createKb(slug, title);
    audit("admin.kb.create", "kb", meta.slug, actor(c), { title: meta.title });
    return c.json({ ok: true, ...meta }, 201);
  } catch (err) {
    return mgmtErr(c, err);
  }
});

/** KB 列表：扫 global/skills/kb-*（读 kb.json + 各自 kb.db 的 docs 计数）。 */
kbAdminApp.get("/", async (c) => c.json({ kbs: await listKbs() }));

/** 删 KB：skill 目录 + kb.db（含 -wal/-shm）；workspace 残留 junction 由下次合成清理。 */
kbAdminApp.delete("/:slug", async (c) => {
  const slug = c.req.param("slug");
  try {
    await assertKbExists(slug); // KB_NOT_FOUND → 404
    await removeKbDbFile(slug);
    await deleteKbSkillDir(slug);
    audit("admin.kb.delete", "kb", slug, actor(c));
    return c.json({ ok: true, slug });
  } catch (err) {
    return mgmtErr(c, err);
  }
});

// ---- 文档：上传 / 补传 PDF / 预览 / 删除 ----

/** zip 上传（一包一文档，MinerU default 档位）；表单 group=A/B/C（缺省归根）。 */
kbAdminApp.post("/:slug/upload", async (c) => {
  if (uploadTooLarge(c)) return tooLargeResp(c);
  const slug = c.req.param("slug");
  try {
    const form = (await c.req.parseBody()) as Record<string, unknown>;
    const zipFile = pickFile(form, "zip");
    if (!zipFile) return c.json({ error: { code: "BAD_REQUEST", message: "zip file field required" } }, 400);
    const bytes = new Uint8Array(await zipFile.arrayBuffer());
    // 魔数校验：PK\x03\x04
    if (!(bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04)) {
      return c.json({ error: { code: "INVALID_ZIP", message: "not a zip file (bad magic)" } }, 400);
    }
    const r = await ingestZip(slug, bytes, zipFile.name, formStr(form, "group"));
    audit("admin.kb.upload", "kb", slug, actor(c), { doc: r.doc, group: r.group, bytes: r.bytes });
    return c.json({ ok: true, ...r }, 201);
  } catch (err) {
    return mgmtErr(c, err);
  }
});

/** PDF 补传：表单 doc=<文档名> + pdf 文件 → docs/<doc>/source.pdf，has_pdf=1。 */
kbAdminApp.post("/:slug/pdf", async (c) => {
  if (uploadTooLarge(c)) return tooLargeResp(c);
  const slug = c.req.param("slug");
  try {
    const form = (await c.req.parseBody()) as Record<string, unknown>;
    const doc = formStr(form, "doc") ?? "";
    if (!doc) return c.json({ error: { code: "BAD_REQUEST", message: "form field doc required" } }, 400);
    const pdfFile = pickFile(form, "pdf");
    if (!pdfFile) return c.json({ error: { code: "BAD_REQUEST", message: "pdf file field required" } }, 400);
    const bytes = new Uint8Array(await pdfFile.arrayBuffer());
    // 魔数校验：%PDF
    if (!(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) {
      return c.json({ error: { code: "INVALID_ZIP", message: "not a pdf file (bad magic)" } }, 400);
    }
    const r = await ingestPdf(slug, doc, bytes);
    audit("admin.kb.pdf", "kb", slug, actor(c), { doc: r.doc, bytes: r.bytes });
    return c.json({ ok: true, slug, ...r }, 201);
  } catch (err) {
    return mgmtErr(c, err);
  }
});

/** 前端取原始 PDF（application/pdf 原文件）。 */
kbAdminApp.get("/:slug/pdf/:doc", async (c) => {
  const slug = c.req.param("slug");
  const doc = c.req.param("doc");
  try {
    await assertKbExists(slug);
    const d = openKbDb(slug);
    if (!getDoc(d, doc)) throw new KbError("DOC_NOT_FOUND", `doc not found: ${doc}`);
    const buf = await readDocPdf(slug, doc);
    return c.body(new Uint8Array(buf), 200, {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${doc}.pdf"`,
    });
  } catch (err) {
    return mgmtErr(c, err);
  }
});

/** 分组树 + 文档卡片（复用 store.buildTree；未分组文档挂根部 docs）。 */
kbAdminApp.get("/:slug/tree", async (c) => {
  const slug = c.req.param("slug");
  try {
    await assertKbExists(slug);
    const tree = buildTree(openKbDb(slug));
    return c.json({ slug, title: await getKbTitle(slug), ...tree });
  } catch (err) {
    return mgmtErr(c, err);
  }
});

/**
 * 语义索引状态（DESIGN §38.12）：update（BM25）在上传响应内已完成；embed（向量）后台跑，
 * 这里给出最近一次后台构建状态。`?probe=1` 时额外读一次 `qmd status` 的待嵌入计数。
 * 状态存进程内：网关重启后回到 idle，真实进度以 probe 为准。
 */
kbAdminApp.get("/:slug/index-status", async (c) => {
  const slug = c.req.param("slug");
  try {
    await assertKbExists(slug);
    const embed = kbEmbedStatus(slug);
    const inFlight = kbEmbedRunning().includes(slug); // Map key 是 slug（非 skill 名）
    const probe = c.req.query("probe") === "1" ? await kbQmdStatusProbe() : null;
    return c.json({ slug, update: "sync-on-ingest", embed: { ...embed, inFlight }, probe });
  } catch (err) {
    return mgmtErr(c, err);
  }
});

/** 删文档：db 行 + 目录联动。 */
kbAdminApp.delete("/:slug/doc/:doc", async (c) => {
  const slug = c.req.param("slug");
  const doc = c.req.param("doc");
  try {
    await assertKbExists(slug);
    await deleteDoc(slug, doc);
    audit("admin.kb.doc.delete", "kb", slug, actor(c), { doc });
    return c.json({ ok: true, slug, doc });
  } catch (err) {
    return mgmtErr(c, err);
  }
});
