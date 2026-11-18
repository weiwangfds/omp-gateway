/**
 * data-query 全局 skill 物化（DESIGN §39.2 步骤 7 + §40）：SKILL.md（简体中文，omp
 * 约定：body 精简 + references/ 渐进披露）+ references/（内容 = `wren skills get
 * <guide>` 输出，启动时物化 → 与已装 wrenai 版本自动匹配；wren 不在 PATH 时跳过
 * references、只写 SKILL.md）。
 */
import * as fs from "node:fs/promises";
import path from "node:path";
import { globalSkillsDir } from "../paths.ts";
import { truncate } from "../proc.ts";
import { WREN_LOG, resolveWrenBin, type WrenDatasourceSpec } from "./env.ts";
import { runWrenCommand, writeIfChanged } from "./project.ts";
import { loadWrenRegistry } from "./registry.ts";

/** 全局 skill 名与指南清单（references/ 内容 = `wren skills get <guide>` 输出） */
export const SKILL_NAME = "data-query";
export const SKILL_GUIDES = ["onboarding", "usage", "generate-mdl"] as const;

/**
 * data-query 全局 skill 正文（简体中文，omp 约定：body 精简 + references/ 渐进披露）。
 * 工具清单以本机实证（wrenai 0.18.0 tools/list）为准，全部只读。
 */
export function renderDataQuerySkillMd(specs: WrenDatasourceSpec[]): string {
  const dsRows = specs.map((s) => `| wren-${s.name} | ${s.datasource} | ${s.port} |`).join("\n");
  return `---
name: data-query
description: "用自然语言查询已接入的业务数据库（WrenAI 语义层 Text2SQL）：订单/收入/客户等业务数据问数、指标统计、报表聚合与趋势分析。每当用户询问业务数据（「有多少」「top N」「按 X 统计」「同比环比」等）或要求数据佐证时必须使用本流程——工作流：list_models → MDL 模型 SQL → dry_run → run_sql 只读执行；禁止凭记忆编造数值。"
---

# 数据查询（WrenAI 语义层）

网关已为每个接入的数据源自建 Wren 项目与 MCP 服务（工具全部只读）。模型由网关内省
自动生成（含表/列结构），业务描述与指标需要你按下面「建模」流程 enrich。

## 本会话可用的工具组

| MCP 服务 | 数据源类型 | 环回端口 |
|---|---|---|
${dsRows}

每个 \`wren-<name>\` 服务提供同一组工具（以各服务 tools/list 实测为准）：

- \`run_sql\` —— 只读执行 SQL（默认 1000 行 cap，硬上限 10000），返回 columns/rows/row_count
- \`dry_run\` —— 对库校验 SQL（不返回行）
- \`dry_plan\` —— 只做语义层展开，看翻译后的目标方言 SQL（不连库）
- \`list_models\` / \`describe_model\` / \`describe_schema\` —— 模型清单与列结构
- \`get_mdl\` / \`get_data_source\` / \`get_context\` / \`get_instructions\` —— 语义层与业务规则
- \`list_cubes\` / \`describe_cube\` / \`query_cube\` —— 结构化指标查询（如 MDL 定义了 cube）
- \`list_functions\` —— 该数据源可用的 SQL 函数
- \`recall_queries\` / \`list_knowledge\` / \`list_stored_queries\` —— 历史 NL→SQL 与知识

## 标准查数工作流

1. \`list_models\`（或 \`describe_schema\`）拿模型清单；\`describe_model\` 看列与主键。
2. 用 **MDL 模型名**（不是物理表名）写方言中立 SQL。
3. 复杂查询先 \`dry_plan\` 看展开 SQL，再 \`dry_run\` 校验。
4. \`run_sql\` 只读执行。
5. 回答中引用模型名与行数（row_count）；结果为空或报错就如实说明。

深入参考：references/usage.md（CLI 工作流）、references/onboarding.md（从零接入）、
references/generate-mdl.md（建模）。

## 建模（enrich 描述 / 新表 / 新指标进语义层）

网关已按 catalog 内省生成每表一个 \`models/<model>/metadata.yml\`（位于
\`<dataRoot>/global/wren/<name>/models/\`），description 是占位文案——**enrich 就改这些
文件**：给 model/columns 补 properties.description、按 references/generate-mdl.md 补
关系（relationships.yml）与业务规则（knowledge/）。改完：

\`wren context validate\` → \`wren context build\` →（让 MCP 立即生效）请管理员经
POST /admin/wren/datasources/<name>/rebuild 或 /sync 重启 daemon，或过渡期直接用 CLI
\`wren --sql "..."\` 查询（CLI 每次即时编译，不依赖 daemon）。
注意：内省按表指纹增量更新——表结构变化只重写受影响的 columns/table_reference，agent
enrich 的 description 会保留；已从库中消失的自动生成目录随收敛移除；agent 手建的 model
文件永不删除。重要语义建议沉淀到 knowledge/（rules/ 与 sql/ 不受内省影响）。

## 经验沉淀（跨会话复用）

- 确认正确的问数结果：\`wren memory store --nl "<用户的原始问题>" --sql "<SQL>"\`
  （落 knowledge/sql/*.md，grep 后端零依赖；失败/被否定的查询不存）。
- 相似问题先 \`wren memory recall -q "<问题>"\` 取 few-shot。
- MDL 变更后 \`wren memory index\` 重建索引。

## 降级

- 工具调用失败/超时/返回错误：如实告知用户「当前无法查数」及原因，**不要编造数据**。
- 可先试 CLI 通道自检：\`wren --sql "SELECT 1"\`（容器内已装 wren，WREN_HOME 已配置）；
  CLI 也失败（如数据库不可达）则向用户说明，等恢复后再查。
`;
}

