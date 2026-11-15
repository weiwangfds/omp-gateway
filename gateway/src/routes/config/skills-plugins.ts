/** skill / plugin 的发现与用户级 CRUD（全局目录走 /admin/global/*）。 */
import { Hono } from "hono";
import * as fs from "node:fs/promises";
import path from "node:path";
import { globalExtensionsDir, globalSkillsDir, userAgentDir } from "../../core/paths.ts";
import { audit } from "../../core/tenant-store.ts";
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
} from "../../core/registry-management.ts";
import type { ConfigEnv } from "./env.ts";

const app = new Hono<ConfigEnv>();

const mgmtErr = (c: any, err: unknown) => {
  if (err instanceof ManagementError) return c.json({ error: { code: err.code, message: err.message } }, 400);
  console.error("[me.management]", err);
  return c.json({ error: { code: "INTERNAL", message: "management operation failed" } }, 500);
};

// ---- 发现项清单与用户级管理（DESIGN §18；变更对新会话生效）----

/** 该用户可见 skills：私有（agent/skills）+ 全局（global/skills），带 scope 标签。 */
app.get("/me/skills", async (c) => {
  const uid = c.get("userId");
  const userDir = path.join(userAgentDir(uid), "skills");
  const [priv, glob] = await Promise.all([listSkillsIn(userDir), listSkillsIn(globalSkillsDir())]);
  return c.json({
    skills: [...priv.map((s) => ({ ...s, scope: "user" })), ...glob.map((s) => ({ ...s, scope: "global" }))],
  });
});

app.put("/me/skills/:name", async (c) => {
  const uid = c.get("userId");
  const body = await c.req.json().catch(() => null as any);
  if (typeof body?.description !== "string" || !body.description.trim()) {
    return c.json({ error: { code: "BAD_REQUEST", message: "body.description required" } }, 400);
  }
  try {
    await writeSkill(path.join(userAgentDir(uid), "skills"), c.req.param("name"), {
      description: body.description,
      content: body?.content,
    });
    audit("me.skill.write", "skill", c.req.param("name"), uid, { scope: "user" });
    return c.json({ ok: true, name: c.req.param("name"), scope: "user" }, 201);
  } catch (err) {
    return mgmtErr(c, err);
  }
});

app.get("/me/skills/:name", async (c) => {
  const content = await readSkill(path.join(userAgentDir(c.get("userId")), "skills"), c.req.param("name"));
  return content != null
    ? c.body(content, 200, { "content-type": "text/plain; charset=utf-8" })
    : c.json({ error: { code: "NOT_FOUND", message: "skill not found" } }, 404);
});

app.delete("/me/skills/:name", async (c) => {
  const uid = c.get("userId");
  const ok = await deleteSkill(path.join(userAgentDir(uid), "skills"), c.req.param("name"));
  if (ok) audit("me.skill.delete", "skill", c.req.param("name"), uid);
  return ok ? c.json({ ok: true }) : c.json({ error: { code: "NOT_FOUND", message: "skill not found" } }, 404);
});

/** 该用户可见 plugins：私有 + 全局，带 scope 标签。 */
app.get("/me/plugins", async (c) => {
  const uid = c.get("userId");
  const extDir = path.join(userAgentDir(uid), "extensions");
  const [priv, glob] = await Promise.all([listPluginsIn(extDir), listPluginsIn(globalExtensionsDir())]);
  return c.json({
    plugins: [...priv.map((p) => ({ ...p, scope: "user" })), ...glob.map((p) => ({ ...p, scope: "global" }))],
  });
});

app.put("/me/plugins/:name", async (c) => {
  const uid = c.get("userId");
  const content = await c.req.text();
  try {
    const r = await writePlugin(path.join(userAgentDir(uid), "extensions"), c.req.param("name"), content);
    audit("me.plugin.write", "plugin", c.req.param("name"), uid, { bytes: r.bytes });
    return c.json({ ok: true, name: c.req.param("name"), scope: "user", ...r }, 201);
  } catch (err) {
    return mgmtErr(c, err);
  }
});

app.get("/me/plugins/:name", async (c) => {
  const uid = c.get("userId");
  const name = c.req.param("name");
  try {
    assertPluginName(name);
  } catch (err) {
    return mgmtErr(c, err);
  }
  try {
    const content = await fs.readFile(path.join(userAgentDir(uid), "extensions", name), "utf8");
    return c.body(content, 200, { "content-type": "text/plain; charset=utf-8" });
  } catch {
    return c.json({ error: { code: "NOT_FOUND", message: "plugin not found" } }, 404);
  }
});

app.delete("/me/plugins/:name", async (c) => {
  const uid = c.get("userId");
  const ok = await deletePlugin(path.join(userAgentDir(uid), "extensions"), c.req.param("name"));
  if (ok) audit("me.plugin.delete", "plugin", c.req.param("name"), uid);
  return ok ? c.json({ ok: true }) : c.json({ error: { code: "NOT_FOUND", message: "plugin not found" } }, 404);
});

export { app as skillsPluginsApp };
