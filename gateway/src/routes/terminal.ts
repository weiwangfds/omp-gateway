/**
 * TUI 终端桥（DESIGN §41.9）：浏览器 xterm.js ⇄ WebSocket ⇄ PTY ⇄ omp 交互式 TUI。
 *
 * 用途：内网部署在前端直接打开 omp 原生 TUI 做交互测试（真实 pi-tui，非模拟界面）。
 *
 * 会话占用模型（关键正确性约束）：TUI 进程以 --session <ompSessionId> 恢复同一份
 * JSONL 并写入新条目——网关侧 SessionManager 必须先让位，否则双写。握手顺序：
 *   1. streaming 中 → 409 拒绝（无法交接）
 *   2. live ctx 存在 → disposeSession（网关让位；TUI 退出后按文件自然复活）
 *   3. 标记 tui-registry → getOrRevive 在 TUI 存活期拒绝复活（409 TUI_ACTIVE）
 *   4. spawn PTY → WS 双向桥接 → 退出时清理标记
 *
 * 鉴权：挂在根应用（不经 /api 的 authMiddleware——浏览器 WS 无法带 header）。
 * header 优先（BFF 代理场景），?token= / ?uid= 回落（浏览器直连），同一套恒时校验。
 *
 * 消息协议：客户端→网关：binary 帧=原始键入；text 帧=JSON 控制帧
 *   {"type":"input","data":..} / {"type":"resize","cols":..,"rows":..}。
 * 网关→客户端：PTY 输出原样转发；退出时 {"type":"exit","code":..}。
 */
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { PtySession } from "@oh-my-pi/pi-natives";
import * as fs from "node:fs/promises";
import { statSync } from "node:fs";
import path from "node:path";
import { USER_ID_RE, tokenAccepted } from "../middleware/auth.ts";
import { registry } from "../core/session-registry.ts";
import { disposeSession } from "../core/session-factory.ts";
import { isTuiActive, markTuiActive, markTuiClosed } from "../core/tui-registry.ts";
import { userSessionsDir, userAgentDir, userWorkspace, fromStorePath } from "../core/paths.ts";
import { ownedSession } from "./session/shared.ts";

const LOG = "[gateway:tui]";

/** omp CLI 入口（与网关同 node_modules，版本天然一致）。 */
const cliPath = path.join(import.meta.dir, "../../node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js");

/** 纯函数（单测面）：TUI 进程的 spawn 参数与环境。 */
export function buildTuiSpawn(opts: { ompSessionId: string; userId: string; sid: string }): {
  application: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
} {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.LANG = env.LANG || "C.UTF-8";
  env.PI_CODING_AGENT_DIR = userAgentDir(opts.userId); // CLI 读此 env 定位用户 models.yml/凭据
  return {
    application: process.execPath,
    args: [
      cliPath,
      "--session-dir",
      userSessionsDir(opts.userId),
      "--session",
      opts.ompSessionId, // omp 会话 id（文件名 *_<id>.jsonl，resolveResumeTarget 可解析）
    ],
    cwd: userWorkspace(opts.userId, opts.sid),
    env,
  };
}

/**
 * 空会话物化：omp 的 JSONL 在首条消息落盘时才创建（SessionManager.create 是内存态），
 * 而 omp CLI --session 按 glob 找不到文件会直接退出。TUI 打开空会话前，网关按 SDK
 * createEmptySessionFile 的形状（缺 title 行，open 兼容，DESIGN §25 导入语义）写最小
 * header，让 CLI 能恢复这个"还没有内容"的会话。
 */
