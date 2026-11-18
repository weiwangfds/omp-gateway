/**
 * model metadata.yml 行扫描解析器（v3/M34，DESIGN §39.2.2）：只认网关生成的固定格式
 * （name / properties.{description,gateway_generated,table_fingerprint} / table_reference /
 * columns），**不引 YAML 库**。解析失败（agent 大改结构）→ 返回 null，调用方视为
 * 非网关生成跳过不动（增量安全缺省）。
 */

/** 生成的 properties.description 占位文案前缀（以此开头 = 未 enrich；也是 M33 旧文件的识别特征）。 */
export const GENERATED_DESCRIPTION_PREFIX = "网关内省自动生成（";

export interface ParsedModelMeta {
  /** 顶层 name（解析不到 → 整体返回 null） */
  name: string;
  /** properties.gateway_generated（含 M33 旧文件识别；缺省 false） */
  gatewayGenerated: boolean;
  /** properties.table_fingerprint（缺省/解析不到 → null = 未知，按指纹已变处理） */
  fingerprint: string | null;
  /** properties.description（未加引号/缺省 → null） */
  description: string | null;
}

/** 反向解一个我们生成的双引号字符串（含 \ " \n \r \t \uXXXX）；未知转义 → null（解析失败）。 */
function unquoteYamlString(s: string): string | null {
  const t = s.trim();
  if (t === "") return null;
  if (!(t.length >= 2 && t.startsWith('"') && t.endsWith('"'))) return t; // 非引号标量：原样
  let out = "";
  for (let i = 1; i < t.length - 1; i++) {
    const ch = t[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const n = t[++i];
    if (n === "n") out += "\n";
    else if (n === "t") out += "\t";
    else if (n === "r") out += "\r";
    else if (n === '"') out += '"';
    else if (n === "\\") out += "\\";
    else if (n === "u") {
      const code = Number.parseInt(t.slice(i + 1, i + 5), 16);
      if (Number.isNaN(code)) return null;
      out += String.fromCodePoint(code);
      i += 4;
    } else return null;
  }
  return out;
}

/**
 * 行扫描解析 model metadata.yml。要求顶层 `name:` 存在，否则返回 null。properties 下
 * 两空格缩进的 gateway_generated / table_fingerprint / description 尽力解析（缺失按
 * 缺省值处理）。v3 之前的生成文件没有所有权标记：description 仍是占位文案 → 视为
 * 网关生成（升级自愈：下次 sync/rebuild 补写标记；已被 agent enrich 的旧文件保守视为
 * 手建，绝不覆盖）。
 */
export function parseModelYaml(content: string): ParsedModelMeta | null {
  let name: string | null = null;
  let gatewayGenerated = false;
  let fingerprint: string | null = null;
  let description: string | null = null;
  let section = "";
  for (const raw of content.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
      if (!m) continue;
      if (m[1] === "name") name = unquoteYamlString(m[2]);
      else section = m[1] === "properties" || m[1] === "table_reference" ? m[1] : "";
      continue;
    }
    // 只关心 properties 下两空格缩进的 k:v（columns 列表项 "- name:" 不匹配键正则，自然忽略）
    if (section !== "properties" || indent !== 2 || trimmed.startsWith("-")) continue;
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!m) continue;
    if (m[1] === "gateway_generated") gatewayGenerated = m[2].trim() === "true";
    else if (m[1] === "table_fingerprint") fingerprint = unquoteYamlString(m[2]);
    else if (m[1] === "description") {
      const v = unquoteYamlString(m[2]);
      description = v?.startsWith('"') ? null : v; // 形似引号串但解不开 → 视为缺失
    }
  }
  if (!name) return null;
  const legacyGenerated =
    !gatewayGenerated && fingerprint === null && description?.startsWith(GENERATED_DESCRIPTION_PREFIX) === true;
  return { name, gatewayGenerated: gatewayGenerated || legacyGenerated, fingerprint, description };
}
