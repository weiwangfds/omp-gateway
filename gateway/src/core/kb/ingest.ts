/**
 * KB 语料入库（DESIGN §38.1/§38.4）：MinerU ParseOutcome（default 档位）zip 透传。
 *
 * - 一包一文档：markdown.md（改名 <doc>.md，语料本体）+ middle_json.json（页数来源）+
 *   structured_content.json + images/ 全部透传落 docs/<doc>/，保持子目录结构。
 * - 页码索引：md 不含页码，入库时按页生成 pages.txt（页码 → 该页首段摘录），agent 引用「p.N」的锚点。
 * - 同名重传 = 先清旧目录再落（覆盖更新）；db 登记 upsertDoc。
 * - zip 条目逐个过 assertSafeZipEntry（zip-slip 词法防护），落盘前再过 safeJoin（边界复核）；
 *   2GB 内全内存解压（fflate unzipSync），路由层有 KB_UPLOAD_MAX_MB 兜底。
 * - 原始 PDF 不在 zip 里，走 ingestPdf 独立补传（source.pdf，has_pdf=1）。
 * - 语料落库后先同步 `qmd update`（BM25 秒级可用），再后台异步 `qmd embed`（语义索引补齐）；
 *   qmd 未装/失败仅告警，不阻塞入库（DESIGN §38.12，M30：上传响应不等向量嵌入）。
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";
import { globalSkillsDir } from "../paths.ts";
import { assertSafeZipEntry, assertSlug, KB_DOC_NAME_RE, sanitizeDocName, skillNameFor } from "./names.ts";
import { kbQmdUpdate, scheduleKbQmdEmbed } from "./qmd.ts";
import { deleteDocRow, ensureGroup, getDoc, openKbDb, setDocHasPdf, upsertDoc } from "./store.ts";

/** KB 业务错误：路由层按 code 映射 400（INVALID_ZIP）/ 404（*_NOT_FOUND）/ 409（ALREADY_EXISTS）。 */
export type KbErrorCode = "INVALID_ZIP" | "DOC_NOT_FOUND" | "KB_NOT_FOUND" | "ALREADY_EXISTS";

export class KbError extends Error {
  constructor(
    public code: KbErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * 边界守卫的 join：resolve 生成目标后校验必须落在根内
 * （target === root 或 target.startsWith(root + path.sep)）。
 * 入参都已过白名单（slug/doc 名规、zip 条目 assertSafeZipEntry），这里是落盘前的二次兜底。
 */
function safeJoin(root: string, ...segments: string[]): string {
  const base = path.resolve(root);
  const target = path.resolve(base, ...segments);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new KbError("INVALID_ZIP", `path escapes kb directory: ${target}`);
  }
  return target;
}

/** KB skill 目录（skill.ts 亦用；放这里避免循环 import）。 */
export const kbSkillDir = (slug: string) => path.join(globalSkillsDir(), skillNameFor(slug));

/** KB 必须已建（含 kb.json），否则 KB_NOT_FOUND——GET/写路径都先过这里。 */
export async function assertKbExists(slug: string): Promise<void> {
  assertSlug(slug);
  if (!(await fs.exists(safeJoin(kbSkillDir(slug), "kb.json")))) {
    throw new KbError("KB_NOT_FOUND", `kb not found: ${slug}`);
  }
}

/** 分组段规约：Unicode 字母/数字开头（允许中文分组名），≤64 字符；'/' 分隔（物化路径 A/B/C）。
 * 分组只进树展示与 kb.db，不参与文件路径构造，放宽到 \p{L}\p{N} 安全。 */
const GROUP_SEG_RE = /^[\p{L}\p{N}][\p{L}\p{N}._ -]{0,63}$/u;

/** 表单 group 字段 → 物化路径（null=归根）；空段剔除，非法段抛 INVALID_ZIP（→400）。 */
export function normalizeGroupPath(group: string | null | undefined): string | null {
  if (!group) return null;
  const segs = group
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!segs.length) return null;
  for (const s of segs) {
    if (!GROUP_SEG_RE.test(s)) throw new KbError("INVALID_ZIP", `invalid group segment: ${JSON.stringify(s)}`);
  }
  return segs.join("/");
}

export interface IngestResult {
  slug: string;
  doc: string;
  group: string | null;
  pages: number;
  images: number;
  mdSha256: string;
  bytes: number;
}

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** 从块对象里尽力抽取可读文本（兼容合成 middle/content_list 与 MinerU 原生 lines/spans 两种形状）。 */
function blockText(block: unknown): string {
  if (!block || typeof block !== "object") return "";
  const o = block as Record<string, unknown>;
  if (typeof o.text === "string" && o.text.trim()) return o.text.trim();
  if (typeof o.content === "string" && o.content.trim()) return o.content.trim();
  const parts: string[] = [];
  const pushStr = (v: unknown) => {
    if (typeof v === "string" && v.trim()) parts.push(v.trim());
  };
  for (const key of ["content", "spans", "lines"] as const) {
    const arr = o[key];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (typeof item === "string") pushStr(item);
      else if (item && typeof item === "object") {
        const io = item as Record<string, unknown>;
        pushStr(io.content);
        pushStr(io.text);
        if (Array.isArray(io.spans))
          for (const sp of io.spans) {
            if (sp && typeof sp === "object") pushStr((sp as Record<string, unknown>).content);
            else pushStr(sp);
          }
      }
    }
  }
  for (const key of ["table_caption", "image_caption", "table_body"] as const) {
    const v = o[key];
    if (Array.isArray(v)) for (const s of v) pushStr(s);
  }
  return parts.join(" ").trim();
}

