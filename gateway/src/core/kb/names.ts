/**
 * KB 命名规约（DESIGN §38.2）：所有进入文件路径/SQL 的名字先过这里。
 * slug 用 skill 名规（复用 registry-management 的正则语义），skill 名恒为 `kb-<slug>`；
 * 文档名来自上传 zip 文件名词干，清洗后必须匹配严格白名单（杜绝路径穿越）。
 */

/** skill 名规：小写字母/数字开头，长度 ≤64。 */
export const KB_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** 文档名（目录名 + 主键）：ASCII 白名单，杜绝 `..`/分隔符/控制字符。 */
export const KB_DOC_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class KbNameError extends Error {
  constructor(
    public code: "INVALID_SLUG" | "INVALID_DOC_NAME",
    message: string,
  ) {
    super(message);
  }
}

export const skillNameFor = (slug: string) => `kb-${slug}`;

/** slug 校验：不合规则抛 KbNameError。 */
export function assertSlug(slug: string): void {
  if (!KB_SLUG_RE.test(slug)) throw new KbNameError("INVALID_SLUG", `slug must match ${KB_SLUG_RE.source}`);
}

/**
 * zip 文件名词干 → 文档名：空白折叠为 `-`、越界字符替换为 `-`、前导 `-.` 剥离、超长截断。
 * 清洗后必须非空且匹配白名单（理论上清洗结果恒匹配，兜底防构造输入）。
 */
export function sanitizeDocName(stem: string): string {
  const cleaned = stem
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^[.-]+/, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 128);
  if (!cleaned || !KB_DOC_NAME_RE.test(cleaned)) {
    throw new KbNameError("INVALID_DOC_NAME", `cannot derive doc name from zip stem: ${JSON.stringify(stem)}`);
  }
  return cleaned;
}

/** zip 内成员路径校验：拒绝绝对路径、盘符、UNC、`..` 上跳、反斜杠混用。 */
export function assertSafeZipEntry(entry: string): void {
  if (!entry || entry.endsWith("/")) return; // 目录条目允许
  const norm = entry.replace(/\\/g, "/");
  if (norm !== entry) throw new KbNameError("INVALID_DOC_NAME", `zip entry uses backslash: ${entry}`);
  if (/^[A-Za-z]:/.test(norm) || norm.startsWith("/")) {
    throw new KbNameError("INVALID_DOC_NAME", `zip entry is absolute: ${entry}`);
  }
  for (const seg of norm.split("/")) {
    if (seg === "..") throw new KbNameError("INVALID_DOC_NAME", `zip entry escapes: ${entry}`);
  }
  if (norm.includes("\0")) throw new KbNameError("INVALID_DOC_NAME", `zip entry contains NUL: ${entry}`);
}