/**
 * 步骤 7：物化全局 skill。SKILL.md 总是写（内容随 specs 变化才落盘）；
 * references/ 只在 wren 可用时物化（内容 = 当前安装版本的 skills get 输出，
 * 版本自动匹配；wren 缺失/失败 → 跳过，保留旧文件）。
 */
export async function materializeDataQuerySkill(specs: WrenDatasourceSpec[], bin: string | null): Promise<void> {
  if (specs.length === 0) return;
  try {
    const dir = path.join(globalSkillsDir(), SKILL_NAME);
    await fs.mkdir(path.join(dir, "references"), { recursive: true });
    if (await writeIfChanged(path.join(dir, "SKILL.md"), renderDataQuerySkillMd(specs))) {
      console.log(`${WREN_LOG} data-query skill 已写入 ${dir}`);
    }
    if (!bin) return;
    for (const guide of SKILL_GUIDES) {
      const r = await runWrenCommand(bin, ["skills", "get", guide], `skills get ${guide}`);
      if (!r.ok || !r.stdout.trim()) continue;
      await writeIfChanged(path.join(dir, "references", `${guide}.md`), `${r.stdout.trimEnd()}\n`);
    }
  } catch (err) {
    console.error(`${WREN_LOG} materializeDataQuerySkill: ${truncate(String(err))}（不阻塞启动）`);
  }
}

/**
 * admin 写操作（PUT/DELETE/rebuild）后刷新 data-query skill：SKILL.md 里列了当前有哪些
 * 数据源工具组，数据源增删后必须重写；references 也顺手跟随 wren 版本重新物化。
 * 幂等（内容一致不落盘）；无数据源时 materialize 内部直接返回。
 */
export async function refreshDataQuerySkill(): Promise<void> {
  try {
    const reg = await loadWrenRegistry();
    const specs: WrenDatasourceSpec[] = Object.entries(reg).map(([name, e]) => ({
      name,
      datasource: e.datasource,
      connection: e.connection,
      port: e.port,
    }));
    await materializeDataQuerySkill(specs, resolveWrenBin());
  } catch (err) {
    console.error(`${WREN_LOG} refreshDataQuerySkill: ${truncate(String(err))}（不影响数据源本身）`);
  }
}
