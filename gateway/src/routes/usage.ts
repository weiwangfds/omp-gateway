import { Hono } from "hono";
import { userUsage, type UsageBucket } from "../core/tenant-store.ts";
import { requireFullAuth } from "../middleware/auth.ts";

type Env = { Variables: { userId: string } };

/** 用户级用量聚合（对齐 LiteLLM/Open WebUI 口径）：按 day / model / session 分桶。🔒 全权身份限定。 */
export const usageApp = new Hono<Env>();
usageApp.use("*", requireFullAuth);

usageApp.get("/me/usage", (c) => {
  const uid = c.get("userId");
  const group = (c.req.query("group") ?? "day") as "day" | "model" | "session";
  if (!["day", "model", "session"].includes(group)) {
    return c.json({ error: { code: "BAD_REQUEST", message: "group must be day|model|session" } }, 400);
  }
  const buckets = userUsage(uid, group, c.req.query("from") ?? undefined, c.req.query("to") ?? undefined);
  const totals = buckets.reduce(
    (acc: UsageBucket, b) => ({
      key: "total",
      turns: acc.turns + b.turns,
      inputTokens: acc.inputTokens + b.inputTokens,
      outputTokens: acc.outputTokens + b.outputTokens,
      cacheRead: acc.cacheRead + b.cacheRead,
      cacheWrite: acc.cacheWrite + b.cacheWrite,
      totalTokens: acc.totalTokens + b.totalTokens,
      costUsd: acc.costUsd + b.costUsd,
    }),
    {
      key: "total",
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      costUsd: 0,
    },
  );
  return c.json({ group, totals, buckets });
});
