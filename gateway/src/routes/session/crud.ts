/**
 * 会话 CRUD：列表（内联 live 状态/上下文占用/用量/末条消息预览）、内容搜索（JSONL 扫描）、
 * 详情、PATCH（标题/归档）、删除（confirm 语义 + pre_delete 快照 + trash）。
 */
import type { Hono } from "hono";
import * as fs from "node:fs/promises";
import { disposeSession } from "../../core/session-factory.ts";
import { fromStorePath } from "../../core/paths.ts";
import { registry } from "../../core/session-registry.ts";
import { createSnapshot } from "../../core/snapshot-service.ts";
import {
  audit,
  countSessions,
  listSessions,
  sessionUsageSummary,
  setSessionStatus,
  touchSession,
  usageTurns,
  type SessionRow,
} from "../../core/tenant-store.ts";
import { jsonError, ownedSession, type SessionEnv } from "./shared.ts";

/** 会话 CRUD：列表（内联 live/usage/lastMessage）、检索、详情、PATCH、删除（进 trash）。 */
export function mountSessionCrudRoutes(app: Hono<SessionEnv>): void {
  async function peekLastMessage(sessionFile: string): Promise<string | null> {
    try {
      const fh = await fs.open(sessionFile, "r");
      try {
        const size = (await fh.stat()).size;
        const tail = Buffer.alloc(Math.min(size, 8192));
        await fh.read(tail, 0, tail.length, Math.max(0, size - tail.length));
        const ls = tail.toString("utf8").split("\n").filter(Boolean).reverse();
        for (const line of ls) {
          try {
            const entry = JSON.parse(line) as {
              type?: string;
              message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
            };
            const content = entry.message?.content;
            if (Array.isArray(content)) {
              const text = content.find((c) => c?.type === "text")?.text;
              if (typeof text === "string" && text.trim()) return text.trim().slice(0, 160);
            }
          } catch {}
        }
      } finally {
        await fh.close();
      }
    } catch {}
    return null;
  }

  app.get("/", async (c) => {
    const userId = c.get("userId");
    const status = (c.req.query("status") ?? "active") as SessionRow["status"];
    const rows = listSessions(
      userId,
      status,
      Number(c.req.query("per_page") ?? 50),
      Number(c.req.query("page") ?? 0),
      c.req.query("q"),
    );
    // pi-web 对标：列表内联运行态/用量/上下文/预览（页大小有限，N+1 可接受）
    const enriched = await Promise.all(
      rows.map(async (row) => {
        const ctx = registry.get(row.id);
        let contextPercent: number | null = null;
        if (ctx) {
          try {
            const cu = (ctx.session as unknown as { getContextUsage?: (o?: unknown) => any }).getContextUsage?.();
            const pct = cu?.percent ?? (cu?.tokens && cu?.contextWindow ? (cu.tokens / cu.contextWindow) * 100 : null);
            if (typeof pct === "number" && Number.isFinite(pct)) contextPercent = Math.round(pct * 10) / 10;
          } catch {}
        }
        const u = sessionUsageSummary(row.id);
        return {
          ...row,
          live: { present: Boolean(ctx), status: ctx?.streaming ? "streaming" : ctx ? "idle" : null },
          contextPercent,
          lastMessage: row.session_file ? await peekLastMessage(fromStorePath(row.session_file)) : null,
          usage: {
            turns: u.turns,
            inputTokens: u.inputTokens,
            outputTokens: u.outputTokens,
            totalTokens: u.totalTokens,
            costUsd: u.costUsd,
          },
        };
      }),
    );
    const perPage = Number(c.req.query("per_page") ?? 50);
    const page = Number(c.req.query("page") ?? 0);
    return c.json({
      sessions: enriched,
      total: countSessions(userId, status, c.req.query("q")), // 分页总数（集成方翻页用）
      page,
      perPage,
    });
  });

  /**
   * 会话内容搜索（DESIGN §21，网页"找历史对话"）：标题走 SQL LIKE（列表 ?q=），
   * 正文扫该用户会话 JSONL（限文件数/大小，只回 snippet）。必须先于 /:sid 注册。
   */
  app.get("/search", async (c) => {
    const uid = c.get("userId");
    const q = String(c.req.query("q") ?? "").trim();
    if (q.length < 2) return jsonError(c, 400, "BAD_REQUEST", "q (>=2 chars) required");
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 20), 1), 50);
    const maxFiles = Math.min(Math.max(Number(c.req.query("maxFiles") ?? 200), 1), 500);
    const rows = [...listSessions(uid, "active", maxFiles), ...listSessions(uid, "archived", maxFiles)];
    const needle = q.toLowerCase();
    const results: Array<{
      sessionId: string;
      title: string | null;
      status: string;
      matches: number;
      snippet: string | null;
    }> = [];
    for (const row of rows) {
      if (results.length >= limit) break;
      const file = row.session_file ? fromStorePath(row.session_file) : "";
      if (!file) continue;
      const stat = await fs.stat(file).catch(() => null);
      if (!stat?.isFile() || stat.size > 8 * 1024 * 1024) continue; // 上限 8MB/文件
      const text = await fs.readFile(file, "utf8").catch(() => "");
      if (!text) continue;
      const lines = text.split("\n");
      let matches = 0;
      let snippet: string | null = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line?.toLowerCase().includes(needle)) continue;
        matches++;
        if (!snippet) {
          const idx = line.toLowerCase().indexOf(needle);
          snippet = line
            .slice(Math.max(0, idx - 60), Math.min(line.length, idx + needle.length + 90))
            .replace(/\\n/g, " ");
        }
        if (matches >= 5) break;
      }
      if (matches > 0) {
        results.push({ sessionId: row.id, title: row.title ?? null, status: row.status, matches, snippet });
      }
    }
    return c.json({ q, total: results.length, results });
  });

  app.get("/:sid", (c) => {
    const row = ownedSession(c.req.param("sid"), c.get("userId"));
    if (!row) return jsonError(c, 404, "NOT_FOUND", "session not found");
    const ctx = registry.get(row.id);
    return c.json({
      ...row,
      live: ctx
        ? { present: true, status: ctx.streaming ? "streaming" : "idle", subscribers: ctx.subscribers.size }
        : { present: false },
      usage: sessionUsageSummary(row.id),
    });
  });

  /** 会话用量：总计 + 逐 turn 明细（最近 50 条）。 */
  app.get("/:sid/usage", (c) => {
    const row = ownedSession(c.req.param("sid"), c.get("userId"));
    if (!row) return jsonError(c, 404, "NOT_FOUND", "session not found");
    return c.json({ summary: sessionUsageSummary(row.id), turns: usageTurns(row.id, 50) });
  });

  app.patch("/:sid", async (c) => {
    const row = ownedSession(c.req.param("sid"), c.get("userId"));
    if (!row) return jsonError(c, 404, "NOT_FOUND", "session not found");
    const body = await c.req.json().catch(() => ({}) as any);

    if (typeof body?.title === "string") touchSession(row.id, { title: body.title });

    if (body?.status === "archived" || body?.status === "active") {
      const to = body.status as "archived" | "active";
      if (to === "archived") {
        const ctx = registry.get(row.id);
        if (ctx) await disposeSession(ctx); // 归档=释放进程态，文件保留
      }
      setSessionStatus(row.id, to);
      audit("session.status", "session", row.id, c.get("userId"), { to });
    }
    return c.json({ id: row.id, status: body?.status ?? row.status });
  });

  app.delete("/:sid", async (c) => {
    const sid = c.req.param("sid");
    const row = ownedSession(sid, c.get("userId"));
    if (!row) return jsonError(c, 404, "NOT_FOUND", "session not found");
    if (c.req.query("confirm") !== sid) {
      return jsonError(c, 400, "CONFIRM_REQUIRED", `pass ?confirm=${sid} to delete`);
    }
    // 进 trash 前自动物化快照（M4 pre_delete：purger 移走文件后仍可从快照找回内容）
    try {
      await createSnapshot(c.get("userId"), sid, { kind: "auto", trigger: "pre_delete", turn: null });
    } catch {}
    const ctx = registry.get(sid);
    if (ctx) await disposeSession(ctx);
    setSessionStatus(sid, "deleted"); // trash 窗口 30d，期间可经 /internal/trash 找回
    audit("session.delete", "session", sid, c.get("userId"));
    return c.json({ id: sid, status: "deleted" });
  });
}
