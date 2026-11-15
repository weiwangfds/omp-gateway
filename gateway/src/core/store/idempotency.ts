// 幂等键（tenant-store 拆分，DESIGN §31）
import { db } from "./db.ts";

// ---- 幂等键（DESIGN §7：建会话/建快照写操作的 24h 重放窗口）----

/** 查 24h 窗口内的幂等命中；过期键视同不存在。 */
export function idempotencyGet(keyHash: string): { status_code: number; response_json: string } | undefined {
  return db
    .query("SELECT status_code, response_json FROM idempotency WHERE key_hash = ? AND created_at > ?")
    .get(keyHash, new Date(Date.now() - 86_400_000).toISOString()) as
    | { status_code: number; response_json: string }
    | undefined;
}

/** 缓存 2xx 响应（仅成功结果可重放）；写入时顺带清理过期键。 */
export function idempotencyPut(keyHash: string, statusCode: number, responseJson: string): void {
  // 顺带清理过期键
  db.run("DELETE FROM idempotency WHERE created_at < ?", [new Date(Date.now() - 86_400_000).toISOString()]);
  db.run("INSERT OR REPLACE INTO idempotency (key_hash, status_code, response_json, created_at) VALUES (?,?,?,?)", [
    keyHash,
    statusCode,
    responseJson,
    new Date().toISOString(),
  ]);
}
