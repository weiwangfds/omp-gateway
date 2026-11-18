/**
 * KB skill 目录骨架（DESIGN §38.2/§38.9）：<dataRoot>/global/skills/kb-<slug>/。
 *
 * - 骨架：SKILL.md（网关生成模板）+ kb.json（管理标记，双用途见 §38.2）+ docs/scripts/assets。
 * - SKILL.md 四段：检索策略 / 页码语义 / 出图脚本 / 输出形态；静态模板，不含文档清单
 *   （避免入库/删文档后失同步）。
 * - scripts/ 下的 kb_shot.py、kb_asset.py 由 entrypoint/部署侧放置；createKb 时把模块内
 *   scripts/ 已存在的 .py 复制过去（另一个渠道写入，缺文件不报错）。
 * - qmd 检索引擎挂接（可选增强）：建库后注册 collection（kbQmdAdd），删库前注销
 *   （kbQmdRemove）——qmd.ts 内部 best-effort，qmd 未安装时自动 no-op，不影响管理面。
 */
import * as fs from "node:fs/promises";
import path from "node:path";
import { globalSkillsDir } from "../paths.ts";
import { KbError, kbSkillDir } from "./ingest.ts";
import { assertSlug, skillNameFor } from "./names.ts";
import { kbQmdAdd, kbQmdRemove } from "./qmd.ts";
import { countDocs, openKbDb } from "./store.ts";

// kbSkillDir 单一定义在 ingest.ts（本模块已 import 其 KbError，无循环依赖）。

export interface KbMeta {
  slug: string;
  title: string;
  createdAt: string;
}

/**
 * SKILL.md 模板（§38.9，标准 skill 形态：body 精简 + references/ 渐进披露）。
 * description 是唯一常驻上下文的触发信号——写足「做什么 + 什么场景一定用」，
 * 含用户可能说的同义表述（标准号、术语、表格/插图、第几页），宁可略 pushy。
 */
