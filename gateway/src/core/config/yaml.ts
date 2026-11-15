/** YAML 访问与记录判定（Bun.YAML，models.yml 与 agent frontmatter 共用）。 */
import { ConfigCodecError } from "./errors.ts";

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 取 Bun.YAML；运行时缺失即抛（网关要求 Bun ≥ 1.2）。 */
export function yaml(): typeof Bun.YAML {
  const api = (Bun as unknown as { YAML?: typeof Bun.YAML }).YAML;
  if (!api?.parse || !api?.stringify) {
    throw new ConfigCodecError("YAML_UNAVAILABLE", "Bun.YAML unavailable; gateway requires Bun >= 1.2");
  }
  return api;
}