async function materializeEmptySessionHeader(file: string, ompSessionId: string, workspaceDir: string): Promise<void> {
  const { CURRENT_SESSION_VERSION } = await import("@oh-my-pi/pi-coding-agent");
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: ompSessionId,
    timestamp: new Date().toISOString(),
    cwd: workspaceDir,
  };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(header)}\n`, "utf8");
  console.log(`${LOG} materialized empty session header: ${file}`);
}

/** 从 JSONL 头部解析 omp 会话 id（会话未被网关持有、无 ompSessionId 内存值时用）。 */
export async function ompSessionIdFromJsonl(file: string): Promise<string | null> {
  try {
    const handle = await fs.open(file, "r");
    try {
      const head = await handle.read({ buffer: Buffer.alloc(4096), position: 0, length: 4096 });
      for (const line of head.buffer.toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line) as { id?: string };
          if (typeof obj.id === "string" && obj.id) return obj.id; // header/session 记录携带 omp 会话 id
        } catch {}
      }
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
  return null;
}

/** 活跃 TUI 终端（并发守卫）：存 WS 句柄用于僵尸探活——frp 链路半开时 close 帧丢失，
 * 占用标记不会自动清除，新连接 guard 需能识别并清掉死连接。 */
const activeTerminals = new Map<string, { pty: PtySession; ws: { send: (d: string) => void } }>();

/** 探活：向占用的 WS 发空帧（无害）；socket 已死会 throw → 僵尸占用。 */
function tuiAttachmentAlive(sid: string): boolean {
  const held = activeTerminals.get(sid);
  if (!held) return false;
  try {
    held.ws.send("");
    return true;
  } catch {
    activeTerminals.delete(sid);
    markTuiClosed(sid);
    console.log(`${LOG} stale TUI attachment cleared sid=${sid}（对端已死，占用自愈）`);
    return false;
  }
}
/** JSONL tail 轮询器（会话 → 定时器）：TUI 活跃期把新条目镜像成 tui.entry 事件。 */
const tailTimers = new Map<string, ReturnType<typeof setInterval>>();

/**
 * tail 共享会话文件（DESIGN §41.9 共享观察）：500ms 轮询 stat.size，读增量按行解析，
 * 每个完整 entry publish 成 tui.entry 事件（进 SSE 实时流 + 回放缓冲）。半行留在缓冲。
 * ctx 为 null（网关重启后 TUI 不可能存活）时只 tail 不 publish，防御性跳过。
 */
function startTuiTail(
  sid: string,
  ctx: { publish: (p: { type: "tui.entry"; entry: unknown }) => void } | null,
  file: string,
): void {
  stopTuiTail(sid);
  let offset = 0;
  let carry = "";
  let busy = false; // tail 轮询防重入：async 回调在 await 间隙可与下一轮重叠
  try {
    offset = statSync(file).size; // attach 时的文件尾 = TUI 增量起点
  } catch {}
  const timer = setInterval(() => {
    void (async () => {
      if (busy) return; // 上一轮读盘未完：跳过本轮，防两轮从同一 offset 重读重复 publish
      busy = true;
      try {
        const st = await fs.stat(file);
        if (st.size <= offset) return; // 无增量（truncate 视为无操作，TUI 不截断）
        const handle = await fs.open(file, "r");
        try {
          const buf = Buffer.alloc(st.size - offset);
          await handle.read(buf, 0, buf.length, offset);
          offset = st.size;
          const text = carry + buf.toString("utf8");
          const lines = text.split("\n");
          carry = lines.pop() ?? ""; // 末行可能不完整
          if (!ctx) return;
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const entry = JSON.parse(line);
              ctx.publish({ type: "tui.entry", entry });
            } catch {}
          }
        } finally {
          await handle.close();
        }
      } catch {
        // 文件消失（TUI 侧重命名等）：停止本轮，下轮再探
      } finally {
        busy = false;
      }
    })();
  }, 500);
  timer.unref?.();
  tailTimers.set(sid, timer);
}

function stopTuiTail(sid: string): void {
  const t = tailTimers.get(sid);
  if (t) {
    clearInterval(t);
    tailTimers.delete(sid);
  }
}

/** HTML 属性转义：sid 来自 URL query 并内插进 value="..."，必须防属性注入（反射型 XSS）。 */
function escapeHtmlAttr(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
  );
}

function pageHtml(sid: string): string {
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>omp TUI</title>
<link rel="stylesheet" href="/terminal/assets/xterm.css">
<style>
 body{margin:0;background:#141417;color:#ddd;font:13px/1.4 system-ui}
 #bar{display:flex;gap:8px;padding:8px;align-items:center;background:#1d1d22}
 #bar input{background:#26262c;color:#ddd;border:1px solid #3a3a42;border-radius:4px;padding:4px 8px}
 #bar button{background:#3b5bdb;color:#fff;border:0;border-radius:4px;padding:5px 14px;cursor:pointer}
 #st{margin-left:auto;color:#888}
 #term{padding:6px}
</style></head><body>
<div id="bar">
  <input id="sid" placeholder="session-id" value="${escapeHtmlAttr(sid)}" size="36">
  <input id="uid" placeholder="X-User-Id" size="12">
  <input id="tok" placeholder="service-token" type="password" size="18">
  <button id="btn">连接 TUI</button>
  <span id="st">未连接</span>
</div>
<div id="term"></div>
<script src="/terminal/assets/xterm.js"></script>
<script src="/terminal/assets/fit.js"></script>
<script>
const $ = id => document.getElementById(id);
const st = t => $("st").textContent = t;
// URL query 预填（?sid=&uid=&token=&auto=1）：分享链接打开即填好，auto=1 直接连接
const q = new URLSearchParams(location.search);
for (const [k, id] of [["sid","sid"],["uid","uid"],["token","tok"]]) {
  const v = q.get(k); if (v) $(id).value = v;
}
if (q.get("auto") === "1") setTimeout(connect, 300);
let ws, term, fit;
function connect(){
  const sid = $("sid").value.trim(), uid = $("uid").value.trim(), tok = $("tok").value.trim();
  if(!sid || !uid || !tok){ st("请填 sid / uid / token"); return; }
  $("btn").textContent = "断开";
  term = new Terminal({ fontFamily: "Consolas, monospace", fontSize: 14, cursorBlink: true, theme:{background:"#141417"} });
  fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($("term")); fit.fit();
  st("连接中…");
  const cols = Math.max(20, Math.min(term.cols, 240)), rows = Math.max(8, Math.min(term.rows, 60));
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(\`\${proto}://\${location.host}/terminal/ws/\${sid}?token=\${encodeURIComponent(tok)}&uid=\${encodeURIComponent(uid)}&cols=\${cols}&rows=\${rows}\`);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => st("已连接（TUI 运行中）");
  ws.onmessage = ev => {
    if (typeof ev.data === "string" && ev.data.startsWith('{"type":"exit"')) {
      st("TUI 已退出：" + ev.data); $("btn").textContent = "连接 TUI"; return;
    }
    term.write(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data));
  };
  ws.onclose = () => { st("连接关闭"); $("btn").textContent = "连接 TUI"; };
  ws.onerror = () => st("连接错误");
  term.onData(d => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({type:"input", data:d})); });
  window.addEventListener("resize", () => { fit.fit(); if (ws && ws.readyState === 1)
    ws.send(JSON.stringify({type:"resize", cols:term.cols, rows:term.rows})); });
}
$("btn").onclick = () => (ws && ws.readyState === 1) ? ws.close() : connect();
</script></body></html>`;
}

