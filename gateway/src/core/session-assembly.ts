/**
 * 会话装配（Builder，DESIGN §29）：createGatewaySession 的装配步骤拆成可独立理解的单元，
 * 工厂（session-factory.ts）只做编排。
 */
import * as fs from "node:fs/promises";
import path from "node:path";
import { type AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent";
import { cfgToolsApprovalMode } from "@oh-my-pi/pi-coding-agent/tools/settings";
import type { UserContext } from "./user-context.ts";
import { globalExtensionsDir, globalSkillsDir, userExtensionsDir } from "./paths.ts";
import { composeMcpForWorkspace } from "./mcp-compose.ts";
import { composeAgentsForWorkspace } from "./agent-compose.ts";
import { composeKbForWorkspace } from "./kb/compose.ts";
import { buildHttpCustomTools } from "./http-tools.ts";
import { registerHookSession } from "./hook-engine.ts";
import type { SessionCtx } from "./session-registry.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * 装配顺序：
 *   1. prepareWorkspace    — 1:1 workspace + 可选拷贝（fork）+ MCP/agents/KB/settings 合成
 *   2. resolveSessionModel — 显式模型解析（不存在即 ModelNotFoundError）
 *   3. loadExtensionLayers — 全局/用户扩展、作用域技能、HTTP 工具
 *   4. loadUserContextFiles— 用户级 AGENTS/RULES/APPEND_SYSTEM 注入
 *   5. buildCreateOptions  — createAgentSession 参数（含多租户硬约束）
 *   6. installUiBridge     — 审批 UI 通道 + initializeExtensions（runner.hasUI 门）
 *   7. installHookBridge   — omp session id 映射 + 持久化子代理复活器
 *   8. wireAgentHub        — 名册变更 → SSE agents.changed
 */

/** 步骤 1：会话 workspace（会话:workspace = 1:1，DESIGN §3）。 */
export async function prepareWorkspace(userId: string, sid: string, copyWorkspaceFrom?: string): Promise<string> {
  const { userWorkspace } = await import("./paths.ts");
  const workspaceDir = userWorkspace(userId, sid);
  await fs.mkdir(workspaceDir, { recursive: true });
  // workspace 根目录给 777：宿主机（可能是另一个 uid）要能直接读写会话产出。
  // 失败不影响创建（Windows 挂载不支持 chmod 时会报 EPERM）。
  await fs.chmod(workspaceDir, 0o777).catch(() => {});
  if (copyWorkspaceFrom) {
    try {
      await fs.cp(copyWorkspaceFrom, workspaceDir, { recursive: true, force: true });
    } catch (err) {
      console.error(
        `[gateway] workspace copy failed (${copyWorkspaceFrom} → ${workspaceDir}), continuing with empty workspace:`,
        err,
      );
    }
  }
  await composeMcpForWorkspace(userId, workspaceDir);
  await composeAgentsForWorkspace(userId, workspaceDir);
  // KB junction 合成（DESIGN §38.5）：语料/脚本在工作区文件可达（skill 本体经 options.skills 注入）
  await composeKbForWorkspace(workspaceDir);
  await composeSessionSettingsForWorkspace(workspaceDir);
  return workspaceDir;
}

/**
 * 会话级 omp settings 合成（部署方工具面收敛，DESIGN §41.7）：OMP_SESSION_SETTINGS_JSON
 * （部署方 env，JSON 对象，键为 omp 设置 id）→ <workspace>/.omp/settings.json。SDK 以会话
 * cwd（= workspaceDir）解析 project 层设置，内网部署可借此关闭联网类工具，如
 * {"fetch.enabled":false,"web_search.enabled":false,"browser.enabled":false,"computer.enabled":false}。
 * 语义：env 未设 = 不写（保持 omp 默认，本地开发不受影响）；键浅合并覆盖已存在文件
 * （fork 拷贝来源若带 settings，部署方键优先）；坏 JSON 只告警不阻塞建会话（fail-open）。
 */
export async function composeSessionSettingsForWorkspace(workspaceDir: string): Promise<void> {
  const raw = process.env.OMP_SESSION_SETTINGS_JSON?.trim();
  if (!raw) return;
  let deployment: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a JSON object");
    deployment = parsed as Record<string, unknown>;
  } catch (err) {
    console.error(`[gateway] OMP_SESSION_SETTINGS_JSON 无效（跳过 settings 合成）: ${String(err)}`);
    return;
  }
  const file = path.join(workspaceDir, ".omp", "settings.json");
  let merged: Record<string, unknown> = { ...deployment };
  try {
    const prev = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    if (prev && typeof prev === "object" && !Array.isArray(prev)) merged = { ...prev, ...deployment };
  } catch {
    // 无既有文件或坏 JSON：直接用部署方键（坏 JSON 一并修正，可预期）
  }
  const next = `${JSON.stringify(merged, null, 2)}\n`;
  const prevRaw = await fs.readFile(file, "utf8").catch(() => null);
  if (prevRaw === next) return; // 内容一致不落盘（fork 拷贝可能已带来）
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, next, "utf8");
}

