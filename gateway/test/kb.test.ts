/**
 * KB 管理面集成测试（DESIGN §38）：spawn 真实网关（独立端口/独立数据根），HTTP 全链路。
 * 用例链：建 KB → zip 上传 → 分组树 → 分组嵌套 → PDF 补传/预览 → 删文档 → 删 KB → 404；
 * 再建一个 KB 验证会话期合成（/api/sessions/:sid/skills 含 kb-*，workspace junction 存在）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";

const PORT = 8813;
const BASE = `http://127.0.0.1:${PORT}`;
const TOK = "kb-it-token";
const H = { authorization: `Bearer ${TOK}`, "content-type": "application/json" };
const ADM = { ...H, "x-admin-id": "admin", "x-user-id": "admin" };
// multipart 用（不得带 content-type——fetch 依 FormData 自动补 boundary）
const ADMF = { authorization: `Bearer ${TOK}`, "x-admin-id": "admin", "x-user-id": "admin" };

const dataRoot = mkdtempSync(path.join(tmpdir(), "omp-gw-kbit-"));
let proc: Bun.Subprocess | null = null;

const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7]);

/** MinerU default 档位 zip（pdf_info 3 页 + images 2 张）。 */
const mkZip = (pages = 3, images = 2) =>
  zipSync({
    "markdown.md": strToU8("# Demo Report\nbody with images/page_1_table_1.jpg\n"),
    "middle_json.json": strToU8(JSON.stringify({ pdf_info: Array.from({ length: pages }, () => ({})) })),
    "structured_content.json": strToU8("{}"),
    ...Object.fromEntries(Array.from({ length: images }, (_, i) => [`images/page_${i + 1}_table_1.jpg`, JPG] as const)),
  });

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // %PDF-1.4