/** TUI 终端桥：测试页 / 资产 / WS 升级。挂根应用（不经 /api authMiddleware）。 */
export const terminalApp = new Hono();

terminalApp.get("/", (c) =>
  c.html(pageHtml(c.req.query("sid") ?? ""), 200, {
    // 页面随镜像更新（预填/自动连接等），禁缓存——旧页面缓存会让新功能"不生效"
    "cache-control": "no-store",
  }),
);

// xterm 静态资产：固定路径直读 node_modules（无 glob，无路径穿越面）
terminalApp.get("/assets/:file", async (c) => {
  const allowed: Record<string, { path: string; type: string }> = {
    "xterm.js": { path: "@xterm/xterm/lib/xterm.js", type: "text/javascript" },
    "xterm.css": { path: "@xterm/xterm/css/xterm.css", type: "text/css" },
    "fit.js": { path: "@xterm/addon-fit/lib/addon-fit.js", type: "text/javascript" },
  };
  const hit = allowed[c.req.param("file")];
  if (!hit) return c.json({ error: { code: "NOT_FOUND", message: "asset not found" } }, 404);
  try {
    const body = await fs.readFile(path.join(import.meta.dir, "../../node_modules", hit.path));
    return c.body(body, 200, { "content-type": hit.type });
  } catch {
    return c.json({ error: { code: "NOT_FOUND", message: "asset missing" } }, 404);
  }
});