/** 步骤 3：扩展路径 / 作用域技能 / 集成端 HTTP 工具。 */
export interface ExtensionLayers {
  globalExtensions: string[];
  userExtensions: string[];
  skills: unknown[];
  httpTools: unknown[];
}

async function listExtensionFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir);
    return entries.filter((f) => f.endsWith(".ts") || f.endsWith(".js")).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/** 作用域化 skill 加载（DESIGN §3）：用户目录在前 → 同名用户覆盖全局；
 *  经 options.skills 直接注入（process 级发现会让跨用户目录互相泄漏——settings holder）。 */
export async function loadScopedSkills(agentDir: string): Promise<unknown[]> {
  try {
    const { loadSkillsFromDir } = await import("@oh-my-pi/pi-coding-agent");
    const seen = new Set<string>();
    const out: unknown[] = [];
    for (const [dir, source] of [
      [path.join(agentDir, "skills"), "user-skills"],
      [globalSkillsDir(), "global-skills"],
    ] as const) {
      try {
        const { skills } = await loadSkillsFromDir({ dir, source });
        for (const s of skills as Array<{ name: string }>) {
          if (seen.has(s.name)) continue;
          seen.add(s.name);
          out.push(s);
        }
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
}

/** 步骤 3：扩展路径 / 作用域技能 / 集成端 HTTP 工具（一次并行取齐）。 */
export async function loadExtensionLayers(userId: string, agentDir: string, sid: string): Promise<ExtensionLayers> {
  const [globalExtensions, userExtensions, skills] = await Promise.all([
    listExtensionFiles(globalExtensionsDir()),
    listExtensionFiles(userExtensionsDir(userId)),
    loadScopedSkills(agentDir),
  ]);
  return { globalExtensions, userExtensions, skills, httpTools: buildHttpCustomTools(userId, sid) };
}

/** 步骤 4：用户级上下文文件（SDK 的 user-wide 发现不读 options.agentDir，必须显式注入）。 */
async function loadUserContextFiles(agentDir: string): Promise<{
  contextFiles: Array<{ path: string; content: string }>;
  appendSystemPrompt: string | null;
}> {
  const contextFiles: Array<{ path: string; content: string }> = [];
  // 固定文件名直接内联 join（不经变量），信任边界清晰：agentDir 由网关派生，文件名为字面量
  for (const file of [path.join(agentDir, "AGENTS.md"), path.join(agentDir, "RULES.md")]) {
    const content = await fs.readFile(file, "utf8").catch(() => null);
    if (content?.trim()) contextFiles.push({ path: file, content });
  }
  const append = await fs.readFile(path.join(agentDir, "APPEND_SYSTEM.md"), "utf8").catch(() => null);
  return { contextFiles, appendSystemPrompt: append?.trim() ? append : null };
}

export interface AssembleOptions {
  userId: string;
  sid: string;
  workspaceDir: string;
  uctx: UserContext;
  sessionManager: unknown;
  agentRegistry: AgentRegistry;
  layers: ExtensionLayers;
  builtinExtensionPaths: string[];
  model?: unknown;
  thinkingLevel?: string;
  enableMcp?: boolean;
  enableLsp?: boolean;
  appendSystemPrompt?: string;
  systemPrompt?: string;
  additionalDirectories?: string[];
  contextFiles?: Array<{ path: string; content: string }>;
  noContextFiles?: boolean;
  restrictTools?: string[];
  otel: boolean;
}

/** 审批是否开启（除 yolo 外的三种模式都需要 UI 通道）。 */
export function isApprovalEnabled(uctx: UserContext): boolean {
  return cfgToolsApprovalMode.get(uctx.settings) !== "yolo";
}

/** 步骤 5：createAgentSession 参数（含多租户硬约束与用户级上下文注入）。 */
export async function buildCreateOptions(o: AssembleOptions) {
  const userCtx = await loadUserContextFiles(o.uctx.agentDir);
  const mergedContextFiles = [...userCtx.contextFiles, ...(o.contextFiles ?? [])];
  const mergedAppendPrompt = [userCtx.appendSystemPrompt, o.appendSystemPrompt].filter(Boolean).join("\n\n");
  const approvalEnabled = isApprovalEnabled(o.uctx);
  const httpTools = o.layers.httpTools;
  return {
    approvalEnabled,
    options: {
      cwd: o.workspaceDir,
      agentDir: o.uctx.agentDir,
      settings: o.uctx.settings,
      authStorage: o.uctx.authStorage,
      modelRegistry: o.uctx.modelRegistry,
      ...(o.model ? { model: o.model } : {}),
      ...(o.thinkingLevel ? { thinkingLevel: o.thinkingLevel as never } : {}),
      ...(o.enableMcp === false ? { enableMCP: false } : {}),
      ...(o.enableLsp === false ? { enableLsp: false } : {}),
      ...(mergedAppendPrompt ? { appendSystemPrompt: mergedAppendPrompt } : {}),
      ...(o.systemPrompt ? { systemPrompt: o.systemPrompt } : {}),
      ...(o.additionalDirectories?.length ? { additionalDirectories: o.additionalDirectories } : {}),
      ...(mergedContextFiles.length ? { contextFiles: mergedContextFiles } : {}),
      ...(o.noContextFiles ? { noContextFiles: true } : {}),
      agentRegistry: o.agentRegistry,
      sessionManager: o.sessionManager,
      skills: o.layers.skills as never, // 直接注入：绕开 process 级 skill 发现（多租户隔离）
      additionalExtensionPaths: [...o.layers.userExtensions, ...o.layers.globalExtensions, ...o.builtinExtensionPaths],
      ...(o.restrictTools ? { toolNames: o.restrictTools, restrictToolNames: true } : {}),
      // 集成端 HTTP 工具：extension-owned，不会被 MCP refresh 清掉；受限会话需显式允许
      ...(httpTools.length ? { customTools: httpTools as never, allowRestrictedCustomTools: true } : {}),
      hasUI: approvalEnabled,
      // 多租户硬约束（sdk.ts:1999）：bindProcessState 默认 true 会把进程级 setting effects
      // + discovery provider toggles 绑到最新创建的会话（dispose 后交还上一个持有者）——
      // 多用户并发时跨用户漂移。网关所有会话一律不绑定。
      bindProcessState: false,
      ...(o.otel ? { telemetry: {} } : {}),
    } as Record<string, unknown>,
  };
}

/**
 * 步骤 6：审批 UI 通道。
 * SDK 宿主正道（参照 rpc-mode.ts:1758）：headless 下 createAgentSession 不初始化 extension runner，
 * 而工具审批门读 runner.hasUI()/getUIContext()（wrapper.ts:443/458）；setToolUIContext 只喂
 * ToolContextStore。必须经 initializeExtensions 注入 UI 上下文。
 */
export async function installUiBridge(
  session: unknown,
  result: { setToolUIContext: (ui: never, hasUI: boolean) => void },
  ctx: SessionCtx,
  approvalEnabled: boolean,
): Promise<void> {
  const approvalTimeoutMs = 120_000;
  ctx.approvalPolicy = approvalEnabled ? { tools: "all", timeoutMs: approvalTimeoutMs } : null;
  const approvalUi = {
    approve: async (prompt: { full?: string; compact?: string }) => {
      if (!ctx.approvalPolicy) return "deny";
      const d = await ctx.requestApproval(
        "tool-approval",
        { full: prompt?.full ?? "", compact: prompt?.compact ?? "" },
        approvalTimeoutMs,
      );
      return d.approved ? ("once" as const) : ("deny" as const);
    },
    confirm: async (title: string, message: string) => {
      if (!ctx.approvalPolicy) return false;
      const d = await ctx.requestApproval(
        "ui-confirm",
        { full: `${title}\n${message}`, compact: title },
        approvalTimeoutMs,
      );
      return d.approved;
    },
    select: async () => undefined,
    input: async () => undefined,
    notify: () => {},
  } as never;
  result.setToolUIContext(approvalUi, approvalEnabled);
  const { initializeExtensions } = await import("@oh-my-pi/pi-coding-agent/modes/runtime-init");
  await initializeExtensions(session as never, {
    mode: "print",
    ...(approvalEnabled ? { uiContext: approvalUi } : {}),
    reportSendError: (action: string, err: Error) =>
      console.error(`[gateway] extension ${action} failed: ${err.message}`),
    reportRuntimeError: (err: { extensionPath?: string; error?: unknown }) =>
      console.error(`[gateway] extension error (${err.extensionPath}): ${err.error}`),
  });
}

/** 步骤 7：集成端钩子桥（会话映射 + 持久化子代理复活器）。 */
export async function installHookBridge(
  session: unknown,
  uctx: UserContext,
  ctx: SessionCtx,
  result: { eventBus?: unknown; subagentEventBus?: unknown },
  enableLsp: boolean,
): Promise<void> {
  try {
    const ompId = (session as { sessionManager?: { getSessionId?: () => string } }).sessionManager?.getSessionId?.();
    if (ompId) {
      ctx.ompSessionId = ompId;
      registerHookSession(ompId, ctx.sid, ctx.userId);
    }
  } catch {}
  try {
    const { createPersistedSubagentReviverFactory } = await import("@oh-my-pi/pi-coding-agent/task/persisted-revive");
    ctx.persistedReviverFactory = createPersistedSubagentReviverFactory({
      session,
      authStorage: uctx.authStorage,
      modelRegistry: uctx.modelRegistry,
      settings: uctx.settings as never,
      enableLsp,
      ...(result.eventBus ? { eventBus: result.eventBus } : {}),
      ...(result.subagentEventBus ? { subagentEventBus: result.subagentEventBus } : {}),
    } as never);
  } catch (err) {
    console.error("[gateway] persisted reviver factory init failed:", err);
  }
}

/** 步骤 8：Agent Hub 名册变更 → SSE agents.changed（排除主代理）。 */
export function wireAgentHub(agentRegistry: AgentRegistry, ctx: SessionCtx): void {
  try {
    agentRegistry.onChange(() => {
      try {
        ctx.publishAgentsSnapshot(
          (agentRegistry as unknown as { list: () => Array<Record<string, unknown>> })
            .list()
            .filter((a) => a.id !== MAIN_AGENT_ID),
        );
      } catch {}
    });
  } catch {}
}
