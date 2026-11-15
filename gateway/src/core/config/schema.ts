/** 配置自描述（DESIGN §30）：字段清单/正则/示例，供前端生成表单。 */
import { AGENT_FIELD_SPECS } from "./agents.ts";
import { MODEL_FIELDS, PROVIDER_FIELDS, PROVIDER_ID_RE } from "./models.ts";

/* ============================ 自描述 ============================ */

/** /me/config/schema 的自描述载荷：字段清单/正则/示例，供前端生成表单。 */
export function configSchema(): Record<string, unknown> {
  return {
    version: 1,
    models: {
      endpoints: {
        readYaml: "GET /api/me/models/config",
        readJson: "GET /api/me/models/config?format=json",
        writeAll: "PUT /api/me/models/config  (application/json)",
        oneProvider: "GET/PUT/DELETE /api/me/models/providers/:provider",
      },
      jsonShape: "{ providers: Record<providerId, ProviderConfig> }",
      providerIdPattern: PROVIDER_ID_RE.source,
      providerFields: PROVIDER_FIELDS,
      modelFields: MODEL_FIELDS,
      example: {
        providers: {
          minimax: {
            baseUrl: "https://api.minimax.cn/v1",
            api: "openai-completions",
            models: [{ id: "MiniMax-M3.1-Flash", name: "MiniMax M3.1 Flash" }],
          },
        },
      },
      note: "未知 provider/model 字段透传（与 omp models.yml 前向兼容）；结构化写入会重写文件，注释/锚点不保留；要保留原格式用 text/yaml",
    },
    agents: {
      endpoints: {
        list: "GET /api/me/agents",
        readJson: "GET /api/me/agents/:name?format=json",
        writeMarkdown: "PUT /api/me/agents/:name  (text/markdown)",
        writeJson: "PUT /api/me/agents/:name  (application/json)",
        createJson: "POST /api/me/agents  (application/json)",
      },
      fields: [
        {
          name: "name",
          type: "string",
          required: false,
          description: "agent 名（PUT 取路径；POST 必填 body.name；给出时必须与路径一致）",
        },
        { name: "description", type: "string", required: true, description: "一句话描述（委派时展示）" },
        ...AGENT_FIELD_SPECS.map((s) => ({
          name: s.key,
          type: s.kind,
          aliases: s.aliases,
          required: false,
          description: s.description,
        })),
        { name: "instructions", type: "string", required: true, description: "Markdown 指令正文" },
        {
          name: "content",
          type: "string",
          required: false,
          description: "原文通道：完整 markdown（含 frontmatter），不可与结构化字段混用",
        },
      ],
      example: {
        description: "Check release readiness and report concrete blockers.",
        tools: ["read", "grep", "glob", "bash"],
        model: "@slow",
        thinkingLevel: "high",
        prewalk: false,
        advisor: "@advisor",
        instructions: "You audit releases. Report blockers as a bulleted list.",
      },
      note: "PUT/POST 也接受 {content} 原文；GET ?format=json 返回规范字段 + frontmatter 原对象 + instructions",
    },
  };
}
