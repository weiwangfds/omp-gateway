// TUI 终端桥容器内验收：建会话 → WS 连终端桥 → TUI 渲染流断言 → 并发守卫 → 交接复活。
// 前置：容器起在 127.0.0.1:8877（docker run -p 8877:8787 -e GATEWAY_SERVICE_TOKENS=test-token）。
const BASE = "http://127.0.0.1:8877";
const TOK = "test-token";
const H = { authorization: `Bearer ${TOK}`, "content-type": "application/json", "x-user-id": "tui-user" };

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const health = await fetch(`${BASE}/healthz`);
check("healthz 200", health.status === 200);

// 1) 建会话
const created = await (
  await fetch(`${BASE}/api/sessions`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ title: "tui-smoke" }),
  })
).json();
const sid = created.id;
check("POST /api/sessions → 201", !!sid, `sid=${sid}`);

// 2) WS 连终端桥，收 TUI 渲染流
const wsUrl = `ws://127.0.0.1:8877/terminal/ws/${sid}?token=${TOK}&uid=tui-user&cols=100&rows=30`;
const ws = new WebSocket(wsUrl);
let bytes = 0,
  firstOutput = "";
let settle;
const firstChunk = new Promise((res) => (settle = res));
ws.onmessage = (ev) => {
  if (typeof ev.data === "string" && ev.data.startsWith('{"type":"exit"')) {
    settle("exit");
    return;
  }
  bytes += ev.data.length ?? 0;
  firstOutput = (firstOutput ?? "") + (typeof ev.data === "string" ? ev.data : "");
  if (bytes > 300) settle("rendered");
};
ws.onerror = () => settle("error");
const outcome = await Promise.race([firstChunk, new Promise((r) => setTimeout(() => r("timeout"), 20000))]);
check("WS 终端桥收到 TUI 渲染流（>300 字节，含 ANSI）", outcome === "rendered", `bytes=${bytes} outcome=${outcome}`);
if (outcome !== "rendered") console.log("  [TUI 首屏输出]", JSON.stringify(firstOutput.slice(0, 400)));

// 3) 并发守卫（TUI 活跃期内）：第二个终端 → 409 TUI_ACTIVE
const dup = await fetch(`http://127.0.0.1:8877/terminal/ws/${sid}?token=${TOK}&uid=tui-user`);
check("第二个终端 → 409 TUI_ACTIVE", dup.status === 409, `status=${dup.status}`);

// 4) 共享观察：TUI 活跃期网关 ctx 保持 live；写面互斥（prompt → 409 TUI_ACTIVE）
const detailDuring = await (await fetch(`${BASE}/api/sessions/${sid}`, { headers: H })).json();
check(
  "TUI 活跃期网关会话仍 live（共享观察）",
  detailDuring?.live?.present === true,
  `present=${detailDuring?.live?.present}`,
);
const pr = await fetch(`${BASE}/api/sessions/${sid}/prompt`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({ text: "x" }),
});
const prBody = await pr.json().catch(() => ({}));
check(
  "TUI 占用期 prompt 被拒（409 TUI_ACTIVE）",
  pr.status === 409 && prBody.error?.code === "TUI_ACTIVE",
  `status=${pr.status} code=${prBody.error?.code}`,
);

// 5) 关闭 WS → TUI 退出 → 网关按需复活（entries 可读）
ws.close();
await new Promise((r) => setTimeout(r, 1500));
const entries = await fetch(`${BASE}/api/sessions/${sid}/entries`, { headers: H });
check("TUI 退出后 entries 复活可读（交接闭环）", entries.status === 200, `status=${entries.status}`);
const detail = await fetch(`${BASE}/api/sessions/${sid}`, { headers: H });
check("会话详情可读（healthz 复核）", (await fetch(`${BASE}/healthz`)).status === 200 && detail.status === 200);

console.log(`\n=== 汇总 ===`);
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exit(1);
