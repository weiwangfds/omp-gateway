/**
 * 结构化配置编解码门面（Barrel，DESIGN §30 / §31）。
 *
 * 对外 API 保持不变，实现按职责拆分到 `core/config/*`：
 *  - errors.ts    ConfigCodecError + 路由错误映射
 *  - yaml.ts      Bun.YAML 访问 / 记录判定
 *  - models.ts    models.yml（provider id / models[] 校验 + 序列化）
 *  - agents.ts    agents/*.md（字段白名单 ⇄ frontmatter + instructions）
 *  - schema.ts    /me/config/schema 自描述
 *  - request.ts   JSON 解析 + 结构化/原文分流
 */
export * from "./config/errors.ts";
export * from "./config/yaml.ts";
export * from "./config/models.ts";
export * from "./config/agents.ts";
export * from "./config/schema.ts";
export * from "./config/request.ts";
