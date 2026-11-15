/** 单个活跃会话的进程态：SDK 会话 + SSE 订阅者 + 事件环形缓冲（DESIGN §6/§31）。 */
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";
import {
  normalizeOmpEvent,
  metaOfTurnEnd,
  type GatewayCorrelation,
  type GatewayEvent,
  type GatewayEventPayload,
  type TurnMeta,
} from "../events.ts";
import { dispatchWebhookEvent } from "../webhooks.ts";
import { audit } from "../tenant-store.ts";

export interface Subscriber {
  /** 返回 false / 抛错 表示写入失败（背压/断开），注册表将其移除 */
  send(ev: GatewayEvent): Promise<boolean> | boolean;
}

/** 一个活跃会话的进程态：SDK 会话对象 + SSE 订阅者 + 事件环形缓冲。 */
export class SessionCtx {
  streaming = false;
  lastLiveAt = Date.now();
  readonly subscribers = new Set<Subscriber>();
  private buffer: GatewayEvent[] = [];
  private seqCounter = 0;
  private lastTurnMeta?: TurnMeta;
  private turnCounter = 0;
  /** 已完成的 turn 数（终态 agent_end 计入；自动快照判定用）。 */
  get turnCount(): number {
    return this.turnCounter;
  }
  private terminalListeners = new Set<() => void>();
  private disposed = false;
  /** createAgentSession 结果里的发现项（SDK 桥 GET /mcp、/lsp 用）。 */
  mcpManager?: unknown;
  lspServers?: unknown;
  /** 本会话的私有 AgentRegistry（Agent Hub 名册）。 */
  agentRegistry?: unknown;
  /** 持久化子代理复活器工厂（M8）：ref→reviver，revive 端点用。 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  persistedReviverFactory?: (ref: any) => Promise<any>;
  /** 审批策略（M6）：null = 未启用；tools 命中的工具调用需人工放行。 */
  approvalPolicy?: { tools: string[] | "all"; timeoutMs: number } | null;
  private approvalSeq = 0;
  /** 业务事件关联状态（DESIGN §22.5）：pending=已注入待下个 turn；active=当前响应链归属。 */
  private businessSeq = 0;
  private pendingBusiness?: { eventId: string; type: string };
  private activeBusiness?: { eventId: string; type: string };
  private pendingApprovals = new Map<
    string,
    {
      tool: string;
      args: unknown;
      resolve: (d: { approved: boolean; reason?: string }) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  /** SDK 事件退订（fork/branch 原地换绑时使用）。 */
  unsubscribeEvent?: () => void;
  /** omp 会话 id（集成端钩子桥的映射键，DESIGN §23）。 */
  ompSessionId?: string;
  /** 会话文件路径（factory 落定；snapshot/DB 同步用）。 */
  sessionFile?: string | null;
  /** turn 边界自动快照钩子（factory 注入，fire-and-forget）。 */
  snapshotHook?: () => void;

  /** fork/branch 原地换绑：退订事件、告知旧订阅者会话已迁走。 */
  detachForRebind(newSid: string, reason: string): void {
    this.publish({ type: "session.status_changed", from: this.sid, to: newSid, reason });
    this.unsubscribeEvent?.();
    this.rejectAllApprovals("session rebound");
    this.subscribers.clear();
    this.disposed = true;
  }

  private rejectAllApprovals(reason: string): void {
    for (const [, p] of this.pendingApprovals) p.resolve({ approved: false, reason });
    this.pendingApprovals.clear();
  }

  constructor(
    readonly sid: string,
    readonly userId: string,
    readonly workspaceDir: string,
    readonly session: AgentSession,
    /** 终态 turn 的用量回调（session-factory 注入：落库 + 计数），fire-and-forget。 */
    private readonly usageSink?: (meta: TurnMeta, turn: number) => void,
  ) {}

  /** 注册终态回调（流式槽位释放等）；返回退订函数。已 dispose 则立即触发。 */
  onTerminal(fn: () => void): () => void {
    if (this.disposed) {
      queueMicrotask(fn);
      return () => {};
    }
    this.terminalListeners.add(fn);
    return () => this.terminalListeners.delete(fn);
  }

  /**
   * 等待下一个 turn 终态（集成端同步模式用，DESIGN §22）。
   * 会话不在 streaming 时立即返回 true；超时返回 false。
   */
  waitTerminal(timeoutMs: number): Promise<boolean> {
    if (!this.streaming) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let off: (() => void) | null = null;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off?.();
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), Math.max(timeoutMs, 1));
      timer.unref?.();
      off = this.onTerminal(() => finish(true));
    });
  }

  /**
   * 等待进入 streaming（admission 到 agent_start 的窗口，DESIGN §22 wait 语义）。
   * 用于避免 "admission 后立即判 idle → 提前返回"。
   */
  waitStreamingStart(timeoutMs: number): Promise<boolean> {
    if (this.streaming) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const deadline = Date.now() + Math.max(timeoutMs, 1);
      const tick = () => {
        if (this.streaming) return resolve(true);
        if (Date.now() >= deadline) return resolve(false);
        const t = setTimeout(tick, 50);
        t.unref?.();
      };
      tick();
    });
  }

  /** disposeSession 调用：触发全部终态回调（释放槽位），此后新回调立即触发。 */
  markDisposed(): void {
    if (this.disposed) return;
    this.disposed = true;
    const listeners = [...this.terminalListeners];
    this.terminalListeners.clear();
    for (const l of listeners) {
      try {
        l();
      } catch {}
    }
  }

  /** 把 SDK 事件规范化后广播（session-factory 已把 omp 事件接入）。 */
  dispatchOmp(evt: AgentSessionEvent): void {
    if (evt.type === "agent_start") {
      this.streaming = true;
      // 业务事件（DESIGN §22.5）：pending 在下一个 turn 开始时提升为 active
      if (!this.activeBusiness && this.pendingBusiness) {
        this.activeBusiness = this.pendingBusiness;
        this.pendingBusiness = undefined;
      }
    }
    // turn_end 本体透传为 omp.raw，但其 usage/provider/model 备忘给随后的 agent_end
    if (evt.type === "turn_end") {
      const meta = metaOfTurnEnd(evt);
      if (meta) this.lastTurnMeta = meta;
    }
    if (evt.type === "agent_end" && evt.isTerminal !== false) this.streaming = false;
    this.lastLiveAt = Date.now();
    let payload = normalizeOmpEvent(evt);
    if (payload.type === "turn.completed" && payload.isTerminal) {
      // 终态：通知持槽者（流式槽位释放）——一次性，触发后清空
      const listeners = [...this.terminalListeners];
      this.terminalListeners.clear();
      for (const l of listeners) {
        try {
          l();
        } catch {}
      }
    }
    if (payload.type === "turn.completed") {
      const turn = ++this.turnCounter;
      if (this.lastTurnMeta) {
        payload = { ...payload, usage: this.lastTurnMeta.usage };
        try {
          this.usageSink?.(this.lastTurnMeta, turn);
        } catch {
          // 统计落库失败不阻断事件流
        }
        this.lastTurnMeta = undefined;
      }
      // turn 边界自动快照（fire-and-forget；无文件/空文件静默跳过）
      if (payload.isTerminal) {
        try {
          this.snapshotHook?.();
        } catch {}
      }
    }
    // model_changed 事件无负载，从会话对象补齐
    if (payload.type === "model.changed") {
      const m = (this.session as unknown as { model?: { provider?: string; id?: string } }).model;
      if (m?.provider && m?.id) payload = { type: "model.changed", provider: m.provider, modelId: m.id };
    }
    // 业务事件关联（DESIGN §22.5）：响应链内所有事件带 correlation；
    // 终态时先发 turn.completed（带 correlation），再发 business.completed 并清空。
    this.publish(this.withCorrelation(payload));
    if (payload.type === "turn.completed" && payload.isTerminal && this.activeBusiness) {
      const b = this.activeBusiness;
      this.activeBusiness = undefined;
      this.publish({
        type: "business.completed",
        eventId: b.eventId,
        eventType: b.type,
        status: "completed",
        ...(payload.usage ? { usage: payload.usage } : {}),
      });
    }
  }

  /** 业务事件注入（DESIGN §22.5）：立即广播 business.event，并登记为下一个 turn 的关联源。 */
  recordBusinessEvent(input: { type: string; data?: unknown; text: string }): { eventId: string } {
    const eventId = `be_${++this.businessSeq}_${Date.now().toString(36)}`;
    this.publish({
      type: "business.event",
      eventId,
      eventType: input.type,
      ...(input.data !== undefined ? { data: input.data } : {}),
      text: input.text,
    });
    if (this.streaming) {
      // 正在跑 turn：直接归属当前响应链（steer 会插进当前 turn）
      this.activeBusiness = { eventId, type: input.type };
    } else {
      this.pendingBusiness = { eventId, type: input.type };
    }
    return { eventId };
  }

  private withCorrelation(
    payload: GatewayEventPayload,
  ): GatewayEventPayload | (GatewayEventPayload & { correlation: GatewayCorrelation }) {
    if (!this.activeBusiness) return payload;
    return { ...payload, correlation: { eventId: this.activeBusiness.eventId, type: this.activeBusiness.type } };
  }

  publish(payload: GatewayEventPayload): void {
    const ev: GatewayEvent = { ...payload, seq: ++this.seqCounter, ts: Date.now() };
    this.buffer.push(ev);
    if (this.buffer.length > 500) this.buffer.splice(0, this.buffer.length - 500);
    for (const sub of this.subscribers) {
      try {
        const ok = sub.send(ev);
        if (ok instanceof Promise) ok.catch(() => this.subscribers.delete(sub));
        else if (!ok) this.subscribers.delete(sub);
      } catch {
        this.subscribers.delete(sub);
      }
    }
    // webhook 订阅分发（fire-and-forget，不阻塞 SSE）
    void dispatchWebhookEvent(this.userId, this.sid, ev);
  }

  /** Agent Hub 名册快照广播（registry.onChange 触发）。 */
  publishAgentsSnapshot(agents: unknown): void {
    this.publish({ type: "agents.changed", agents });
  }

  // ---- 审批流（M6，DESIGN §19）----

  /** 挂起一次工具审批：SSE 推 confirm_required；超时自动拒绝。审计三事件（M7）：requested/decide/timeout。 */
  requestApproval(tool: string, args: unknown, timeoutMs: number): Promise<{ approved: boolean; reason?: string }> {
    const approvalId = `ap_${++this.approvalSeq}_${Date.now().toString(36)}`;
    audit("approval.requested", "approval", approvalId, this.userId, { sessionId: this.sid, tool });
    // 集成端钩子通知（DESIGN §23）：审批请求/决议均可回调业务系统
    void import("../hook-engine.ts").then(({ notifyIntegrationHooks }) =>
      notifyIntegrationHooks(this.ompSessionId, "tool_approval_requested", {
        approvalId,
        tool,
        args,
        timeoutSec: Math.round(timeoutMs / 1000),
      }),
    );
    return new Promise((resolve) => {
      const settle = (d: { approved: boolean; reason?: string }) => {
        if (!this.pendingApprovals.delete(approvalId)) return;
        clearTimeout(timer);
        void import("../hook-engine.ts").then(({ notifyIntegrationHooks }) =>
          notifyIntegrationHooks(this.ompSessionId, "tool_approval_resolved", {
            approvalId,
            approved: d.approved,
            reason: d.reason,
          }),
        );
        resolve(d);
      };
      const timer = setTimeout(
        () => {
          audit("approval.timeout", "approval", approvalId, this.userId, { sessionId: this.sid, tool });
          settle({ approved: false, reason: "approval timeout" });
        },
        Math.max(timeoutMs, 1_000),
      );
      timer.unref?.();
      this.pendingApprovals.set(approvalId, { tool, args, resolve: settle, timer });
      this.publish({
        type: "tool.confirm_required",
        approvalId,
        tool,
        args,
        timeoutSec: Math.round(timeoutMs / 1000),
      } as never);
    });
  }

  resolveApproval(approvalId: string, approved: boolean, reason?: string): boolean {
    const p = this.pendingApprovals.get(approvalId);
    if (!p) return false;
    p.resolve({ approved, reason });
    return true;
  }

  pendingApprovalList(): Array<{ approvalId: string; tool: string; args: unknown }> {
    return [...this.pendingApprovals.entries()].map(([approvalId, p]) => ({ approvalId, tool: p.tool, args: p.args }));
  }

  /** 重连回放：返回 seq > lastEventId 的缓冲事件（ops 类不回放由调用方过滤）。 */
  replayAfter(lastEventId: number): GatewayEvent[] {
    return this.buffer.filter((ev) => ev.seq > lastEventId);
  }
}
