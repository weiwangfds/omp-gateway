/**
 * 外发 HTTP 回调的统一签名（webhook / 集成端钩子 / HTTP 工具共用，DESIGN §22-§24）。
 *
 * 之前三处各自 createHmac，算法与头名分散；收敛后改算法或头名只动这一处。
 * 契约：`HMAC-SHA256(secret, rawBody) → hex`，放在 SIGNATURE_HEADER 头里；
 * 集成端必须对**原始 body 字节**验签，先 JSON.parse 再重新序列化会因空白差异失败。
 */
import { createHmac, randomBytes } from "node:crypto";

export const SIGNATURE_HEADER = "x-omp-signature";

/** 计算签名。secret 为注册回调时下发的一次性密钥（whsec_ 前缀）。 */
export function signPayload(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/** 生成回调密钥（webhook 与钩子共用 whsec_ 前缀，仅在创建响应里返回一次）。 */
export function generateSecret(prefix = "whsec"): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}
