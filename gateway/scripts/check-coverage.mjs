import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const port = 8996;
const dataRoot = mkdtempSync(path.join(tmpdir(), "omp-cov-"));
const proc = Bun.spawn([process.execPath, "run", "src/index.ts"], {
  cwd: path.resolve(import.meta.dir, ".."),
  env: { ...process.env, GATEWAY_PORT: String(port), GATEWAY_DATA_ROOT: dataRoot, GATEWAY_SERVICE_TOKENS: "t" },
  stdout: "ignore",
  stderr: "ignore",
});
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(`${base}/healthz`)).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 300));
}
let spec;
try {
  spec = await (await fetch(`${base}/openapi.json`)).json();
} finally {
  proc.kill(); // fetch 抛错也要清理子进程
}
const missing = [];
for (const [p, methods] of Object.entries(spec.paths)) {
  for (const [m, op] of Object.entries(methods)) {
    const k = `${m.toUpperCase()} ${p}`;
    if (op.summary === k) missing.push(k);
  }
}
console.log("coverage:", JSON.stringify(spec["x-gateway-coverage"]));
console.log("missing summaries:", missing.length);
for (const k of missing) console.log("   ", k);
// 门禁语义：有缺失必须非零退出（此前永远 exit 0，CI 拦不住契约漂移）
if (missing.length > 0) process.exitCode = 1;
