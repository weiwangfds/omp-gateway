/**
 * SessionFactory（DESIGN §9 集成层核心）：**只做编排**，装配步骤见 core/session-assembly.ts。
 * 隔离落点：agentDir（用户）、sessionManager（用户会话目录 + 会话 workspace）、
 * 私有 AgentRegistry（多会话并发必需）、全局扩展注入。
 */
import path from "node:path";
import { AgentRegistry, createAgentSession, SessionManager, type AgentSession } from "@oh-my-pi/pi-coding-agent";
import { config } from "../config.ts";
import { getUserContext } from "./user-context.ts";
import { registry, SessionCtx } from "./session-registry.ts";
import { insertUsage } from "./tenant-store.ts";
import { unregisterHookSession } from "./hook-engine.ts";
import {
  buildCreateOptions,
  installHookBridge,
  installUiBridge,
  loadExtensionLayers,
  prepareWorkspace,
  wireAgentHub,
} from "./session-assembly.ts";
import type { TurnMeta } from "./events.ts";

/** 网关内置扩展：集成端钩子桥（DESIGN §23）。 */
const GATEWAY_HOOKS_EXT = path.join(import.meta.dir, "..", "ext", "gateway-hooks.ts");

/** 显式指定的 provider/modelId 在该用户 registry 中不存在（创建时 404）。 */
export class ModelNotFoundError extends Error {
  constructor(
    public provider: string,
    public modelId: string,
  ) {
    super(`Model not found: ${provider}/${modelId}`);
  }
}

/** createGatewaySession 的入参：会话身份 + SDK 创建选项（字段含义见各注释）。 */
export interface CreateSessionOpts {
  userId: string;
  sid: string;
  model?: { provider: string; modelId: string };
  /** 恢复既有会话文件（revive / M3 resume） */
  resumeSessionFile?: string;
  /** 从源会话文件分叉（SDK SessionManager.forkFrom，血缘由调用方落 DB） */
  forkFrom?: string;
  /** 分叉时复制源 workspace 内容（会话:workspace=1:1，分叉会话获得自己的代码快照） */
  copyWorkspaceFrom?: string;
  restrictTools?: string[];
  thinkingLevel?: string;
  enableMcp?: boolean;
  enableLsp?: boolean;
  appendSystemPrompt?: string;
  /** 完整替换内置系统提示词（DESIGN §26；危险，需调用方明确意图） */
  systemPrompt?: string;
  /** 额外工作目录（调用方已按用户根守卫） */
  additionalDirectories?: string[];
  /** 上下文文件注入（集成端"提示词注入"的创建期通道；内容进系统提示词，不落盘） */
  contextFiles?: Array<{ path: string; content: string }>;
  /** 禁用 cwd 向上发现的 AGENTS.md（仅保留显式 contextFiles） */
  noContextFiles?: boolean;
}

/** 从 Model 对象提取轻量描述（DB/SSE 用）。 */
export function modelInfo(m: unknown): { provider: string; modelId: string } | null {
  const mm = m as { provider?: string; id?: string } | undefined;
  if (!mm?.provider || !mm?.id) return null;
  return { provider: mm.provider, modelId: mm.id };
}

/**
 * SessionFactory（DESIGN §9 集成层核心）：**只做编排**，装配步骤见 core/session-assembly.ts。
 * 隔离落点：agentDir（用户）、sessionManager（用户会话目录 + 会话 workspace）、
 * 私有 AgentRegistry（多会话并发必需）、全局扩展注入。
 */
/**
 * 创建并装配一个网关会话：返回 live 上下文与 SDK 会话对象。
 * modelFallbackMessage 非空表示显式模型不可用、已回落（调用方放进 warnings）。
 */