/** 从 middle_json（优先）或 structured_content 生成页索引文本；无可用数据 → null。 */
function buildPageIndexText(middle: ZipEntry | undefined, structured: ZipEntry | undefined): string | null {
  const decode = (e: ZipEntry | undefined): unknown => {
    if (!e || e.data.length > 96 * 1024 * 1024) return null;
    try {
      return JSON.parse(new TextDecoder().decode(e.data));
    } catch {
      return null;
    }
  };
  const pickRows = (root: unknown): Array<{ page: number; blocks: unknown[] }> | null => {
    if (!root || typeof root !== "object") return null;
    const o = root as Record<string, unknown>;
    if (Array.isArray(o.pdf_info)) {
      return (o.pdf_info as Array<Record<string, unknown>>).map((p, i) => ({
        page: Number.isInteger(p?.page_idx) ? Number(p.page_idx) + 1 : i + 1,
        blocks: (Array.isArray(p?.para_blocks) ? p.para_blocks : Array.isArray(p?.blocks) ? p.blocks : []) as unknown[],
      }));
    }
    if (Array.isArray(o.content)) {
      const byPage = new Map<number, unknown[]>();
      for (const it of o.content as Array<Record<string, unknown>>) {
        const page = Number.isInteger(it?.page_idx) ? Number(it.page_idx) + 1 : 1;
        const list = byPage.get(page) ?? [];
        list.push(it);
        byPage.set(page, list);
      }
      if (!byPage.size) return null;
      const maxPage = Math.max(...byPage.keys());
      return Array.from({ length: maxPage }, (_, i) => ({ page: i + 1, blocks: byPage.get(i + 1) ?? [] }));
    }
    return null;
  };

  const rows = pickRows(decode(middle)) ?? pickRows(decode(structured));
  if (!rows?.length) return null;

  /** 该页页脚/页码块的数字（印刷页码）；无 → 空。JEDEC 类文档印刷页与 PDF 物理页常有固定偏移。 */
  const printedPageNo = (blocks: unknown[]): string => {
    for (const b of blocks) {
      if (!b || typeof b !== "object") continue;
      const o = b as Record<string, unknown>;
      const type = String(o.type ?? "");
      if (type !== "page_number" && type !== "footer" && type !== "page_footnote") continue;
      const m = String(o.text ?? "").match(/\d+/);
      if (m) return String(Number(m[0]));
    }
    return "";
  };

  const lines: string[] = [
    "# 页索引（三列制表符分隔：PDF 物理页 / 印刷页码（文档页脚或目录标注，可为空）/ 该页首段摘录）",
    "# 引用约定：回答里「文档名 p.N」优先用**印刷页码**（读者在文档目录/正文交叉引用里看到的页码）；",
    "# 需要按 PDF 阅读器跳页时用物理页（第 1 列）。二者不总相等（JEDEC 类文档常见固定偏移，如差 32 页）。",
    "",
  ];
  let filled = 0;
  for (const r of rows) {
    let excerpt = "";
    for (const b of r.blocks) {
      const t = blockText(b).replace(/\s+/g, " ");
      if (t.length >= 8) {
        excerpt = t.slice(0, 120);
        break;
      }
    }
    if (excerpt) filled++;
    lines.push(`${r.page}\t${printedPageNo(r.blocks)}\t${excerpt}`);
  }
  return filled ? `${lines.join("\n")}\n` : null;
}

/**
 * zip 透传入库：解包 → 剥单一顶层前缀 → 逐条 zip-slip 校验 → 落 docs/<doc>/ → 登记 kb.db。
 * zipFilename 的词干清洗为文档名；同名重传先清旧目录（覆盖更新）。
 */
