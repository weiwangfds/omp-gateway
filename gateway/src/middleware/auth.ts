/**
 * 认证与身份中间件（DESIGN §1/§16）。
 *
 * 身份模型：网关不持有用户体系。svc-token 通道由上游注入 X-User-Id（代用户）；
 * 分享令牌是唯一例外——凭 token 本身即可获得只读/会话内受限身份（collab"链接即权限"）。
 */
import { createMiddleware } from "hono/factory";
import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "../config.ts";
import { findShareByToken } from "../core/tenant-store.ts";

/** 身份标识格式（X-User-Id / X-Admin-Id / 终端桥 ?uid= 共用）。 */
export const USER_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

const sha256 = (s: string) => createHash("sha256").update(s).digest();

/** 恒时比较 token（sha256 定长后 timingSafeEqual），支持双 token 重叠窗口。
 *  导出给终端桥（WS 无法带 header，query token 走同一套校验）。 */
export function tokenAccepted(presented: string): boolean {
  const hashed = sha256(presented);
  return config.serviceTokens.some((t) => {
    try {
      return timingSafeEqual(hashed, sha256(t));
    } catch {
      return false;
    }
  });
}

declare module "hono" {
  interface ContextVariableMap {
    userId: string;
    /** 分享链接访问级（存在即非全权 svc-token 身份）。 */
    shareAccess?: "view" | "control";
    /** 分享令牌绑定的会话（仅可访问该会话）。 */
    shareSid?: string;
    /** 上级注入的全局管理标识（X-Admin-Id；仅 svc-token 通道生效，网关不验证权限只记录）。 */
    adminId?: string;
  }
}

/**
 * 服务间认证 + 身份注入：
 * 1. Authorization: Bearer <service-token>（上游全权身份）→ userId
 * 2. 失败时回落 X-Share-Token（collab 语义"链接即权限"）→ userId + shareAccess + shareSid
 */
export const authMiddleware = createMiddleware(async (c, next) => {
  if (config.serviceTokens.length === 0) {
    return c.json({ error: { code: "GATEWAY_UNCONFIGURED", message: "GATEWAY_SERVICE_TOKENS is not set" } }, 503);
  }

  const auth = c.req.header("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

  if (token && tokenAccepted(token)) {
    const userId = c.req.header("x-user-id") ?? "";
    if (!USER_ID_RE.test(userId)) {
      return c.json({ error: { code: "INVALID_USER_ID", message: "missing or malformed X-User-Id header" } }, 401);
    }
    c.set("userId", userId);
    // 权限模型（DESIGN §1 修订）：网关自身无权限体系——全局管理授权由上级注入标识
    // （X-Admin-Id，内网 svc-token 通道内可信）；网关只校验格式并在审计中记录该标识。
    const adminId = c.req.header("x-admin-id") ?? "";
    if (adminId && USER_ID_RE.test(adminId)) c.set("adminId", adminId);
    await next();
    return;
  }

  // 分享令牌回落（仅绑定单个会话；internal 面在 requireFullAuth 拒绝）
  const shareToken = c.req.header("x-share-token") ?? "";
  if (shareToken) {
    const share = findShareByToken(sha256(shareToken).toString("hex"));
    if (!share) return c.json({ error: { code: "UNAUTHORIZED", message: "invalid or expired share token" } }, 401);
    c.set("userId", share.user_id);
    c.set("shareAccess", share.access);
    c.set("shareSid", share.session_id);
    await next();
    return;
  }

  return c.json({ error: { code: "UNAUTHORIZED", message: "invalid or missing service token" } }, 401);
});

/** 内部/配置面专用：分享令牌身份一律拒绝（全权 svc-token 才能通过）。 */
export const requireFullAuth = createMiddleware(async (c, next) => {
  if (c.get("shareAccess")) {
    return c.json(
      { error: { code: "SHARE_TOKEN_FORBIDDEN", message: "share tokens cannot access this resource" } },
      403,
    );
  }
  await next();
});

/** 滚动发布排空标记（drain 开启后建会话 503、healthz 503；由 ops 与 maintenance 切换）。 */
export const draining = { value: false };

/** 全局层管理鉴权（/admin/global/*）：要求上级注入的 X-Admin-Id 标识（权限判定在上游）。 */
export const requireAdmin = createMiddleware(async (c, next) => {
  const adminId = c.get("adminId");
  if (!adminId) {
    return c.json(
      { error: { code: "ADMIN_REQUIRED", message: "upstream must inject X-Admin-Id for global management" } },
      403,
    );
  }
  await next();
});