// WS 升级必须走 hono 中间件链：upgradeWebSocket 返回 MiddlewareHandler，只能作为路由
// 处理链的一环（不能从普通 handler 里 return——Bun fetch 拿到函数而非 Response，
// 升级静默失败：error: Expected a Response object…——实测踩到）。鉴权做成前置 guard。
terminalApp.get(
  "/ws/:sid",
  // ---- guard：鉴权 + 归属 + 状态 + 占用标记（全部通过才放行升级）----
  async (c, next) => {
    console.log(`${LOG} upgrade request: ${c.req.path} query-token=${c.req.query("token") ? "present" : "absent"}`);
    // 鉴权：header 优先（BFF 代理），query 回落（浏览器直连）——同一套恒时校验
    const headerToken = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    const token = headerToken || c.req.query("token") || "";
    const uid = c.req.header("x-user-id") ?? c.req.query("uid") ?? "";
    if (!tokenAccepted(token)) {
      console.log(`${LOG} guard reject: UNAUTHORIZED`);
      return c.json({ error: { code: "UNAUTHORIZED", message: "invalid token" } }, 401);
    }
    if (!USER_ID_RE.test(uid)) return c.json({ error: { code: "INVALID_USER_ID", message: "bad uid" } }, 401);

    const sid = c.req.param("sid");
    const row = ownedSession(sid, uid);
    if (!row) {
      console.log(`${LOG} guard reject: NOT_FOUND (sid=${sid} uid=${uid}——uid 必须是会话属主)`);
      return c.json({ error: { code: "NOT_FOUND", message: "session not found" } }, 404);
    }
    if (row.status !== "active") {
      console.log(`${LOG} guard reject: SESSION_ARCHIVED sid=${sid}`);
      return c.json({ error: { code: "SESSION_ARCHIVED", message: row.status } }, 409);
    }
    // 占用互斥（带僵尸自愈）：探活失败（frp 链路半开导致 close 帧丢失）→ 清理放行
    if (isTuiActive(sid) && tuiAttachmentAlive(sid)) {
      console.log(`${LOG} guard reject: TUI_ACTIVE sid=${sid}`);
      return c.json({ error: { code: "TUI_ACTIVE", message: "terminal already attached" } }, 409);
    }
    // 空会话可开（onOpen 会物化 header）；仅当「既无 live ctx（无从得知 omp id）又无文件」
    // 时才不可恢复——网关重启后新建未发消息即被回收的会话就是这种
    const liveCtx = registry.get(sid);
    const fileStat = row.session_file ? await fs.stat(fromStorePath(row.session_file)).catch(() => null) : null;
    if (!liveCtx?.ompSessionId && !fileStat) {
      return c.json(
        { error: { code: "SESSION_EMPTY", message: "session has no content and no live context to materialize from" } },
        409,
      );
    }
    // 交接前置检查：streaming 中无法让位
    if (registry.get(sid)?.streaming)
      return c.json({ error: { code: "SESSION_STREAMING", message: "turn in progress" } }, 409);

    // 占用标记在 guard 期落位：并发第二条连接确定性地 409（不等 onOpen 异步链）
    markTuiActive(sid);
    console.log(`${LOG} guard pass sid=${sid}`);
    await next();
  },
  // ---- upgrade：onOpen 里完成网关让位 + PTY spawn；onClose 清理并解除占用 ----
  upgradeWebSocket((c) => {
    // guard 已校验过归属与格式；这里重新推导只是为闭包取值（类型上 param 可为 undefined）
    const sid = c.req.param("sid") ?? "";
    const uid = c.req.header("x-user-id") ?? c.req.query("uid") ?? "";
    return {
      onOpen(_event, ws) {
        void (async () => {
          try {
            const ctx = registry.get(sid);
            const row = ownedSession(sid, uid);
            const ompSessionId =
              ctx?.ompSessionId ??
              (row?.session_file ? await ompSessionIdFromJsonl(fromStorePath(row.session_file)) : null);
            if (!ompSessionId || !row?.session_file) {
              markTuiClosed(sid);
              ws.send(JSON.stringify({ type: "exit", code: -1, message: "no omp session id" }));
              ws.close(1011, "no omp session id");
              return;
            }
            const sessionFile = fromStorePath(row.session_file);
            // 空会话（JSONL 未落盘）：物化最小 header，omp CLI 才能按 id 恢复
            if (!(await fs.stat(sessionFile).catch(() => null))) {
              await materializeEmptySessionHeader(sessionFile, ompSessionId, userWorkspace(uid, sid));
            }
            // 共享观察模型（DESIGN §41.9）：网关 ctx 保持 live（不 dispose）——写面经
            // withTurnSlot 的 TUI_ACTIVE 守卫互斥，读面/SSE 照常；tail 把 TUI 写入的
            // 新条目实时镜像成 tui.entry 事件给前端。
            startTuiTail(sid, ctx ?? null, sessionFile);
            const cols = Number(c.req.query("cols")) || 120;
            const rows = Number(c.req.query("rows")) || 32;
            const spawn = buildTuiSpawn({ ompSessionId, userId: uid, sid });
            const pty = new PtySession();
            activeTerminals.set(sid, { pty, ws });
            console.log(`${LOG} TUI attached sid=${sid} user=${uid} omp=${ompSessionId}`);
            const done = pty.startArgv(
              {
                application: spawn.application,
                args: spawn.args,
                cwd: spawn.cwd,
                env: spawn.env,
                cols,
                rows,
              },
              (err, chunk) => {
                if (err || !chunk) return;
                try {
                  ws.send(chunk);
                } catch {}
              },
              (err) => {
                if (err) console.error(`${LOG} PTY start failed sid=${sid}:`, err);
              },
            );
            void done
              .then((result) => {
                try {
                  ws.send(JSON.stringify({ type: "exit", code: result.exitCode ?? 0 }));
                  ws.close(1000, "tui exited");
                } catch {}
              })
              .catch((err) => {
                console.error(`${LOG} PTY crashed sid=${sid}:`, err);
                try {
                  ws.send(JSON.stringify({ type: "exit", code: -1, message: String(err) }));
                  ws.close(1011, "pty crashed");
                } catch {}
              })
              .finally(() => {
                activeTerminals.delete(sid);
                stopTuiTail(sid);
                markTuiClosed(sid);
                if (ctx) void disposeSession(ctx).catch(() => {}); // TUI 关闭 → 复活吸收 TUI 写入的条目
              });
          } catch (err) {
            console.error(`${LOG} open failed sid=${sid}:`, err);
            markTuiClosed(sid);
            try {
              ws.close(1011, "open failed");
            } catch {}
          }
        })();
      },
      onMessage(event, _ws) {
        const data = event.data;
        const pty = activeTerminals.get(sid)?.pty;
        if (!pty) return;
        try {
          if (typeof data === "string") {
            if (data.startsWith("{")) {
              const ctl = JSON.parse(data) as { type?: string; data?: string; cols?: number; rows?: number };
              if (ctl.type === "resize" && ctl.cols && ctl.rows) pty.resize(ctl.cols, ctl.rows);
              else if (ctl.type === "input" && typeof ctl.data === "string") pty.write(ctl.data);
              return;
            }
            pty.write(data); // 非 JSON 文本：按原始键入处理
          } else {
            pty.write(new TextDecoder().decode(data as ArrayBuffer));
          }
        } catch {
          // 进程已退出：写失败静默（退出帧随后到达）
        }
      },
      onClose() {
        const held = activeTerminals.get(sid);
        if (held) {
          try {
            held.pty.kill(); // 页面关闭 = 结束 TUI 测试（会话内容已在 JSONL，网关按需复活）
          } catch {
            // 进程已自行退出（kill 竞态）：静默——未捕获会把整个网关进程搞崩（实测踩到）
          }
          activeTerminals.delete(sid);
        }
        stopTuiTail(sid);
        markTuiClosed(sid);
        // TUI 关闭 → 释放网关侧 ctx：TUI 期间写入的条目只在该文件里，下次访问
        // getOrRevive 从文件重建（含 TUI 内容）。ctx 可能已被 done.finally 释放，幂等。
        const liveCtx = registry.get(sid);
        if (liveCtx) void disposeSession(liveCtx).catch(() => {});
        console.log(`${LOG} TUI detached sid=${sid}`);
      },
    };
  }),
);
