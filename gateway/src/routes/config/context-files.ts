import { Hono } from "hono";
import * as fs from "node:fs/promises";
import path from "node:path";
import { userAgentDir } from "../../core/paths.ts";
import { audit } from "../../core/tenant-store.ts";
import { reloadUserContext } from "../../core/user-context.ts";
import type { ConfigEnv } from "./env.ts";

const app = new Hono<ConfigEnv>();

/** 上下文文件（DESIGN §26，对齐 docs/context-files）：用户级 AGENTS/RULES/APPEND_SYSTEM/SYSTEM 管理。 */
const CONTEXT_FILE_NAMES = ["AGENTS.md", "RULES.md", "APPEND_SYSTEM.md", "SYSTEM.md"] as const;
type ContextFileName = (typeof CONTEXT_FILE_NAMES)[number];

async function listUserContextFiles(uid: string) {
  const dir = userAgentDir(uid);
  const out: Array<{ name: string; bytes: number; updatedAt: string | null }> = [];
  for (const name of CONTEXT_FILE_NAMES) {
    const st = await fs.stat(path.join(dir, name)).catch(() => null);
    if (st?.isFile()) out.push({ name, bytes: st.size, updatedAt: st.mtime.toISOString() });
  }
  return out;
}

app.get("/me/context-files", async (c) => {
  const uid = c.get("userId");
  return c.json({
    files: await listUserContextFiles(uid),
    supported: CONTEXT_FILE_NAMES,
    dir: "agent/",
    note: "用户级上下文文件在新会话创建时被发现；项目级放 workspace 的 .omp/ 下（可用 /api/sessions/:sid/file 写入）",
  });
});

app.get("/me/context-files/:name", async (c) => {
  const uid = c.get("userId");
  const name = c.req.param("name") as ContextFileName;
  if (!CONTEXT_FILE_NAMES.includes(name)) {
    return c.json(
      { error: { code: "INVALID_NAME", message: `name must be one of ${CONTEXT_FILE_NAMES.join("|")}` } },
      400,
    );
  }
  const content = await fs.readFile(path.join(userAgentDir(uid), name), "utf8").catch(() => null);
  return content != null
    ? c.body(content, 200, { "content-type": "text/markdown; charset=utf-8" })
    : c.json({ error: { code: "NOT_FOUND", message: "context file not found" } }, 404);
});

app.put("/me/context-files/:name", async (c) => {
  const uid = c.get("userId");
  const name = c.req.param("name") as ContextFileName;
  if (!CONTEXT_FILE_NAMES.includes(name)) {
    return c.json(
      { error: { code: "INVALID_NAME", message: `name must be one of ${CONTEXT_FILE_NAMES.join("|")}` } },
      400,
    );
  }
  const text = await c.req.text();
  if (!text.trim()) return c.json({ error: { code: "BAD_REQUEST", message: "body (markdown text) required" } }, 400);
  if (text.length > 256 * 1024)
    return c.json({ error: { code: "PAYLOAD_TOO_LARGE", message: "context file exceeds 256KB" } }, 413);
  await fs.mkdir(userAgentDir(uid), { recursive: true });
  await fs.writeFile(path.join(userAgentDir(uid), name), text, "utf8");
  await reloadUserContext(uid);
  audit("config.context_file", "user", uid, uid, { name, bytes: text.length });
  return c.json(
    { ok: true, name, bytes: text.length, note: "applies to new sessions; live sessions keep their prompt" },
    201,
  );
});

app.delete("/me/context-files/:name", async (c) => {
  const uid = c.get("userId");
  const name = c.req.param("name") as ContextFileName;
  if (!CONTEXT_FILE_NAMES.includes(name)) {
    return c.json(
      { error: { code: "INVALID_NAME", message: `name must be one of ${CONTEXT_FILE_NAMES.join("|")}` } },
      400,
    );
  }
  const exists = (await listUserContextFiles(uid)).some((f) => f.name === name);
  if (!exists) return c.json({ error: { code: "NOT_FOUND", message: "context file not found" } }, 404);
  await fs.rm(path.join(userAgentDir(uid), name), { force: true });
  await reloadUserContext(uid);
  audit("config.context_file.delete", "user", uid, uid, { name });
  return c.json({ ok: true });
});

export { app as contextFilesApp };
