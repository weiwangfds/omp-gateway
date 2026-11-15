/**
 * bun test preload：在任何模块加载前设置环境，
 * 使进程内单元测试的 config/tenant-store 等模块单例落在隔离的临时数据根。
 * 集成/e2e 测试自行 spawn 子进程并传各自环境，不受此影响。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.GATEWAY_DATA_ROOT = mkdtempSync(path.join(tmpdir(), "omp-gw-unit-"));
process.env.GATEWAY_SERVICE_TOKENS = "tok-a,tok-b";
process.env.GATEWAY_SESSION_IDLE_TTL_MS = "60000";
