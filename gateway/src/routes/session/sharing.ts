/** 分享链接：签发（gwshare_ token 仅返回一次，库内只存 sha256）、列表、吊销。 */
import type { Hono } from "hono";
import { createHash } from "node:crypto";
import { audit, createShare, listShares, revokeShare } from "../../core/tenant-store.ts";
import { jsonError, ownedSession, type SessionEnv } from "./shared.ts";

/** 分享链接：签发（token 仅返回一次）/列表/吊销。 */
export function mountSharingRoutes(app: Hono<SessionEnv>): void {
  // ---- 分享链接（签发/吊销仅全权身份；view/control 语义见 shareGuard）----
  app.post("/:sid/share-link", async (c) => {
    const row = ownedSession(c.req.param("sid"), c.get("userId"));
    if (!row) return jsonError(c, 404, "NOT_FOUND", "session not found");
    const body = await c.req.json().catch(() => ({}) as any);
    const access = body?.access === "control" ? "control" : "view";
    const ttlSeconds = Number(body?.ttlSeconds ?? 0);
    const token = `gwshare_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
    const id = crypto.randomUUID();
    const expiresAt = ttlSeconds > 0 ? new Date(Date.now() + ttlSeconds * 1000).toISOString() : null;
    createShare({
      id,
      user_id: c.get("userId"),
      session_id: row.id,
      access,
      token_hash: createHash("sha256").update(token).digest("hex"),
      expires_at: expiresAt,
    });
    audit("session.share_link", "session", row.id, c.get("userId"), { access, expiresAt });
    return c.json({ id, token, access, expiresAt }, 201); // token 仅此一次返回
  });

  app.get("/:sid/share-links", (c) => {
    const row = ownedSession(c.req.param("sid"), c.get("userId"));
    if (!row) return jsonError(c, 404, "NOT_FOUND", "session not found");
    return c.json({ shares: listShares(row.id) });
  });

  app.delete("/:sid/share-link/:shareId", (c) => {
    const row = ownedSession(c.req.param("sid"), c.get("userId"));
    if (!row) return jsonError(c, 404, "NOT_FOUND", "session not found");
    const ok = revokeShare(c.req.param("shareId"), c.get("userId"));
    return ok ? c.json({ ok: true }) : jsonError(c, 404, "NOT_FOUND", "share not found");
  });
}