export async function createGatewaySession(opts: CreateSessionOpts): Promise<{
  ctx: SessionCtx;
  session: AgentSession;
  modelFallbackMessage?: string;
}> {
  const uctx = await getUserContext(opts.userId);

  // 1) workspace（1:1）+ fork 拷贝 + MCP 三方合成
  const workspaceDir = await prepareWorkspace(opts.userId, opts.sid, opts.copyWorkspaceFrom);

  // 2) 显式模型解析
  let model: ReturnType<typeof uctx.resolveModel>;
  if (opts.model) {
    model = uctx.resolveModel(opts.model.provider, opts.model.modelId);
    if (!model) throw new ModelNotFoundError(opts.model.provider, opts.model.modelId);
  }

  // 3) SessionManager（fork / resume / create）
  const sessionManager = opts.forkFrom
    ? await SessionManager.forkFrom(opts.forkFrom, workspaceDir, uctx.sessionsDir)
    : opts.resumeSessionFile
      ? await SessionManager.open(opts.resumeSessionFile, uctx.sessionsDir)
      : SessionManager.create(workspaceDir, uctx.sessionsDir);

  // 4) 扩展 / 技能 / HTTP 工具层
  const agentRegistry = new AgentRegistry();
  const layers = await loadExtensionLayers(opts.userId, uctx.agentDir, opts.sid);

  // 5) createAgentSession 参数（含用户级上下文注入与多租户硬约束）
  const { approvalEnabled, options } = await buildCreateOptions({
    userId: opts.userId,
    sid: opts.sid,
    workspaceDir,
    uctx,
    sessionManager,
    agentRegistry,
    layers,
    builtinExtensionPaths: [GATEWAY_HOOKS_EXT],
    model,
    thinkingLevel: opts.thinkingLevel,
    enableMcp: opts.enableMcp,
    enableLsp: opts.enableLsp,
    appendSystemPrompt: opts.appendSystemPrompt,
    systemPrompt: opts.systemPrompt,
    additionalDirectories: opts.additionalDirectories,
    contextFiles: opts.contextFiles,
    noContextFiles: opts.noContextFiles,
    restrictTools: opts.restrictTools,
    otel: config.otel,
  });
  const result = await createAgentSession(options as never);
  const { session, modelFallbackMessage } = result;

  // 6) SessionCtx（usageSink 落库）
  const ctx = new SessionCtx(opts.sid, opts.userId, workspaceDir, session, (meta: TurnMeta, turn: number) => {
    insertUsage({
      user_id: opts.userId,
      session_id: opts.sid,
      turn,
      model_provider: meta.provider ?? null,
      model_id: meta.modelId ?? null,
      input_tokens: Number(meta.usage.input ?? 0),
      output_tokens: Number(meta.usage.output ?? 0),
      cache_read: Number(meta.usage.cacheRead ?? 0),
      cache_write: Number(meta.usage.cacheWrite ?? 0),
      total_tokens: Number(meta.usage.totalTokens ?? 0),
      cost_usd: Number((meta.usage as { cost?: { total?: number } }).cost?.total ?? 0),
      duration_ms: meta.durationMs ?? null,
      ttft_ms: meta.ttftMs ?? null,
    });
  });
  ctx.mcpManager = result.mcpManager;
  ctx.lspServers = result.lspServers;
  ctx.agentRegistry = agentRegistry;
  ctx.sessionFile = session.sessionFile ?? null;

  // 7) 审批 UI 通道 + 钩子桥 + Agent Hub + 快照钩子
  await installUiBridge(session, result, ctx, approvalEnabled);
  await installHookBridge(session, uctx, ctx, result, opts.enableLsp !== false);
  wireAgentHub(agentRegistry, ctx);
  ctx.snapshotHook = () => {
    // turn 边界自动快照（M4）：每 5 turn / 15min，ring K=20 由 Pruner 滚动
    void import("./snapshot-service.ts")
      .then(({ maybeAutoSnapshot }) => maybeAutoSnapshot(opts.userId, opts.sid, ctx.turnCount))
      .catch((err) => console.error(`[gateway] auto snapshot failed (${opts.sid}):`, err));
  };

  // 8) SDK 事件 → 规范化层
  ctx.unsubscribeEvent = session.subscribe((evt) => ctx.dispatchOmp(evt));
  return { ctx, session, modelFallbackMessage };
}

/** 注销 + 释放 SDK 会话（归档/删除/空闲回收/关停共用）。 */
export async function disposeSession(ctx: SessionCtx): Promise<void> {
  registry.unregister(ctx.sid);
  unregisterHookSession(ctx.ompSessionId); // 钩子桥映射不随进程存活（修复泄漏）
  ctx.markDisposed(); // 先释放流式槽位等宿主资源，再拆 SDK 会话
  ctx.session.beginDispose();
  try {
    await ctx.session.dispose();
  } catch (err) {
    console.error(`[gateway] session ${ctx.sid} dispose error:`, err);
  }
}