export function renderSkillMarkdown(slug: string, title: string): string {
  const name = skillNameFor(slug);
  return `---
name: ${name}
description: "检索并回答「${title}」文档内的事实性问题：术语定义、寄存器/模式设置、时序与电气参数、命令与训练流程、表格数值、章节与页码出处；也用于把文档里的表格/插图导出成图片。每当问题涉及该标准/文档（提到文档名、标准号、章节号，或问「原文怎么说」「第几页」「这张表/图是什么」）时必须使用——不要凭记忆回答这类问题，回答需带可核对页码。"
---

# ${title} 知识库

语料是 MinerU 精准解析后的全文（每个文档一个子目录，位于 \`docs/<文档名>/\`）。

## 何时使用

- 回答关于本文档的**任何事实性问题**：术语、寄存器/MR 设置、时序/电气参数、命令序列、训练流程、表格数值、章节出处。
- 用户提到本标准的文档名/标准号/章节号，或问「原文怎么说」「在第几页」「那张表/图是什么」。
- 需要把文档中的表格或插图原图交给用户。

**何时不用**：与本文档无关的问题；需要推理/计算而非查证的问题（检索只提供证据，不替代推理）。

## 检索流程（三步）

1. **路由 + 定位**：有两条检索路，由你按问题形态判断选路（不是固定先后）：
   - **grep 工具**（omp 内置，原生 ripgrep）：问题里含**词面可预测**的锚点——寄存器/参数名、
     命令、缩写、错误串、表格编号、专有名词 → 直接 grep 定位行号，毫秒级。
   - **qmd**（BM25+向量混合排名）：问题是**语义/换说法**的——自然语言描述、因果/流程类
     （「怎么进入 leveling」），或不确定文档用什么词 → 先 qmd 定位文档/章节。
   - 不确定走哪条 → 双路并行（套路 C）；qmd 给出文档级命中后，**通常仍需 grep 定行**（套路 A）。
   路由决策矩阵、三种组合套路、工具参数、无响应处置见 \`references/retrieval.md\`。
2. **精读**：read/grep 出命中位置**附近**段落（±60 行）确认原文；不要整文件通读。
3. **引用**：用**印刷页码**标注来源，需要 PDF 跳转时括注物理页。
   页码语义与 \`pages.txt\` 用法见 \`references/pagination.md\`。

引用格式（字面示例）：

> 进入 leveling 前须先驱动 WCK_t=LOW、WCK_c=HIGH（${title} p.68，PDF p.100）。

## 报告与总结的输出规范

生成报告/总结时**必须遵循本规范**，
完整规则与字面模板见 \`references/report.md\`——输出前必读。核心四条：

1. **结构**：标题 → 结论摘要（2-5 条，每条带页码引用）→ 分节正文（先结论后证据）→ 参考文献。
2. **先文后图**：正文**先引用**图/表编号，图表紧随该段之后出现（GB/T 7713 规则）；
   图题在图**下方**、表题在表**上方**。
3. **原文配图**：关键结论旁放**原文摘录块**（> 引用原文，页码标注）+ 对应**截图/表格**
   置于描述处；保留原文编号（如 Figure 26 / Table 105）并括注页码。
4. **忠实原文**：摘录不润色；表格数值逐格来自原文并注明单位；KB 未涵盖的内容明确标注
   「原文未涵盖」，**禁止凭记忆补充**。

## 出图与取图

需要高保真表格/插图时，先读 \`references/imaging.md\`，再调 \`scripts/kb_shot.py\`（按 bbox 从 PDF 重渲染）
或 \`scripts/kb_asset.py\`（取 MinerU 已裁剪图，可换 MinIO 公网 URL）。两脚本输出一行 JSON。

## 目录结构

\`\`\`
docs/<文档名>/
  <文档名>.md         正文（语料本体，检索对象）
  pages.txt           页索引：PDF 物理页 / 印刷页码 / 该页首段摘录
  middle_json.json    结构化中间结果（每块 bbox，出图定位来源）
  images/             MinerU 裁剪的表/插图
  source.pdf          原始 PDF（可选；截图脚本依赖）
assets/               出图/取图的本地输出
references/           本 skill 的详细说明（按需读取）
scripts/              出图/取图脚本
\`\`\`

## 参考文件（按需读，不要预读）

| 文件 | 何时读 |
|---|---|
| \`references/retrieval.md\` | 开始检索前 / qmd 工具参数不确定 / 检索无响应 |
| \`references/pagination.md\` | 需要给出页码、核对页码偏移、用 pages.txt 定位 |
| \`references/imaging.md\` | 需要导出表格/插图、或要交付原图给用户 |
| \`references/report.md\` | **生成报告/总结/对比分析前必读**（输出结构与图表内嵌规则） |
`;
}