export async function ingestZip(
  slug: string,
  bytes: Uint8Array,
  zipFilename: string,
  group?: string | null,
): Promise<IngestResult> {
  assertSlug(slug);
  await assertKbExists(slug);
  const doc = sanitizeDocName(zipFilename.replace(/\.zip$/i, ""));

  const unzipped = unzipSync(bytes);
  const fileNames = Object.keys(unzipped).filter((n) => !n.endsWith("/"));
  // 所有条目共享单一顶层前缀目录（MinerU 打包常见 doc-name/ 头）→ 剥掉
  let prefix = "";
  const tops = new Set(fileNames.map((n) => n.split("/")[0]));
  if (fileNames.length && tops.size === 1 && fileNames.every((n) => n.includes("/"))) {
    prefix = `${[...tops][0]}/`;
  }
  const entries: ZipEntry[] = fileNames.map((n) => ({
    name: prefix && n.startsWith(prefix) ? n.slice(prefix.length) : n,
    data: unzipped[n],
  }));
  if (!entries.some((e) => e.name === "markdown.md")) {
    throw new KbError("INVALID_ZIP", "zip must contain markdown.md (MinerU default profile)");
  }
  for (const e of entries) assertSafeZipEntry(e.name);

  const md = entries.find((e) => e.name === "markdown.md")!;
  const mdSha256 = createHash("sha256").update(md.data).digest("hex");

  // 页数来自 middle_json.json 的 pdf_info（解析失败不阻塞，pages=0）
  let pages = 0;
  const mj = entries.find((e) => e.name === "middle_json.json");
  if (mj) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(mj.data)) as { pdf_info?: unknown[] };
      pages = Array.isArray(parsed.pdf_info) ? parsed.pdf_info.length : 0;
    } catch {}
  }
  const images = entries.filter((e) => e.name.startsWith("images/")).length;

  // 同名覆盖：先清旧目录再落（断链避免重传后残留旧文件）
  const docDir = safeJoin(kbSkillDir(slug), "docs", doc);
  await fs.rm(docDir, { recursive: true, force: true });

  for (const e of entries) {
    const target = safeJoin(docDir, ...e.name.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, e.data);
  }
  // markdown.md → <doc>.md：images/ 相对引用保持有效（同级目录名不变）
  await fs.rename(safeJoin(docDir, "markdown.md"), safeJoin(docDir, `${doc}.md`));

  // 页索引（pages.txt）：md 不含页码，agent 引用「p.N」需要一个确定性锚点表。
  const pageIndex = buildPageIndexText(
    mj,
    entries.find((e) => e.name === "structured_content.json"),
  );
  if (pageIndex) await fs.writeFile(safeJoin(docDir, "pages.txt"), pageIndex, "utf8");

  const groupPath = normalizeGroupPath(group);
  const d = openKbDb(slug);
  upsertDoc(d, { name: doc, groupId: ensureGroup(d, groupPath), mdSha256, pages, images });

  // 索引构建：update（BM25）同步等——返回 201 时关键词检索已含本文档；
  // embed（向量）转后台单飞异步——分钟级任务不等在请求里（见 qmd.ts 的说明）。
  await kbQmdUpdate();
  scheduleKbQmdEmbed(slug);

  return { slug, doc, group: groupPath, pages, images, mdSha256, bytes: bytes.length };
}

/** PDF 补传：doc 必须已存在；写 docs/<doc>/source.pdf 并置 has_pdf=1。 */
export async function ingestPdf(slug: string, doc: string, bytes: Uint8Array): Promise<{ doc: string; bytes: number }> {
  assertSlug(slug);
  await assertKbExists(slug);
  if (!KB_DOC_NAME_RE.test(doc)) throw new KbError("DOC_NOT_FOUND", `doc not found: ${doc}`);
  const d = openKbDb(slug);
  if (!getDoc(d, doc)) throw new KbError("DOC_NOT_FOUND", `doc not found: ${doc}`);
  const dir = safeJoin(kbSkillDir(slug), "docs", doc);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(safeJoin(dir, "source.pdf"), bytes);
  setDocHasPdf(d, doc, 1);
  // PDF 不影响语料文本，无需重建索引
  return { doc, bytes: bytes.length };
}

/** 删文档：db 行 + 目录联动（任一缺失仍兜底清理；行不存在 → DOC_NOT_FOUND）。 */
export async function deleteDoc(slug: string, doc: string): Promise<void> {
  assertSlug(slug);
  await assertKbExists(slug); // 与 ingestZip/ingestPdf 一致：不存在的 KB 直接 404，openKbDb({create:true}) 不凭空建库
  if (!KB_DOC_NAME_RE.test(doc)) throw new KbError("DOC_NOT_FOUND", `doc not found: ${doc}`);
  const d = openKbDb(slug);
  if (!deleteDocRow(d, doc)) throw new KbError("DOC_NOT_FOUND", `doc not found: ${doc}`);
  await fs.rm(safeJoin(kbSkillDir(slug), "docs", doc), { recursive: true, force: true });
  await kbQmdUpdate(); // 语料变更后同步重建 BM25 索引（含被删文档的清理）
  scheduleKbQmdEmbed(slug); // 向量索引后台补齐（qmd embed 会顺手清理悬空向量）
}

/** 读文档的 source.pdf 原始字节（tree 卡片之外的前端预览通道）；缺 → DOC_NOT_FOUND。 */
export async function readDocPdf(slug: string, doc: string): Promise<Buffer> {
  assertSlug(slug);
  if (!KB_DOC_NAME_RE.test(doc)) throw new KbError("DOC_NOT_FOUND", `doc not found: ${doc}`);
  const file = safeJoin(kbSkillDir(slug), "docs", doc, "source.pdf");
  const buf = await fs.readFile(file).catch(() => null);
  if (!buf) throw new KbError("DOC_NOT_FOUND", `source.pdf not uploaded for doc: ${doc}`);
  return buf;
}
