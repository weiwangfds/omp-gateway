/** 模型角色（docs/roles）：modelRoles / cycleOrder 的用户级读写（config.yml）。 */
import type { Hono } from "hono";
import { userSettings } from "../../core/settings-facade.ts";
import { audit } from "../../core/tenant-store.ts";
import { getUserContext } from "../../core/user-context.ts";
import type { AgentConfigEnv } from "./env.ts";

/** 模型角色（docs/roles）：modelRoles / cycleOrder 读写（用户级 config.yml）。 */
export function mountModelRoleRoutes(app: Hono<AgentConfigEnv>): void {
  const ROLE_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
  const DEFAULT_CYCLE_ORDER = ["smol", "default", "slow"];

  // ---- 模型角色（docs/roles）----

  app.get("/me/model-roles", async (c) => {
    const uctx = await getUserContext(c.get("userId"));
    const { cfgModelRoles, cfgCycleOrder, cfgModelRoleStorage } = await import(
      "@oh-my-pi/pi-coding-agent/config/model-settings"
    );
    return c.json({
      roles: (cfgModelRoles.get(uctx.settings) ?? {}) as Record<string, string>,
      cycleOrder: (cfgCycleOrder.get(uctx.settings) ?? DEFAULT_CYCLE_ORDER) as string[],
      roleStorage: cfgModelRoleStorage.get(uctx.settings) ?? "global",
      note: "值可为 provider/model[:thinking]、@role 别名、* (=@default) 或逗号分隔有序选择器；变更对新会话生效",
    });
  });

  app.put("/me/model-roles", async (c) => {
    const uid = c.get("userId");
    const body = await c.req.json().catch(() => null as any);
    const { cfgModelRoles, cfgCycleOrder } = await import("@oh-my-pi/pi-coding-agent/config/model-settings");

    if (body?.roles !== undefined) {
      if (typeof body.roles !== "object" || Array.isArray(body.roles) || body.roles === null) {
        return c.json(
          { error: { code: "BAD_REQUEST", message: "body.roles must be an object of role → selector" } },
          400,
        );
      }
      for (const [role, selector] of Object.entries(body.roles)) {
        if (!ROLE_NAME_RE.test(role)) {
          return c.json(
            { error: { code: "BAD_REQUEST", message: `role name "${role}" invalid (^[a-z][a-z0-9_-]{0,31}$)` } },
            400,
          );
        }
        if (typeof selector !== "string" || !selector.trim() || selector.length > 512) {
          return c.json(
            {
              error: { code: "BAD_REQUEST", message: `selector for role "${role}" must be a non-empty string (≤512)` },
            },
            400,
          );
        }
      }
      await userSettings.write(uid, cfgModelRoles as never, body.roles as never);
    }

    if (body?.cycleOrder !== undefined) {
      if (!Array.isArray(body.cycleOrder)) {
        return c.json({ error: { code: "BAD_REQUEST", message: "body.cycleOrder must be a string[]" } }, 400);
      }
      for (const r of body.cycleOrder) {
        if (typeof r !== "string" || !ROLE_NAME_RE.test(r)) {
          return c.json({ error: { code: "BAD_REQUEST", message: `cycleOrder entry "${String(r)}" invalid` } }, 400);
        }
      }
      await userSettings.write(uid, cfgCycleOrder as never, body.cycleOrder as never);
    }

    if (body?.roles === undefined && body?.cycleOrder === undefined) {
      return c.json({ error: { code: "BAD_REQUEST", message: "body.roles and/or body.cycleOrder required" } }, 400);
    }
    audit("config.model_roles", "user", uid, uid, {
      roles: body?.roles ? Object.keys(body.roles) : undefined,
      cycleOrder: body?.cycleOrder,
    });
    return c.json({
      ok: true,
      roles: ((await userSettings.read(uid, cfgModelRoles as never)) ?? {}) as Record<string, string>,
      cycleOrder: ((await userSettings.read(uid, cfgCycleOrder as never)) ?? DEFAULT_CYCLE_ORDER) as string[],
    });
  });
}
