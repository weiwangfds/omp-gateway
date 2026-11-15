// 串行测试 runner：每个文件独立 bun test 进程，避免并行启动 20+ 网关导致的资源竞争
// （DESIGN §25 收尾：Bun 默认并行跑测试文件，实测偶发子进程启动失败 → ECONNREFUSED）
import { readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const testDir = path.join(root, "test");

const files = [];
for (const f of readdirSync(testDir).sort()) {
  if (f.endsWith(".test.ts")) files.push(path.join("test", f));
}
const unitDir = path.join(testDir, "unit");
try {
  for (const f of readdirSync(unitDir).sort()) {
    if (f.endsWith(".test.ts")) files.push(path.join("test", "unit", f));
  }
} catch {}

let pass = 0;
let fail = 0;
const failed = [];
const started = Date.now();

for (const file of files) {
  const t0 = Date.now();
  const proc = Bun.spawnSync([process.execPath, "test", file, "--max-concurrency", "20"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const out = `${proc.stdout ? new TextDecoder().decode(proc.stdout) : ""}${proc.stderr ? new TextDecoder().decode(proc.stderr) : ""}`;
  const m = out.match(/^\s*(\d+) pass/gm) ?? [];
  const f = out.match(/^\s*(\d+) fail/gm) ?? [];
  const p = m.reduce((a, s) => a + Number(s.replace(/\D/g, "")), 0);
  const fl = f.reduce((a, s) => a + Number(s.replace(/\D/g, "")), 0);
  pass += p;
  fail += fl;
  const ok = proc.exitCode === 0;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `${ok ? "✓" : "✗"} ${file.padEnd(44)} ${String(p).padStart(3)} pass ${String(fl).padStart(2)} fail  ${secs}s`,
  );
  if (!ok) {
    failed.push({ file, out });
    // 打印失败文件的关键错误行（帮助快速定位）
    const errLines = out
      .split("\n")
      .filter((l) => /error:|ECONNREFUSED|EADDRINUSE|\(fail\)/i.test(l))
      .slice(0, 12);
    for (const l of errLines) console.log(`    ${l.slice(0, 200)}`);
  }
}

const totalSecs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n总计：${pass} pass / ${fail} fail（${files.length} 文件，${totalSecs}s）`);
if (failed.length) {
  console.log(`失败文件：${failed.map((x) => x.file).join(", ")}`);
  process.exit(1);
}
