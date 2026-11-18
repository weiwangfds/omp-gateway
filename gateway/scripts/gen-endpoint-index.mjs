// 生成 docs/endpoint-index.md（由运行时 openapi 派生，避免与实现漂移）
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const port = 8995;
const dataRoot = mkdtempSync(path.join(tmpdir(), "omp-idx-"));
const proc = Bun.spawn([process.execPath, "run", "src/index.ts"], {
  cwd: path.resolve(import.meta.dir, ".."),
  env: { ...process.env, GATEWAY_PORT: String(port), GATEWAY_DATA_ROOT: dataRoot, GATEWAY_SERVICE_TOKENS: "t" },
  stdout: "ignore",
  stderr: "ignore",
});
const base = `http://127.0.0.1:${port}`;
let healthy = false;
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(`${base}/healthz`)).ok) {
      healthy = true;
      break;
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 300));
}
if (!healthy) {
  // 起不来要立刻报错退出：继续 fetch 只会得到难懂的连接错误，且此前不清理子进程
  console.error(`gateway failed to start on :${port} within 18s`);
  proc.kill();
  process.exit(1);
}
const spec = await (await fetch(`${base}/openapi.json`)).json();
proc.kill();

const groups = new Map();
for (const [p, methods] of Object.entries(spec.paths)) {
  for (const [m, op] of Object.entries(methods)) {
    const tag = op.tags?.[0] ?? "other";
    if (!groups.has(tag)) groups.set(tag, []);
    const row = {
      method: m.toUpperCase(),
      path: p,
      summary: op.summary,
      params: (op.parameters ?? []).filter((x) => x.in === "query").map((x) => x.name),
    };
    groups.get(tag).push(row);
  }
}
const tagDesc = Object.fromEntries((spec.tags ?? []).map((t) => [t.name, t.description]));
const out = [];
out.push("# 端点索引");
out.push("");
out.push("> 由运行时 `GET /openapi.json` 派生（`bun run scripts/gen-endpoint-index.mjs` 重新生成）。");
out.push("> 语义细节见 [SOP.md](./SOP.md) 与 [DESIGN.md](./DESIGN.md)。");
out.push("");
out.push(`共 ${spec["x-gateway-coverage"].operations} 个操作，${spec["x-gateway-coverage"].tags.length} 个分组。`);
out.push("");
for (const [tag, ops] of groups) {
  out.push(`## ${tag}`);
  out.push("");
  if (tagDesc[tag]) out.push(tagDesc[tag]);
  out.push("");
  out.push("| 方法 | 路径 | 说明 | 查询参数 |");
  out.push("|---|---|---|---|");
  for (const o of ops.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))) {
    out.push(
      `| \`${o.method}\` | \`${o.path}\` | ${o.summary} | ${o.params.length ? o.params.map((p) => `\`${p}\``).join(", ") : "—"} |`,
    );
  }
  out.push("");
}
await Bun.write(path.resolve(import.meta.dir, "..", "..", "docs", "endpoint-index.md"), out.join("\n"));
console.log(`docs/endpoint-index.md 已生成（${spec["x-gateway-coverage"].operations} 个操作）`);
