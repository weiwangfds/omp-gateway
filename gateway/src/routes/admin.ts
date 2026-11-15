/** 全局层管理（DESIGN §18）：全局 skills/plugins/MCP 的 CRUD，X-Admin-Id 门禁。 */
import { Hono } from "hono";
import * as fs from "node:fs/promises";
import path from "node:path";
import { globalMcpPath, globalSkillsDir, globalExtensionsDir } from "../core/paths.ts";
import {
  ManagementError,
  assertPluginName,
  deletePlugin,
  deleteSkill,
  listPluginsIn,
  listSkillsIn,
  readSkill,
  writePlugin,
  writeSkill,
} from "../core/registry-management.ts";
import { audit } from "../core/tenant-store.ts";
import { requireAdmin } from "../middleware/auth.ts";

/**
 * 全局层管理（DESIGN §18）：/admin/global/{mcp,skills,plugins}。
 * 权限模型：网关自身无权限体系——上级注入 X-Admin-Id 标识即视为管理层调用，
 * actor 记入审计（谁在管理由上游负责）。
 */
export const adminApp = new Hono();
adminApp.use("*", requireAdmin);

const mgmtErr = (c: any, err: unknown) => {
  if (err instanceof ManagementError) return c.json({ error: { code: err.code, message: err.message } }, 400);
  console.error("[admin]", err);
  return c.json({ error: { code: "INTERNAL", message: "management operation failed" } }, 500);
};
const actor = (c: any): string => c.get("adminId") ?? "admin";

// ---- 全局 skills ----
adminApp.get("/global/skills", async (c) => c.json({ skills: await listSkillsIn(globalSkillsDir()) }));

adminApp.get("/global/skills/:name", async (c) => {
  try {
    const content = await readSkill(globalSkillsDir(), c.req.param("name"));
    return content != null
      ? c.body(content, 200, { "content-type": "text/plain; charset=utf-8" })
      : c.json({ error: { code: "NOT_FOUND", message: "skill not found" } }, 404);
  } catch (err) {
    return mgmtErr(c, err);
  }
});

adminApp.put("/global/skills/:name", async (c) => {
  const body = await c.req.json().catch(() => null as any);
  if (typeof body?.description !== "string" || !body.description.trim()) {
    return c.json({ error: { code: "BAD_REQUEST", message: "body.description required" } }, 400);
  }
  try {
    await writeSkill(globalSkillsDir(), c.req.param("name"), { description: body.description, content: body?.content });
    audit("admin.global_skill.write", "global", c.req.param("name"), actor(c));
    return c.json({ ok: true, name: c.req.param("name"), scope: "global" }, 201);
  } catch (err) {
    return mgmtErr(c, err);
  }
});

adminApp.delete("/global/skills/:name", async (c) => {
  const ok = await deleteSkill(globalSkillsDir(), c.req.param("name"));
  if (ok) audit("admin.global_skill.delete", "global", c.req.param("name"), actor(c));
  return ok ? c.json({ ok: true }) : c.json({ error: { code: "NOT_FOUND", message: "skill not found" } }, 404);
});

// ---- 全局 plugins（extensions）----
adminApp.get("/global/plugins", async (c) => c.json({ plugins: await listPluginsIn(globalExtensionsDir()) }));

adminApp.get("/global/plugins/:name", async (c) => {
  const name = c.req.param("name");
  try {
    assertPluginName(name); // 命名净化：杜绝 ../ 穿越读取
  } catch (err) {
    return mgmtErr(c, err);
  }
  try {
    const content = await fs.readFile(path.join(globalExtensionsDir(), name), "utf8");
    return c.body(content, 200, { "content-type": "text/plain; charset=utf-8" });
  } catch {
    return c.json({ error: { code: "NOT_FOUND", message: "plugin not found" } }, 404);
  }
});

adminApp.put("/global/plugins/:name", async (c) => {
  const body = await c.req.text().catch(() => "");
  try {
    const r = await writePlugin(
      globalExtensionsDir(),
      c.req.param("name"),
      typeof body === "string" && body ? body : "",
    );
    audit("admin.global_plugin.write", "global", c.req.param("name"), actor(c), { bytes: r.bytes });
    return c.json({ ok: true, name: c.req.param("name"), scope: "global", ...r }, 201);
  } catch (err) {
    return mgmtErr(c, err);
  }
});

adminApp.delete("/global/plugins/:name", async (c) => {
  const ok = await deletePlugin(globalExtensionsDir(), c.req.param("name"));
  if (ok) audit("admin.global_plugin.delete", "global", c.req.param("name"), actor(c));
  return ok ? c.json({ ok: true }) : c.json({ error: { code: "NOT_FOUND", message: "plugin not found" } }, 404);
});

// ---- 全局 mcp.json ----
adminApp.get("/global/mcp", async (c) => {
  try {
    return c.body(await fs.readFile(globalMcpPath(), "utf8"), 200, { "content-type": "application/json" });
  } catch {
    return c.body(JSON.stringify({ mcpServers: {} }, null, 2), 200, { "content-type": "application/json" });
  }
});

adminApp.put("/global/mcp", async (c) => {
  const text = await c.req.text();
  try {
    JSON.parse(text);
  } catch (err) {
    return c.json({ error: { code: "INVALID_JSON", message: String(err) } }, 400);
  }
  await fs.writeFile(globalMcpPath(), text, "utf8");
  audit("admin.global_mcp.write", "global", "mcp.json", actor(c), { bytes: text.length });
  return c.json({ ok: true, note: "applies to new sessions (compose at session create)" });
});
