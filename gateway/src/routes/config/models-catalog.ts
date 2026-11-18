import { Hono } from "hono";
import { getUserContext } from "../../core/user-context.ts";
import type { ConfigEnv } from "./env.ts";

const app = new Hono<ConfigEnv>();

/** 模型目录（DESIGN §21）：网页模型选择器的全局数据源（含成本/上下文窗口）。 */
app.get("/me/models", async (c) => {
  const uid = c.get("userId");
  const uctx = await getUserContext(uid);
  const reg = uctx.modelRegistry as unknown as {
    getAvailable?: (kind?: string) => Array<Record<string, any>>;
    refresh?: () => Promise<void>;
  };
  if (c.req.query("refresh") === "1" && typeof reg.refresh === "function") {
    try {
      await reg.refresh();
    } catch {}
  }
  const providerFilter = c.req.query("provider");
  const find = (c.req.query("find") ?? "").trim().toLowerCase();
  const all = (reg.getAvailable?.() ?? []) as Array<Record<string, any>>;
  const models = all
    .filter((m) => {
      if (providerFilter && m.provider !== providerFilter) return false;
      if (!find) return true;
      // 搜索 provider / modelId / name（对齐 omp models find）
      return (
        String(m.provider ?? "")
          .toLowerCase()
          .includes(find) ||
        String(m.id ?? "")
          .toLowerCase()
          .includes(find) ||
        String(m.name ?? "")
          .toLowerCase()
          .includes(find)
      );
    })
    .map((m) => ({
      provider: String(m.provider ?? ""),
      modelId: String(m.id ?? ""),
      name: m.name ?? null,
      contextWindow: m.contextWindow ?? null,
      maxTokens: m.maxTokens ?? null,
      cost: m.cost ?? null,
      supportsTools: m.supportsTools ?? null,
      supportsVision: m.supportsVision ?? null,
      supportsReasoning: m.supportsReasoning ?? null,
      kind: m.kind ?? null,
    }));
  const providers = [...new Set(models.map((m) => m.provider))].sort();
  return c.json({ total: models.length, providers, models });
});

/** 模型探针（pi-web "model test" 对标）：独立内存会话发一条探针，测 TTFT/总时长/错误。 */
app.post("/me/models/test", async (c) => {
  const uid = c.get("userId");
  const body = await c.req.json().catch(() => null as any);
  const provider = String(body?.provider ?? "");
  const modelId = String(body?.modelId ?? "");
  if (!provider || !modelId)
    return c.json({ error: { code: "BAD_REQUEST", message: "provider and modelId required" } }, 400);
  const uctx = await getUserContext(uid);
  const model = uctx.resolveModel(provider, modelId);
  if (!model)
    return c.json({ error: { code: "MODEL_NOT_FOUND", message: `Model not found: ${provider}/${modelId}` } }, 404);

  const { createAgentSession, SessionManager } = await import("@oh-my-pi/pi-coding-agent");
  const started = Date.now();
  let ttftMs: number | null = null;
  let firstDelta = true;
  // 探针会话提出到外层：失败路径也要 dispose（此前仅成功路径回收，失败探针泄漏会话）
  let probe: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const { session } = await createAgentSession({
      model,
      settings: uctx.settings,
      authStorage: uctx.authStorage,
      modelRegistry: uctx.modelRegistry,
      agentDir: uctx.agentDir,
      sessionManager: SessionManager.inMemory(),
      enableMCP: false,
      enableLsp: false,
      cacheWarming: false,
      hasUI: false,
      bindProcessState: false, // 一次性探针，绝不持有进程级 setting effects
    });
    probe = session;
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("probe timeout (30s)")), 30_000);
      timer.unref?.();
      session.subscribe((evt) => {
        if (firstDelta && evt.type === "message_update") {
          ttftMs = Date.now() - started;
          firstDelta = false;
        }
        if (evt.type === "agent_end" && evt.isTerminal !== false) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    await session.prompt(body?.prompt ? String(body.prompt) : "Reply with exactly: OK");
    await done;
    return c.json({ ok: true, ttftMs, durationMs: Date.now() - started });
  } catch (err) {
    return c.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      ttftMs,
      durationMs: Date.now() - started,
    });
  } finally {
    await probe?.dispose().catch(() => {});
  }
});

export { app as modelsCatalogApp };
