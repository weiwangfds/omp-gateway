/** HTTP 层小工具：JSON 解析 + 结构化/原文分流（兼容把原文标成 application/json 的旧客户端）。 */
import { ConfigCodecError } from "./errors.ts";

/** `c.req.json()` 的严格包装：语法错误映射为 INVALID_JSON。 */
export async function readJsonBody(c: any): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ConfigCodecError("INVALID_JSON", "request body must be valid JSON");
  }
}

/** JSON.parse 的严格包装：语法错误 → INVALID_JSON。 */
export function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ConfigCodecError("INVALID_JSON", "request body is not valid JSON");
  }
}

/**
 * 结构化 vs 原文分流（DESIGN §30 的兼容点）：
 * 历史客户端把 YAML/Markdown 原文也标成 application/json（测试与早期 Python 客户端如此），
 * 因此仅当「JSON 内容类型 + 正文以 {/[ 开头」才走结构化；否则按原文处理。
 * `?format=json|yaml|markdown` 可显式覆盖。
 */
/** 判定本次请求走结构化通道还是原文通道（见上方兼容说明）。 */
export function isStructuredBody(c: any, text: string): boolean {
  const fmt = c.req.query("format");
  if (fmt === "json") return true;
  if (fmt === "yaml" || fmt === "markdown" || fmt === "text") return false;
  const ct = (c.req.header("content-type") ?? "").toLowerCase();
  const isJsonCt = ct.includes("application/json") || ct.includes("+json");
  return isJsonCt && /^\s*[[{]/.test(text);
}