beforeAll(async () => {
  proc = Bun.spawn([process.execPath, "run", "src/index.ts"], {
    cwd: path.resolve(import.meta.dir, ".."),
    env: { ...process.env, GATEWAY_PORT: String(PORT), GATEWAY_DATA_ROOT: dataRoot, GATEWAY_SERVICE_TOKENS: TOK },
    stdout: "pipe",
    stderr: "pipe",
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("gateway did not become healthy in 20s");
}, 30_000);

afterAll(() => {
  if (!proc) return;
  try {
    proc.kill();
  } catch {}
  // Windows 兜底：按树强杀
  try {
    Bun.spawnSync(["taskkill", "/F", "/T", "/PID", String(proc.pid)]);
  } catch {}
});

const upload = async (slug: string, zipName: string, zipBytes: Uint8Array, group?: string) => {
  const fd = new FormData();
  fd.append("zip", new File([zipBytes as BlobPart], zipName, { type: "application/zip" }));
  if (group) fd.append("group", group);
  return fetch(`${BASE}/admin/kb/${slug}/upload`, { method: "POST", headers: ADMF, body: fd });
};

describe("KB 管理面：全链路", () => {
  test("建 KB → 列表 → 非法 slug 400 / 重复建 409", async () => {
    const r = await fetch(`${BASE}/admin/kb`, {
      method: "POST",
      headers: ADM,
      body: JSON.stringify({ slug: "itdemo", title: "IT Demo KB" }),
    });
    expect(r.status).toBe(201);
    const meta = await r.json();
    expect(meta.slug).toBe("itdemo");
    expect(meta.title).toBe("IT Demo KB");
    // skill 骨架在 global/skills/kb-itdemo
    expect(existsSync(path.join(dataRoot, "global", "skills", "kb-itdemo", "SKILL.md"))).toBeTrue();
    const list = await (await fetch(`${BASE}/admin/kb`, { headers: ADM })).json();
    expect(list.kbs).toEqual([
      expect.objectContaining({ slug: "itdemo", skillName: "kb-itdemo", title: "IT Demo KB", docs: 0 }),
    ]);
    expect(
      (await fetch(`${BASE}/admin/kb`, { method: "POST", headers: ADM, body: JSON.stringify({ slug: "Bad!" }) }))
        .status,
    ).toBe(400);
    expect(
      (await fetch(`${BASE}/admin/kb`, { method: "POST", headers: ADM, body: JSON.stringify({ slug: "itdemo" }) }))
        .status,
    ).toBe(409);
  });

  test("upload：zip 透传落 docs/<doc>/，tree 文档卡片；坏包 400、未知 KB 404", async () => {
    const r = await upload("itdemo", "demo-report.zip", mkZip());
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body).toMatchObject({ ok: true, doc: "demo-report", pages: 3, images: 2 });
    // 语料落位：<doc>.md 改名 + images 透传
    const docDir = path.join(dataRoot, "global", "skills", "kb-itdemo", "docs", "demo-report");
    expect(existsSync(path.join(docDir, "demo-report.md"))).toBeTrue();
    expect(existsSync(path.join(docDir, "images", "page_1_table_1.jpg"))).toBeTrue();
    // tree：未分组 → 根部 docs
    const tree = await (await fetch(`${BASE}/admin/kb/itdemo/tree`, { headers: ADM })).json();
    expect(tree.slug).toBe("itdemo");
    expect(tree.groups).toEqual([]);
    expect(tree.docs[0]).toMatchObject({ name: "demo-report", groupPath: null, pages: 3, images: 2, hasPdf: false });
    // 坏魔数 → 400 INVALID_ZIP
    const bad = new FormData();
    bad.append("zip", new File([new Uint8Array([0x00, 0x01, 0x02, 0x03])], "x.zip"));
    expect((await fetch(`${BASE}/admin/kb/itdemo/upload`, { method: "POST", headers: ADMF, body: bad })).status).toBe(
      400,
    );
    // 未知 KB → 404
    expect((await upload("ghost", "x.zip", mkZip())).status).toBe(404);
  });

  test("分组上传 → tree 嵌套（A/B 物化路径）", async () => {
    expect((await upload("itdemo", "demo-report.zip", mkZip(3, 2), "A")).status).toBe(201);
    expect((await upload("itdemo", "second-doc.zip", mkZip(5, 1), "A/B")).status).toBe(201);
    const tree = await (await fetch(`${BASE}/admin/kb/itdemo/tree`, { headers: ADM })).json();
    expect(tree.docs).toEqual([]); // 都已归组
    const [a] = tree.groups;
    expect(a.path).toBe("A");
    expect(a.docs.map((d: any) => d.name)).toEqual(["demo-report"]);
    expect(a.children[0].path).toBe("A/B");
    expect(a.children[0].docs[0]).toMatchObject({ name: "second-doc", groupPath: "A/B", pages: 5 });
  });

  test("PDF 补传 → 预览原文件（application/pdf）→ 卡片 hasPdf", async () => {
    const fd = new FormData();
    fd.append("doc", "demo-report");
    fd.append("pdf", new File([PDF as BlobPart], "demo-report.pdf", { type: "application/pdf" }));
    const r = await fetch(`${BASE}/admin/kb/itdemo/pdf`, { method: "POST", headers: ADMF, body: fd });
    expect(r.status).toBe(201);
    // 坏魔数 → 400；未入库文档 → 404
    const bad = new FormData();
    bad.append("doc", "demo-report");
    bad.append("pdf", new File([new Uint8Array([0x12, 0x34])], "x.pdf"));
    expect((await fetch(`${BASE}/admin/kb/itdemo/pdf`, { method: "POST", headers: ADMF, body: bad })).status).toBe(400);
    const miss = new FormData();
    miss.append("doc", "ghost");
    miss.append("pdf", new File([PDF as BlobPart], "g.pdf"));
    expect((await fetch(`${BASE}/admin/kb/itdemo/pdf`, { method: "POST", headers: ADMF, body: miss })).status).toBe(
      404,
    );
    // 预览：字节一致
    const got = await fetch(`${BASE}/admin/kb/itdemo/pdf/demo-report`, { headers: ADM });
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toContain("application/pdf");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(PDF);
    const tree = await (await fetch(`${BASE}/admin/kb/itdemo/tree`, { headers: ADM })).json();
    expect(tree.groups[0].docs[0].hasPdf).toBeTrue();
    expect((await fetch(`${BASE}/admin/kb/itdemo/pdf/ghost`, { headers: ADM })).status).toBe(404);
  });

  test("删文档 → 删 KB → 404", async () => {
    expect((await fetch(`${BASE}/admin/kb/itdemo/doc/demo-report`, { method: "DELETE", headers: ADM })).status).toBe(
      200,
    );
    expect(existsSync(path.join(dataRoot, "global", "skills", "kb-itdemo", "docs", "demo-report"))).toBeFalse();
    const tree = await (await fetch(`${BASE}/admin/kb/itdemo/tree`, { headers: ADM })).json();
    expect(tree.groups[0].docs).toEqual([]); // demo-report 已删；second-doc 挂在 A/B 子组
    expect(tree.groups[0].children[0].docs.map((d: any) => d.name)).toEqual(["second-doc"]);
    expect((await fetch(`${BASE}/admin/kb/itdemo/doc/demo-report`, { method: "DELETE", headers: ADM })).status).toBe(
      404,
    );
    expect((await fetch(`${BASE}/admin/kb/itdemo`, { method: "DELETE", headers: ADM })).status).toBe(200);
    expect(existsSync(path.join(dataRoot, "global", "skills", "kb-itdemo"))).toBeFalse();
    expect(existsSync(path.join(dataRoot, "global", "kb", "itdemo.db"))).toBeFalse();
    expect((await fetch(`${BASE}/admin/kb/itdemo/tree`, { headers: ADM })).status).toBe(404);
    expect((await fetch(`${BASE}/admin/kb/itdemo`, { method: "DELETE", headers: ADM })).status).toBe(404);
  });
});

describe("KB 会话期合成：junction + skills 注入", () => {
  const UID = "kbuser";
  let sid = "";

  test("建 KB 上传文档 → 建会话 → skills 含 kb-*，workspace junction 存在", async () => {
    expect(
      (
        await fetch(`${BASE}/admin/kb`, {
          method: "POST",
          headers: ADM,
          body: JSON.stringify({ slug: "scompose", title: "Session KB" }),
        })
      ).status,
    ).toBe(201);
    expect((await upload("scompose", "corpus-one.zip", mkZip(2, 1))).status).toBe(201);

    const created = await (
      await fetch(`${BASE}/api/sessions`, { method: "POST", headers: { ...H, "x-user-id": UID }, body: "{}" })
    ).json();
    sid = created.id as string;
    expect(typeof sid).toBe("string");
    expect(sid).toBeTruthy();
    if (!sid) return;

    // 会话可见 skills（options.skills 注入，global/skills/kb-* 经 loadSkillsFromDir）
    const skills = await (
      await fetch(`${BASE}/api/sessions/${sid}/skills`, { headers: { ...H, "x-user-id": UID } })
    ).json();
    const names = (skills.skills ?? []).map((s: any) => s.name);
    expect(names).toContain("kb-scompose");

    // workspace junction：<dataRoot>/users/<uid>/workspaces/<sid>/.omp/skills/kb-scompose
    const link = path.join(dataRoot, "users", UID, "workspaces", sid, ".omp", "skills", "kb-scompose");
    let st: ReturnType<typeof lstatSync> | null = null;
    try {
      st = lstatSync(link);
    } catch {
      st = null;
    }
    if (!st) {
      throw new Error(
        `kb junction missing at ${link} (fs.cp/平台 junction 失败? workspace dir: ${path.dirname(path.dirname(link))})`,
      );
    }
    expect(st.isSymbolicLink()).toBeTrue();
    // 语料经 junction 可达（junction 解引用 → 真目录内容）
    expect(existsSync(path.join(link, "docs", "corpus-one", "corpus-one.md"))).toBeTrue();
    // manifest 记账
    const manifest = JSON.parse(
      readFileSync(path.join(dataRoot, "users", UID, "workspaces", sid, ".omp", "skills", ".kb-composed.json"), "utf8"),
    );
    expect(manifest.managedBy).toBe("omp-gateway");
    expect(manifest.names).toContain("kb-scompose");
  }, 120_000);
});
