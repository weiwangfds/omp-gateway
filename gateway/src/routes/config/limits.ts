/** 配额面：/me/limits（限额+本月用量+RPM 窗口）与 /me/projects（按仓库聚合会话）。 */
import { Hono } from "hono";
import * as fs from "node:fs/promises";
import path from "node:path";
import { userWorkspace } from "../../core/paths.ts";
import { rpmWindowState } from "../../core/rate-limit.ts";
import {
  activeSessionCount,
  getOrCreateTenant,
  listSessions,
  monthCostUsd,
  tenantLimits,
} from "../../core/tenant-store.ts";
import type { ConfigEnv } from "./env.ts";

const app = new Hono<ConfigEnv>();

/** 配额状态（DESIGN §21 集成面）：网页显示限额/本月用量/预算余额/RPM 窗口。 */
app.get("/me/limits", async (c) => {
  const uid = c.get("userId");
  const t = getOrCreateTenant(uid);
  const limits = tenantLimits(t);
  const used = monthCostUsd(uid);
  const rpmState = rpmWindowState(uid);
  const budget = limits.monthlyBudgetUsd ?? null;
  return c.json({
    limits: {
      maxSessions: limits.maxSessions,
      maxConcurrent: limits.maxConcurrent,
      rpm: limits.rpm ?? null,
      monthlyBudgetUsd: budget,
    },
    usage: {
      activeSessions: activeSessionCount(uid),
      monthCostUsd: used,
      budgetRemainingUsd: budget != null ? Math.max(Number((budget - used).toFixed(6)), 0) : null,
      budgetExceeded: budget != null && used >= budget,
    },
    rpmWindow: { used: rpmState.used, limit: limits.rpm ?? null, resetInSec: rpmState.windowResetInSec },
  });
});

/** 项目/仓库维度聚合（pi-web sessions-by-repo 对标；只读派生，不动 1:1 workspace）。 */
const projectKeyCache = new Map<string, { key: string; name: string; at: number }>();
const PROJECT_TTL_MS = 5 * 60_000;

async function projectKeyOf(wsDir: string): Promise<{ key: string; name: string }> {
  const cached = projectKeyCache.get(wsDir);
  if (cached && Date.now() - cached.at < PROJECT_TTL_MS) return cached;
  let result = { key: path.basename(wsDir), name: path.basename(wsDir) };
  try {
    const cfg = await fs.readFile(path.join(wsDir, ".git", "config"), "utf8");
    const inOrigin = cfg.match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/s);
    if (inOrigin) {
      const url = inOrigin[1];
      const name =
        url
          .replace(/\.git$/, "")
          .split(/[/:]/)
          .pop() || result.name;
      result = { key: url, name };
    }
  } catch {}
  projectKeyCache.set(wsDir, { ...result, at: Date.now() });
  return result;
}

app.get("/me/projects", async (c) => {
  const uid = c.get("userId");
  const rows = [...listSessions(uid, "active"), ...listSessions(uid, "archived")];
  const groups = new Map<string, { key: string; name: string; sessions: number; lastActiveAt: string | null }>();
  for (const row of rows) {
    const { key, name } = await projectKeyOf(userWorkspace(uid, row.workspace_id));
    const g = groups.get(key) ?? { key, name, sessions: 0, lastActiveAt: null };
    g.sessions++;
    if (!g.lastActiveAt || row.updated_at > g.lastActiveAt) g.lastActiveAt = row.updated_at;
    groups.set(key, g);
  }
  return c.json({
    projects: [...groups.values()].sort((a, b) => (b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? "")),
  });
});

export { app as limitsApp };