/** references/ 下的静态说明文档（渐进披露层；内容不随文档清单变化，避免失效同步）。 */
export function renderReferenceDocs(slug: string): Record<string, string> {
  const name = skillNameFor(slug);
  return {
    "retrieval.md": `# 检索工具用法（${name}）：grep × qmd 双路组合

语料：\`docs/<文档名>/<文档名>.md\`。检索目标是「定位到正确段落」，不是通读。
两条检索路由你**按问题形态判断选路**（SKILL.md 第 1 步），本文件是决策细节与工具参数。

## 两条检索路（先看这张表再动手）

| | **grep 工具**（omp 内置） | **qmd**（BM25+向量混合排名） |
|---|---|---|
| 本质 | 词面精确匹配（原生 ripgrep 引擎） | 语料排名检索（lex/vec/hyde 子查询） |
| 擅长 | 寄存器/参数名、命令、缩写、错误串、Table/Figure 编号、专有名词——**词面可预测**的锚点 | 自然语言描述、换说法、因果/流程问题（「怎么进入 leveling」）——**词面猜不中**的问题 |
| 给出 | 行号（毫秒级，精确） | 文档/段落排名（单文档知识库通常只有文档级 1 条） |
| 局限 | 词面猜不中 = 零命中 | 词面精确的锚点反而不如 grep 准；未配远程 embedding 时只有 BM25 |
| 可用性 | **永远可用** | MCP 工具（KB_QMD_MCP=1）/ CLI（镜像内置 qmd） |

## 路由判断（由你决定，不是固定先后）

- 问题里已有明确词面锚点（名词/编号/命令/缩写）→ **起手 grep**；
- 问题是自己的话转述、文档里多半不是这么写的 → **起手 qmd**；
- 拿不准 → 双路并行（套路 C）；
- qmd 不可用（MCP 没挂/CLI 缺失）→ 纯 grep 流程照常能完成，不要卡在等 qmd。

## 三种组合套路

### 套路 A：qmd 定域 → grep 定行（最常用）

qmd 负责「哪篇文档/哪个章节」，grep 负责「哪一行」：
\`qmd_query\` 拿到文档级命中 → 对该文档 grep 关键词定位行号 → read ±60 行 → 页码表定页。
单文档知识库里 qmd 通常只返回**文档级**一条结果——它不给你行号，别拿 qmd 结果直接当答案出处。

### 套路 B：grep 破冰 → qmd 扩面

grep 命中术语后，把命中句**改写成自然语言**喂 qmd 的 vec/hyde 子查询，找换说法的其他章节
（如 grep 命中 CBT 后，用「执行总线训练的流程」搜出 Command Bus Training 所在章节）——
跨章节主题只有语义路能串起来。

### 套路 C：双路并行

拿不准词面时同时发起：grep（词面变体）+ qmd（语义转述），取并集再收敛。
两边都空 = 锚点选错 → 回路由表换锚点（同义词/上位词/章节标题），不是加大查询次数。

## grep：内置工具用法（首选）

omp 的 grep 是内置工具（原生 ripgrep 语义，支持正则），参数：\`pattern\`（必需）、
\`path\`（文件或目录，缺省当前目录）、\`case\`（true=区分大小写）、\`gitignore\`、\`skip\`（跳过前 N 个匹配）。
在 skill 目录内检索：

- 定一个文档：\`pattern: "<词1>|<词2>"\`, \`path: "docs/<文档名>/<文档名>.md"\`
- 扫全部语料：\`path: "docs"\`（多文档知识库先广后深）
- bash 工具里等价命令也可用：\`grep -n -i -E "<词1>|<词2>" docs/<文档名>/<文档名>.md | head -40\`

变体技巧（两条路通用）：

- 术语可能是英文/缩写/全称（如 CS Training / Command Bus Training / CBT）——列 2–4 个变体一次查。
- 探明文档是否用某说法：\`grep -c\` 计数；为 0 = 该文档不用这个词，换词再试。
- 找章节：grep \`^#+ .*<主题>\` 拿标题行。
- 命中后 read ±60 行确认上下文；不要整文件通读（长文档常 8000+ 行）。

## qmd：MCP 工具 / CLI

**MCP 工具**（会话挂了全局 qmd 时，前缀以会话为准）：\`mcp__qmd_query\` / \`mcp__qmd_get\` /
\`mcp__qmd_multi_get\` / \`mcp__qmd_status\`。

- \`qmd_query\` 参数：
  - \`searches\`（**必需，名字是 searches，不是 queries**）：typed 子查询数组，1–10 条，
    元素形如 \`{"type":"lex","query":"write training"}\` / \`{"type":"vec","query":"如何训练写入时序"}\` /
    \`{"type":"hyde","query":"假设性答案段落"}\`。原查询放第一个（权重最高）。
  - \`collections\`: \`["${name}"]\`（限定本知识库）
  - \`limit\`（默认 10）、\`intent\`（消歧上下文）、\`minScore\`
- 结果字段：\`file\` 形如 \`${name}/<文档名>/<文档名>.md\`（**MCP 返回「collection/相对路径」，无 qmd:// 前缀**；
  CLI 才带 \`qmd://\`）。映射到工作区路径：\`.omp/skills/\` + file 的值。
- \`qmd_get\`：\`{"file":"${name}/<文档名>/<文档名>.md","maxLines":200}\` 取整段原文；
  也支持 \`#<docid>:from:count\` 行区间。

**CLI**（无 MCP 工具时）：

\`\`\`bash
qmd --index kb search "<关键词>" -c ${name}      # BM25，毫秒级
qmd --index kb vsearch "<语义查询>" -c ${name}   # 需要部署侧配置远程 embedding
qmd --index kb get "<file>"                       # 取原文
\`\`\`

**无响应处置**：\`vsearch\`/\`query\` 若 10 秒以上无任何输出，立即放弃（环境未配远程 embedding 时会退回
本地模型加载而卡住）——改走 grep 路。\`search\`（BM25）不受此影响。

## 迭代准则

命中过多 → 加限定词（章节名/参数名）；命中过少 → 减词/换同义；**两次无果必须换路**
（grep ↔ qmd ↔ 组合套路），不要在同一条路上反复微调——换路是这套组合的核心用法，不是失败兜底。`,
    "pagination.md": `# 页码语义与定位（${name}）

## 两种页码，别混用

| 类型 | 谁在用 | 用途 |
|---|---|---|
| **印刷页码** | 文档目录、页脚 "Page N"、正文交叉引用 | **回答引用用这个** |
| **PDF 物理页** | 阅读器跳页、\`images/page_N_*.jpg\` 命名、\`middle_json.pdf_info\` 下标 | 出图/定位用这个 |

二者常有固定偏移（JEDEC 类文档实测差 32：印刷 p.68 = 物理 p.100）。**不要**用 md 行号换算页码。

## 确定性定位：pages.txt

\`docs/<文档名>/pages.txt\`，入库时生成，三列制表符分隔（首个非注释行为第 1 页）：

\`\`\`
<PDF 物理页>	<印刷页码，可能为空>	<该页首段文本摘录>
\`\`\`

用法：

\`\`\`bash
# 1) 先按内容摘录定位到页
grep -n -i "<命中关键词>" docs/<文档名>/pages.txt | head -10
# 2) 该行第一列 = 物理页，第二列 = 印刷页码（空则向前/后找最近的非空印刷页并按偏移推算）
awk -F'\\t' 'NR==<行号>{print "物理页="$1" 印刷页="$2}' docs/<文档名>/pages.txt
\`\`\`

## 更精确：middle_json.json

\`\`\`bash
python -c "
import json
m=json.load(open('docs/<文档名>/middle_json.json',encoding='utf-8'))
p=m['pdf_info'][<物理页>-1]
for b in p['para_blocks'][:10]:
    print(b.get('type'), b.get('bbox'), str(b.get('text') or '')[:80])
"
\`\`\`

每块带 \`bbox\`（PDF 点坐标），可直接喂给 \`scripts/kb_shot.py --bbox\`。

## 引用格式

- 单页：\`<title> p.68\`；标注物理页时：\`p.68（PDF p.100）\`
- 区间：\`p.69–70\`
- 无法确定印刷页码时：只给物理页并说明「PDF p.100」

印刷页码为空（该页页脚未被识别）时，用相邻页的偏移推算，并在回答里保持物理页可核对。`,
    "imaging.md": `# 出图与取图（${name}）

两个脚本都在 \`scripts/\` 下，均向 stdout 输出**一行 JSON**，stderr 给诊断。

## 取图：kb_asset.py（MinerU 已裁剪的表/插图）

\`\`\`bash
python scripts/kb_asset.py --doc <文档名> --image images/page_21_table_5.jpg [--image images/...]
\`\`\`

- \`--image\` 用 \`images/\` 下的相对路径（文件名可通过 \`ls docs/<文档名>/images/\` 查到；
  命名规则 \`page_<物理页>_<table|image>_<序号>.jpg\`）。
- 输出：\`{"mode":"minio","items":[{"image":...,"url":"https://…"}]}\`
  或 \`{"mode":"local","items":[{"image":...,"path":"…\\\\assets\\\\…jpg"}]}\`。

## 截图：kb_shot.py（从 source.pdf 按 bbox 高保真重渲染）

\`\`\`bash
python scripts/kb_shot.py --doc <文档名> --page <物理页> --table 1     # 该页第 1 个表格块
python scripts/kb_shot.py --doc <文档名> --page <物理页> --image 2     # 该页第 2 个图像块
python scripts/kb_shot.py --doc <文档名> --page <物理页> --bbox x0,y0,x1,y1   # 直接给 PDF 点坐标
\`\`\`

- 需要该文档已补传 \`source.pdf\`；缺失时返回 \`{"error": "... missing ..."}\`。
- bbox 来源：\`middle_json.json\` 的 \`pdf_info[物理页-1].para_blocks\`（见 \`pagination.md\`）。
- \`--page\` 用**物理页**（不是印刷页码）。
- 输出形状同 kb_asset.py（\`{"mode":...,"path"/"url":...}\`）。

## 交付给用户

- \`"mode":"minio"\`：回答/报告里**必须**直接贴 \`url\` 字段，一字不改。上传走的是容器网内的
  写入端点（KB_MINIO_ENDPOINT），返回的 \`url\` 已按部署方配置的**外网基址**（KB_MINIO_ENDPOINT_PUBLIC）
  重写——内网地址只用于上传，**不要自己拿内网端点拼 URL 贴进报告**（外网不可达）。
- \`"mode":"local"\`：输出路径在会话工作区可读，回答里给出该路径并说明是本地产物。
- 需要多张图时逐条调用，把每个结果映射回「Figure/Table 编号 + 页码」再列出。

## 报告内嵌规则（配合 report.md）

- 报告/总结里的图表**必须**由这两个脚本产出（kb_shot 高保真 / kb_asset 取原图），
  不要手绘表格替代原文表格截图，除非用户明确要 markdown 转写。
- 产物地址写进报告时同时标注「原文编号 + 印刷页码」，MinIO 模式**贴脚本返回的 \`url\` 原文**，如：
  \`![Figure 26（<文档名> p.69，PDF p.101）](https://<minio公网基址>/kb-assets/<文档名>/1a2b3c4d5e6f7788.png)\`。`,
    "report.md": `# 报告与总结输出规范（${name}）

> 生成报告/总结/对比分析时**先读本文**，输出不符合本规范视为未完成。

## 一、报告结构（顺序固定，按需裁剪）

\`\`\`markdown
# <标题：问题或主题>

## 结论摘要
- <结论 1>（<文档名> p.N）
- <结论 2>（<文档名> p.N–M）
（2–5 条；每条独立成立且带页码；没有把握的不写）

## <主题一：先结论后证据>
<正文：直接给结论与数值，句句可溯源；先文后图表>

## <主题二：…>

## 未决与局限
- <原文未涵盖 / 多值并存 / 原文标 TBD 的项，逐条列出>

## 参考文献
1. <文档名>（<title>），p.N–M
2. …
\`\`\`

短问答可省「结论摘要/参考文献」，但**页码引用与图表规则不可省**。

## 二、页码引用规则

- 正文句末内联：\`（<文档名> p.N）\`；区间 \`p.N–M\`；需要 PDF 跳转时括注：\`（p.68，PDF p.100）\`。
- **印刷页码优先**（读者在文档目录/页脚看到的页码）；物理页仅用于跳转/出图。
- 引用必须**句子级**（每个关键结论都可单独核对），不允许整段末尾一次性挂引用。

## 三、原文摘录块（文字证据）

关键结论旁放原文摘录（保持原文，不润色不翻译；超 3 行截断加省略号）：

\`\`\`markdown
> **原文（<文档名> p.69）**："After WCK2CK leveling, the DQ Bus should be trained for
> high-speed operation using the training commands …"
\`\`\`

- 摘录必须与 \`docs/<文档名>/<文档名>.md\` 原文**逐字一致**（含大小写与标点）。
- 引用外文原文后，可另起一行给出中文转述（标注「译」），原文仍保留。

## 四、图片内嵌（先文后图，图题在下）

**规则（GB/T 7713）**：正文先出现「见图 N / 如 Figure 26 所示」的引用，图片紧随该段之后；
图题（编号+说明）放图片**下方**。

\`\`\`markdown
WCK2CK leveling 的进入时序见图 1：控制器先驱动 WCK_t=LOW、WCK_c=HIGH，再通过 MR16 OP[2]
进入 leveling 模式（<文档名> p.69，PDF p.101）。

![原文 Figure 26 — WCK2CK Leveling Entry（p.69）](https://<minio公网基址>/kb-assets/<文档名>/1a2b3c4d5e6f7788.png)
*图 1 — WCK2CK Leveling 进入时序（原文 Figure 26，<文档名> p.69，PDF p.101）*
\`\`\`

- 图片来源只用 \`scripts/kb_shot.py\`（高保真重渲染）或 \`scripts/kb_asset.py\`（MinerU 原裁剪图），
  用法见 \`imaging.md\`。
- 保留**原文编号**（Figure 26 / Table 105），报告内部顺序号（图 1、图 2…）只作展示序号，两者都要写。
- MinIO URL **直接贴 URL**（交付默认）；脚本降级 \`"mode":"local"\` 时才用本地路径（\`.omp/skills/${name}/assets/…\`），并说明是本地产物。

## 五、表格内嵌（表题在上）

- **简单表**（≤6 列、无合并单元格）：可转写为 markdown 表，**数值逐格来自原文**并注明单位；
  表题放表格**上方**（GB/T 规则，与图相反）：

\`\`\`markdown
*表 1 — 原文 Table 29：WCK2CK Leveling AC 参数（<文档名> p.71）*

| 参数 | 最小 | 最大 | 单位 |
|---|---|---|---|
| tWLVPEN | — | 15 | ns |
| tWLVO | 0 | max(2 tCK, 20) | ns |
\`\`\`

- **复杂表**（合并单元格/嵌套表头/超宽）：**不要转写**，用 \`kb_shot.py\` 截图内嵌（按四节图片规则）——
  转写造成的数值错位比截图难核对得多。

## 六、忠实性红线（违反任何一条即不合格）

1. 数值、单位、参数名、状态机名称必须逐字来自检索结果；记不清就再查，**禁止凭记忆补**。
2. 原文标 TBD/未定稿的值，输出「TBD（原文未定）」，不得推算填充。
3. 多处口径冲突（如同一寄存器位两处定义不同）→ 两处都列并注明「原文冲突，待权威口径」。
4. KB 未涵盖的问题 → 明确回答「原文未涵盖」，可给最接近的章节指引，**不要外推**。
5. 图表编号引用（图 N/表 M）与图片/表格实体必须一一对应，不允许有题无图、有图无题。`,
  };
}

