/** 结构化配置错误（DESIGN §30）：带 code 的编解码错误 + 路由统一映射。 */
/** 配置编解码的业务异常：code 对应错误码契约（INVALID_CONFIG/INVALID_AGENT/…）。 */
export class ConfigCodecError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ConfigCodecError";
  }
}

/** 抛出带 code 的编解码错误（校验函数里的统一出口）。 */
export function fail(code: string, message: string): never {
  throw new ConfigCodecError(code, message);
}

const CODEC_STATUS: Record<string, 400 | 413 | 500> = {
  INVALID_CONFIG: 400,
  INVALID_PROVIDER: 400,
  INVALID_AGENT: 400,
  INVALID_JSON: 400,
  INVALID_YAML: 400,
  INVALID_FRONTMATTER: 400,
  INVALID_NAME: 400,
  PAYLOAD_TOO_LARGE: 413,
  YAML_UNAVAILABLE: 500,
};

/** 路由统一错误映射（ConfigCodecError → { error: { code, message } }）。 */
export function respondCodecError(c: any, err: unknown): any {
  if (err instanceof ConfigCodecError) {
    return c.json(
      {
        error: {
          code: err.code,
          message: err.message,
          ...(err.details === undefined ? {} : { details: err.details }),
        },
      },
      CODEC_STATUS[err.code] ?? 400,
    );
  }
  console.error("[config-codec]", err);
  return c.json({ error: { code: "INTERNAL", message: "config codec failed" } }, 500);
}
