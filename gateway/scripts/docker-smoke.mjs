// 容器内功能验收：健康检查 → 建会话 → 注入 → 文件读写 → openapi → 环境导出 → 导入 → conda/npm/bun
const BASE = "http://127.0.0.1:8877";
const TOK = "test-token";
const H = { authorization: `Bearer ${TOK}`, "content-type": "application/json", "x-user-id": "docker-user" };

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

// 1) 健康检查
const health = await fetch(`${BASE}/healthz`);
check("healthz 200", health.status === 200);
const ready = await (await fetch(`${BASE}/readyz`)).json();
check("readyz ready", ready.ready === true);

// 2) 建会话
const createRes = await fetch(`${BASE}/api/sessions`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({ title: "docker-smoke", contextFiles: [{ path: "AGENTS.md", content: "容器验收会话" }] }),
});
const created = await createRes.json();
check("POST /api/sessions → 201", createRes.status === 201, `sid=${created.id}`);
const sid = created.id;

// 3) 提示词注入（context 模式，不耗模型）
const inject = await fetch(`${BASE}/api/sessions/${sid}/inject`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({ text: "注入上下文", mode: "context" }),
});
check("POST /:sid/inject → 202", inject.status === 202);

// 4) bootstrap 状态聚合
const boot = await (await fetch(`${BASE}/api/sessions/${sid}/bootstrap`, { headers: H })).json();
check("GET /:sid/bootstrap", boot.session?.id === sid && Array.isArray(boot.commands.slashCommands));

// 5) 文件读写（落在挂载卷内）
const put = await fetch(`${BASE}/api/sessions/${sid}/file?path=notes/hello.md`, {
  method: "PUT",
  headers: H,
  body: JSON.stringify({ content: "# hello from container" }),
});
check("PUT /:sid/file → 200", put.status === 200);
const got = await (await fetch(`${BASE}/api/sessions/${sid}/file?path=notes/hello.md`, { headers: H })).json();
check("GET /:sid/file 内容一致", got.content === "# hello from container");

// 6) 快照 + openapi
const snap = await fetch(`${BASE}/api/sessions/${sid}/snapshots`, { method: "POST", headers: H, body: "{}" });
check("POST /:sid/snapshots（零 turn → 409 属预期）", [201, 409].includes(snap.status));
const spec = await (await fetch(`${BASE}/openapi.json`)).json();
const opCount = Object.values(spec.paths).reduce((n, m) => n + Object.keys(m).length, 0);
check("GET /openapi.json", opCount > 150, `${opCount} 个操作`);
check(
  "openapi 每个操作有摘要",
  Object.values(spec.paths).every((m) => Object.values(m).every((op) => op.summary && op.summary.length >= 4)),
);

// 6.5) 管理面新模块路由（KB / Wren）：容器内已挂载、X-Admin-Id 门禁放行
const AH = { ...H, "x-admin-id": "docker-smoke" };
const kbList = await fetch(`${BASE}/admin/kb`, { headers: AH });
const kbBody = await kbList.json().catch(() => null);
check(
  "GET /admin/kb → 200（KB 模块挂载）",
  kbList.status === 200 && Array.isArray(kbBody?.kbs),
  `status=${kbList.status}`,
);
const wrenList = await fetch(`${BASE}/admin/wren/datasources`, { headers: AH });
check("GET /admin/wren/datasources → 200（Wren 模块挂载）", wrenList.status === 200, `status=${wrenList.status}`);
const kbNoAdmin = await fetch(`${BASE}/admin/kb`, { headers: H });
check("GET /admin/kb 无 X-Admin-Id → 403（门禁生效）", kbNoAdmin.status === 403, `status=${kbNoAdmin.status}`);

// 7) 环境导出（bundle 落在挂载卷的 exports 目录）
const exp = await fetch(`${BASE}/internal/maintenance/export`, { method: "POST", headers: H });
const expBody = await exp.json();
check("POST /internal/maintenance/export → 202", exp.status === 202, expBody.bundlePath ?? expBody.error?.message);
check("manifest 计数含 1 会话", expBody.manifest?.counts?.sessions === 1, JSON.stringify(expBody.manifest?.counts));

// 8) 导入（同一实例回灌自己导出的 bundle，验证往返）
const imp = await fetch(`${BASE}/internal/maintenance/import`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({ path: expBody.bundlePath, confirm: "REPLACE" }),
});
const impBody = await imp.json();
check(
  "POST /internal/maintenance/import → 200",
  imp.status === 200,
  impBody.error?.message ?? `backup=${impBody.backupDir}`,
);

// 9) 导入后会话仍可读（相对路径在新 dataRoot 下解析）
const after = await (await fetch(`${BASE}/api/sessions/${sid}`, { headers: H })).json();
check("导入后会话详情可读", after.id === sid);
const afterFile = await (await fetch(`${BASE}/api/sessions/${sid}/file?path=notes/hello.md`, { headers: H })).json();
check("导入后 workspace 文件可读", afterFile.content === "# hello from container");

console.log("\n=== 汇总 ===");
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  for (const f of failed) console.log(`  FAIL ${f.name}`);
  process.exit(1);
}