/** 建 KB：目录骨架 + kb.json + SKILL.md + 脚本复制；已存在（含 kb.json）→ ALREADY_EXISTS。 */
export async function createKb(slug: string, title?: string): Promise<KbMeta> {
  assertSlug(slug);
  const dir = kbSkillDir(slug);
  if (await fs.exists(path.join(dir, "kb.json"))) {
    throw new KbError("ALREADY_EXISTS", `kb already exists: ${slug}`);
  }
  const t = title?.trim() || slug;
  await Promise.all(["docs", "scripts", "assets"].map((s) => fs.mkdir(path.join(dir, s), { recursive: true })));
  const meta: KbMeta = { slug, title: t, createdAt: new Date().toISOString() };
  await fs.writeFile(
    path.join(dir, "kb.json"),
    `${JSON.stringify({ _managedBy: "omp-gateway", type: "kb", ...meta }, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(path.join(dir, "SKILL.md"), renderSkillMarkdown(slug, t), "utf8");
  await copyScriptsToSkillDir(slug);
  await writeReferenceDocs(slug);
  await kbQmdAdd(slug); // qmd collection 注册：失败仅告警（qmd.ts 已 log），不回滚建库
  return meta;
}

/** references/ 文件名白名单（只允许本模块定义的那几个 .md）。 */
const REFERENCE_FILE_RE = /^[a-z0-9][a-z0-9-]{0,63}\.md$/;

/** 边界守卫的 join：resolve 后校验必须落在根内（白名单之外的兜底）。 */
function safeJoin(root: string, ...segments: string[]): string {
  const base = path.resolve(root);
  const target = path.resolve(base, ...segments);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`path escapes skill directory: ${target}`);
  }
  return target;
}

/**
 * 写 references/ 下的说明文档（标准 skill 渐进披露层）：内容一致不落盘，
 * 与 SKILL.md 一起受模板升级路径管理（createKb / refreshKbSkillMd / 启动刷新）。
 */
export async function writeReferenceDocs(slug: string): Promise<void> {
  assertSlug(slug);
  const dir = safeJoin(kbSkillDir(slug), "references");
  await fs.mkdir(dir, { recursive: true });
  for (const [file, content] of Object.entries(renderReferenceDocs(slug))) {
    if (!REFERENCE_FILE_RE.test(file)) continue; // 白名单：文件名只来自模板常量
    const target = safeJoin(dir, file);
    const prev = await fs.readFile(target, "utf8").catch(() => null);
    if (prev !== content) await fs.writeFile(target, content, "utf8");
  }
}

/**
 * 按当前模板重写 SKILL.md（模板升级路径）：建库时写入的模板会随版本过期，
 * 存量 KB 需要能刷新（入库后 + 网关启动时各刷一次）。内容一致不落盘。
 */
export async function refreshKbSkillMd(slug: string): Promise<boolean> {
  assertSlug(slug);
  const title = (await getKbTitle(slug)) ?? slug;
  const file = path.join(kbSkillDir(slug), "SKILL.md");
  const next = renderSkillMarkdown(slug, title);
  const prev = await fs.readFile(file, "utf8").catch(() => null);
  if (prev === next) return false;
  await fs.writeFile(file, next, "utf8");
  await copyScriptsToSkillDir(slug); // 脚本也可能随版本更新，一并覆盖
  await writeReferenceDocs(slug); // 渐进披露层同步升级
  return true;
}

/** 读 SKILL.md 原文（前端展示/调试用；缺文件 → null）。 */
export async function readKbSkillMarkdown(slug: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(kbSkillDir(slug), "SKILL.md"), "utf8");
  } catch {
    return null;
  }
}

/** 读 kb.json 的标题（缺文件/坏 JSON → null）。 */
export async function getKbTitle(slug: string): Promise<string | null> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(kbSkillDir(slug), "kb.json"), "utf8")) as {
      title?: unknown;
    };
    return typeof raw.title === "string" ? raw.title : null;
  } catch {
    return null;
  }
}

export interface KbSummary {
  slug: string;
  skillName: string;
  title: string | null;
  docs: number;
}

/** KB 列表：扫 global/skills/ 下 kb-* 且含 kb.json 的目录；docs 数从各自 kb.db 取。 */
export async function listKbs(): Promise<KbSummary[]> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(globalSkillsDir());
  } catch {
    return [];
  }
  const out: KbSummary[] = [];
  for (const name of entries.filter((n) => n.startsWith("kb-")).sort()) {
    const slug = name.slice(3);
    try {
      const st = await fs.stat(path.join(globalSkillsDir(), name, "kb.json"));
      if (!st.isFile()) continue;
    } catch {
      continue;
    }
    let docs = 0;
    try {
      docs = countDocs(openKbDb(slug));
    } catch {
      docs = 0; // slug 不合规则等极端情况不阻塞列表
    }
    out.push({ slug, skillName: name, title: await getKbTitle(slug), docs });
  }
  return out;
}

/** 启动钩子：把所有存量 KB 的 SKILL.md + 脚本刷新到当前模板（单 KB 失败只告警，不阻塞启动）。 */
export async function refreshAllKbSkills(): Promise<void> {
  try {
    const kbs = await listKbs();
    let changed = 0;
    for (const kb of kbs) {
      try {
        if (await refreshKbSkillMd(kb.slug)) changed++;
      } catch (err) {
        console.error(`[gateway:kb] SKILL.md 刷新失败 ${kb.slug}:`, err);
      }
    }
    if (changed) console.log(`[gateway:kb] SKILL.md/scripts 已升级 ${changed}/${kbs.length} 个 KB`);
  } catch (err) {
    console.error("[gateway:kb] refreshAllKbSkills failed:", err);
  }
}

/** 删 skill 目录（KB 删除的目录侧；db 文件由 store.removeKbDbFile 负责）。返回目录是否原本存在。 */
export async function deleteKbSkillDir(slug: string): Promise<boolean> {
  assertSlug(slug);
  const dir = kbSkillDir(slug);
  const existed = await fs.exists(dir);
  if (existed) {
    // 先注销 qmd collection 再删目录：避免 qmd update 在目录消失后扫到悬空路径
    await kbQmdRemove(slug);
    await fs.rm(dir, { recursive: true, force: true });
  }
  return existed;
}

/**
 * 把本模块 scripts/ 下已存在的 .py 复制到 skill 目录（kb_shot.py / kb_asset.py 由
 * 部署侧或另一渠道放置；源目录缺失或单个文件缺失都静默跳过，不阻塞建库）。
 */
export async function copyScriptsToSkillDir(slug: string): Promise<void> {
  assertSlug(slug);
  const srcDir = path.join(import.meta.dir, "scripts");
  let entries: string[] = [];
  try {
    entries = (await fs.readdir(srcDir)).filter((f) => f.endsWith(".py"));
  } catch {
    return;
  }
  const destDir = path.join(kbSkillDir(slug), "scripts");
  await fs.mkdir(destDir, { recursive: true });
  for (const file of entries) {
    try {
      await fs.copyFile(path.join(srcDir, file), path.join(destDir, file));
    } catch {}
  }
}
