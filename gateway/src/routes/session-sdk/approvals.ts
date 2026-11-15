/** SDK 桥·审批：pending 清单与决定。状态机与超时在 SessionCtx（M6）。 */
import type { Hono } from "hono";
import type { SdkEnv, SdkShared } from "./shared.ts";
import { registry } from "../../core/session-registry.ts";
import { audit } from "../../core/tenant-store.ts";

/** 审批：pending 清单 + 决定（M6 语义，实际状态机在 SessionCtx）。 */
export function mountApprovalRoutes(app: Hono<SdkEnv>, shared: SdkShared): void {
  const { ownedSession, jsonError } = shared;

  // ---- 审批流（M6，DESIGN §19）：pending 清单 + 决定 ----
  app.get("/:sid/approvals", async (c) => {
    const row = ownedSession(c.req.param("sid"), c.get("userId"));
    if (!row) return jsonError(c, 404, "NOT_FOUND", "session not found");
    const ctx = registry.get(row.id);
    return c.json({
      approvals: ctx ? ctx.pendingApprovalList() : [],
      policy: (ctx as unknown as { approvalPolicy?: unknown }).approvalPolicy ?? null,
      live: Boolean(ctx),
    });
  });

  app.post("/:sid/approvals/:approvalId", async (c) => {
    const row = ownedSession(c.req.param("sid"), c.get("userId"));
    if (!row) return jsonError(c, 404, "NOT_FOUND", "session not found");
    const ctx = registry.get(row.id);
    if (!ctx) return jsonError(c, 404, "NOT_FOUND", "session not live");
    const body = await c.req.json().catch(() => null as any);
    if (typeof body?.approve !== "boolean") return jsonError(c, 400, "BAD_REQUEST", "body.approve (boolean) required");
    const ok = ctx.resolveApproval(
      c.req.param("approvalId"),
      body.approve,
      typeof body?.reason === "string" ? body.reason : undefined,
    );
    if (!ok) return jsonError(c, 404, "NOT_FOUND", "approval not found (already decided or expired)");
    audit("approval.decide", "approval", c.req.param("approvalId"), c.get("userId"), {
      sessionId: row.id,
      approve: body.approve,
    });
    return c.json({ ok: true, approved: body.approve });
  });
}
