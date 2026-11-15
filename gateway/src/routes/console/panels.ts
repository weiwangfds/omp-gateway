import type { Hono } from "hono";
import { audit } from "../../core/tenant-store.ts";
import type { ConsoleEnv, ConsoleShared } from "./shared.ts";

/** 只读面板：命令菜单/todos/context/modes/session-tree/context-files/plan/maintenance。 */
export function mountConsolePanelRoutes(app: Hono<ConsoleEnv>, shared: ConsoleShared): void {
  const { live, s, jsonError } = shared;

  // ---- 命令面板：TUI `/` 菜单的完整数据面（文件式 slash + TS custom + MCP prompts + 模板）----
  app.get("/:sid/commands", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    const session = s(r.ctx);
    const slash = (session.slashCommands ?? []) as Array<{
      name: string;
      description?: string;
      argumentHint?: string;
      side?: boolean;
    }>;
    const custom = (session.customCommands ?? []) as Array<{
      command?: { name?: string; description?: string };
      source?: string;
      path?: string;
    }>;
    const mcp = (session.mcpPromptCommands ?? []) as Array<{
      command?: { name?: string; description?: string };
      source?: string;
    }>;
    const templates = (session.promptTemplates ?? []) as Array<{ name: string; description?: string; source?: string }>;
    return c.json({
      slashCommands: slash.map((x) => ({
        name: x.name,
        description: x.description ?? "",
        ...(x.argumentHint ? { argumentHint: x.argumentHint } : {}),
        ...(x.side ? { side: true } : {}),
      })),
      customCommands: custom.map((x) => ({
        name: String(x.command?.name ?? ""),
        description: String(x.command?.description ?? ""),
        ...(x.source ? { source: x.source } : {}),
      })),
      mcpPrompts: mcp.map((x) => ({
        name: String(x.command?.name ?? ""),
        description: String(x.command?.description ?? ""),
      })),
      templates: templates.map((x) => ({ name: x.name, description: x.description ?? "", source: x.source ?? "" })),
    });
  });

  // ---- Todo 面板（omp todo 工具的阶段列表；PUT = 用户手工编辑，落 user_todo_edit 条目）----
  app.get("/:sid/todos", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    const session = s(r.ctx);
    return c.json({ phases: session.getTodoPhases?.() ?? [] });
  });

  app.put("/:sid/todos", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    const body = await c.req.json().catch(() => null as any);
    if (!Array.isArray(body?.phases)) return jsonError(c, 400, "BAD_REQUEST", "body.phases (array) required");
    const session = s(r.ctx);
    if (typeof session.setTodoPhases !== "function") {
      return jsonError(c, 409, "NOT_SUPPORTED", "todo phases not editable in this SDK build");
    }
    session.setTodoPhases(body.phases);
    audit("session.set_todos", "session", r.row.id, c.get("userId"), { phases: body.phases.length });
    return c.json({ ok: true, phases: session.getTodoPhases?.() ?? [] });
  });

  // ---- 上下文用量（窗口占用 + 分桶明细；网页上下文条/详情弹窗）----
  app.get("/:sid/context", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    const session = s(r.ctx);
    const cw = c.req.query("contextWindow");
    const opts = cw ? { contextWindow: Number(cw) } : undefined;
    const usage = (() => {
      try {
        return session.getContextUsage?.(opts) ?? null;
      } catch {
        return null;
      }
    })();
    const breakdown = (() => {
      try {
        return session.getContextBreakdown?.(opts) ?? null;
      } catch {
        return null;
      }
    })();
    return c.json({ usage, breakdown });
  });

  // ---- 模式面板（plan/goal/vibe/prewalk/checkpoint/rewind/usage-limit/service-tier）----
  app.get("/:sid/modes", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    const session = s(r.ctx);
    const safe = (fn: () => unknown) => {
      try {
        return fn() ?? null;
      } catch {
        return null;
      }
    };
    return c.json({
      plan: safe(() => session.getPlanModeState?.()),
      goal: safe(() => session.getGoalModeState?.()),
      vibe: safe(() => session.getVibeModeState?.()),
      prewalk: safe(() => session.getPrewalkState?.()),
      checkpoint: safe(() => session.getCheckpointState?.()),
      lastRewind: safe(() => session.getLastCompletedRewind?.()),
      usageLimit: safe(() => session.getUsageLimitState?.()),
      serviceTier: safe(() => session.effectiveServiceTier?.()),
      autoCompaction: safe(() => session.autoCompactionEnabled),
      autoRetry: safe(() => session.autoRetryEnabled),
      isCompacting: safe(() => session.isCompacting ?? false),
      isRetrying: safe(() => session.isRetrying ?? false),
      isBashRunning: safe(() => session.isBashRunning ?? false),
      isEvalRunning: safe(() => session.isEvalRunning ?? false),
      isGeneratingHandoff: safe(() => session.isGeneratingHandoff ?? false),
    });
  });

  // ---- 分叉树（sessionManager.getTree()；网页分叉历史可视化）----
  app.get("/:sid/session-tree", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    const sm = (
      r.ctx.session as unknown as { sessionManager?: { getTree?: () => unknown; getLeafId?: () => string | null } }
    ).sessionManager;
    const raw = (sm?.getTree?.() ?? []) as Array<any>;
    // 裁剪：entry 只留寻址/展示字段（正文太大），保留树形结构
    const trim = (node: any, depth: number): any => ({
      id: node?.entry?.id ? String(node.entry.id) : null,
      type: node?.entry?.type ? String(node.entry.type) : null,
      role: node?.entry?.message?.role ?? null,
      preview:
        typeof node?.entry?.message?.content?.[0]?.text === "string"
          ? String(node.entry.message.content[0].text).slice(0, 120)
          : null,
      ...(node?.label ? { label: String(node.label) } : {}),
      children:
        depth >= 40 ? [] : Array.isArray(node?.children) ? node.children.map((ch: any) => trim(ch, depth + 1)) : [],
    });
    return c.json({ leafId: sm?.getLeafId?.() ?? null, tree: raw.map((n) => trim(n, 0)) });
  });

  // ---- 上下文文件发现（DESIGN §26，对齐 docs/context-files）----
  // 网关侧扫描（SDK systemPromptSources 只有 block 级来源，缺文件级定位）：
  // 用户级 = agentDir 四个文件；项目级 = workspace 及 .omp/；applied = 内容是否命中系统提示词。
  app.get("/:sid/context-files", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    const session = s(r.ctx);
    const { userAgentDir } = await import("../../core/paths.ts");
    const fsMod = await import("node:fs/promises");
    const pathMod = await import("node:path");
    const uid = c.get("userId");
    const workspace = r.ctx.workspaceDir;
    const agentDir = userAgentDir(uid);
    const names = ["AGENTS.md", "RULES.md", "APPEND_SYSTEM.md", "SYSTEM.md"];
    const candidates: Array<{ scope: "user" | "project"; name: string; file: string }> = [];
    for (const n of names) candidates.push({ scope: "user", name: n, file: pathMod.join(agentDir, n) });
    for (const n of names) {
      candidates.push({ scope: "project", name: n, file: pathMod.join(workspace, n) });
      candidates.push({ scope: "project", name: n, file: pathMod.join(workspace, ".omp", n) });
    }
    const promptText = (() => {
      try {
        const sp = session.systemPrompt as string[] | undefined;
        return Array.isArray(sp) ? sp.join("\n") : "";
      } catch {
        return "";
      }
    })();
    const files: Array<Record<string, unknown>> = [];
    for (const cand of candidates) {
      const st = await fsMod.stat(cand.file).catch(() => null);
      if (!st?.isFile()) continue;
      const head = (await fsMod.readFile(cand.file, "utf8").catch(() => "")).trim().slice(0, 120);
      // applied 判定：取首个非空行（≥8 字符）在系统提示词中命中
      const probe =
        head
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length >= 4)
          .sort((a, b) => b.length - a.length)[0] ?? "";
      const applied = probe.length >= 4 ? promptText.includes(probe) : false;
      files.push({ scope: cand.scope, name: cand.name, path: cand.file, bytes: st.size, applied });
    }
    const src = (() => {
      try {
        return session.systemPromptSources as
          | { blocks: string[]; sources: Array<{ id: string; kind: string; label: string; path?: string }> }
          | undefined;
      } catch {
        return undefined;
      }
    })();
    return c.json({
      files,
      skills: (src?.sources ?? [])
        .filter((x) => x.kind === "skills")
        .map((x) => ({ id: x.id, label: x.label, ...(x.path ? { path: x.path } : {}) })),
      promptBlocks: src?.blocks?.length ?? 0,
      note: "applied=true 表示该文件内容已进入当前会话的系统提示词；变更对新会话生效（或 /new）",
    });
  });

  // ---- 计划参考文件（plan 模式引用的文件路径）----
  app.get("/:sid/plan", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    const session = s(r.ctx);
    const safe = (fn: () => unknown) => {
      try {
        return fn() ?? null;
      } catch {
        return null;
      }
    };
    return c.json({
      state: safe(() => session.getPlanModeState?.()),
      referencePath: safe(() => session.getPlanReferencePath?.()),
    });
  });

  // ---- 自动压缩/重试开关（网页设置面板；写 config 层）----
  app.get("/:sid/maintenance", async (c) => {
    const r = await live(c);
    if ("error" in r) return r.error;
    const session = s(r.ctx);
    const safe = (fn: () => unknown) => {
      try {
        return fn() ?? null;
      } catch {
        return null;
      }
    };
    return c.json({
      autoCompaction: safe(() => session.autoCompactionEnabled),
      autoRetry: safe(() => session.autoRetryEnabled),
      cacheWarming: safe(() => session.cacheWarmingStatus),
      promptCache: safe(() => session.getPromptCacheStatus?.()),
    });
  });
}
