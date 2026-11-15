/** MCP 原始配置（agent/mcp.json）读写：仅挡语法错误，结构校验交给 omp 发现期。 */
import { Hono } from "hono";
import * as fs from "node:fs/promises";
import path from "node:path";
import { userAgentDir } from "../../core/paths.ts";
import { audit } from "../../core/tenant-store.ts";
import { reloadUserContext } from "../../core/user-context.ts";
import type { ConfigEnv } from "./env.ts";

const app = new Hono<ConfigEnv>();
const mcpPath = (uid: string) => path.join(userAgentDir(uid), "mcp.json");

app.get("/me/mcp", async (c) => {
  const uid = c.get("userId");
  try {
    return c.body(await fs.readFile(mcpPath(uid), "utf8"), 200, { "content-type": "application/json" });
  } catch {
    return c.body(JSON.stringify({ mcpServers: {} }, null, 2), 200, { "content-type": "application/json" });
  }
});

app.put("/me/mcp", async (c) => {
  const uid = c.get("userId");
  const text = await c.req.text();
  try {
    JSON.parse(text); // 结构校验交给 omp 发现期；这里只挡语法错误
  } catch (err) {
    return c.json({ error: { code: "INVALID_JSON", message: String(err) } }, 400);
  }
  await fs.mkdir(path.dirname(mcpPath(uid)), { recursive: true });
  await fs.writeFile(mcpPath(uid), text, "utf8");
  await reloadUserContext(uid);
  audit("config.mcp", "user", uid, uid, { bytes: text.length });
  return c.json({ ok: true, path: "agent/mcp.json" });
});

export { app as mcpApp };
