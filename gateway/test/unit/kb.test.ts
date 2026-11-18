/**
 * KB 模块单测（DESIGN §38）：命名净化 / kb.db store / skill 骨架 / zip 透传入库 / junction 合成。
 * config 是加载期单例——先设 GATEWAY_DATA_ROOT 再动态 import（范式同 agent-compose.test.ts）。
 */
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";

const dataRoot = mkdtempSync(path.join(tmpdir(), "omp-gw-kb-"));
process.env.GATEWAY_DATA_ROOT = dataRoot;

const { KB_DOC_NAME_RE, KbNameError, assertSafeZipEntry, sanitizeDocName } = await import("../../src/core/kb/names.ts");
const store = await import("../../src/core/kb/store.ts");
const skill = await import("../../src/core/kb/skill.ts");
const ingest = await import("../../src/core/kb/ingest.ts");
const { composeKbForWorkspace } = await import("../../src/core/kb/compose.ts");
const { ManagementError, deleteSkill, writeSkill } = await import("../../src/core/registry-management.ts");
const { globalKbDir, globalSkillsDir } = await import("../../src/core/paths.ts");

const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

/** 合成 MinerU default 档位 zip（可选顶层前缀目录）。 */
const mkZip = (opts?: { prefix?: string; pages?: number; images?: number; md?: string }) => {
  const pages = opts?.pages ?? 3;
  const images = opts?.images ?? 2;
  const inner: Record<string, Uint8Array> = {
    "markdown.md": strToU8(opts?.md ?? "# Report\nbody text\n"),
    "middle_json.json": strToU8(JSON.stringify({ pdf_info: Array.from({ length: pages }, () => ({})) })),
    "structured_content.json": strToU8("{}"),
  };
  for (let i = 1; i <= images; i++) inner[`images/page_${i}_table_1.jpg`] = JPG;
  if (opts?.prefix) return zipSync({ [opts.prefix]: inner } as never);
  return zipSync(inner);
};

const kbSkillPath = (slug: string) => path.join(globalSkillsDir(), `kb-${slug}`);

describe("kb names：命名规约", () => {
  test("sanitizeDocName：空白/越界字符清洗、截断、拒绝空结果", () => {
    expect(sanitizeDocName("Q3 财报 v2")).toBe("Q3-v2");
    expect(sanitizeDocName("My Report (2024) Final!!")).toMatch(/^My-Report-2024-Final/);
    expect(sanitizeDocName("  ok_name-1.2  ")).toBe("ok_name-1.2");
    expect(sanitizeDocName("---bad")).toBe("bad");
    expect(() => sanitizeDocName("%%%")).toThrow(KbNameError);
    expect(() => sanitizeDocName("")).toThrow(KbNameError);
    expect(sanitizeDocName("x".repeat(300)).length).toBeLessThanOrEqual(128);
  });

  test("assertSafeZipEntry：拒绝 ../、绝对路径、盘符、反斜杠；目录条目放行", () => {
    expect(() => assertSafeZipEntry("a/b/file.md")).not.toThrow();
    expect(() => assertSafeZipEntry("images/")).not.toThrow();
    expect(() => assertSafeZipEntry("../evil.md")).toThrow(KbNameError);
    expect(() => assertSafeZipEntry("a/../../evil.md")).toThrow(KbNameError);
    expect(() => assertSafeZipEntry("/abs/path.md")).toThrow(KbNameError);
    expect(() => assertSafeZipEntry("C:\\x\\y.md")).toThrow(KbNameError);
    expect(() => assertSafeZipEntry("a\\b.md")).toThrow(KbNameError);
    expect(KB_DOC_NAME_RE.test("report-2024.pdf")).toBeTrue();
    expect(KB_DOC_NAME_RE.test("../evil")).toBeFalse();
  });

  test("normalizeGroupPath：物化路径清洗；允许中文段；拒绝空段穿越", () => {
    expect(ingest.normalizeGroupPath(null)).toBeNull();
    expect(ingest.normalizeGroupPath("")).toBeNull();
    expect(ingest.normalizeGroupPath("存储标准/LPDDR6")).toBe("存储标准/LPDDR6");
    expect(ingest.normalizeGroupPath("/A/B/")).toBe("A/B");
    expect(ingest.normalizeGroupPath("半导体 // 内存")).toBe("半导体/内存");
    expect(() => ingest.normalizeGroupPath("../evil")).toThrow();
    expect(() => ingest.normalizeGroupPath("a\\b")).toThrow();
  });
});

describe("kb store：kb.db 元数据", () => {
  test("ensureGroup：物化路径逐级建组，返回最深 id；重复调用收敛", () => {
    const d = store.openKbDb("st1");
    const idC = store.ensureGroup(d, "A/B/C");
    expect(idC).not.toBeNull();
    const groups = store.listGroups(d);
    expect(groups.map((g) => g.path)).toEqual(["A", "A/B", "A/B/C"]);
    const idB = store.ensureGroup(d, "A/B");
    expect(idB).toBe(groups[1].id);
    expect(store.ensureGroup(d, "A/B/C")).toBe(idC);
    expect(store.ensureGroup(d, "")).toBeNull();
    expect(store.ensureGroup(d, null)).toBeNull();
    expect(store.listGroups(d).length).toBe(3);
  });

  test("upsertDoc/getDoc：登记与同名覆盖更新", () => {
    const d = store.openKbDb("st1");
    store.upsertDoc(d, { name: "doc-a", groupId: null, mdSha256: "aa", pages: 1, images: 2 });
    const row = store.getDoc(d, "doc-a")!;
    expect(row.name).toBe("doc-a");
    expect(row.pages).toBe(1);
    expect(row.hasPdf).toBe(0);
    expect(row.createdAt).toBeTruthy();
    store.upsertDoc(d, { name: "doc-a", groupId: null, mdSha256: "bb", pages: 5, images: 7 });
    const row2 = store.getDoc(d, "doc-a")!;
    expect(row2.pages).toBe(5);
    expect(row2.mdSha256).toBe("bb");
    expect(row2.createdAt).toBe(row.createdAt); // created_at 保留
    expect(store.countDocs(d)).toBe(1);
    store.setDocHasPdf(d, "doc-a", 1);
    expect(store.getDoc(d, "doc-a")!.hasPdf).toBe(1);
  });

  test("buildTree：分组嵌套 + 未分组文档挂根部", () => {
    const d = store.openKbDb("st2");
    const idB = store.ensureGroup(d, "A/B");
    store.upsertDoc(d, { name: "root-doc", groupId: null, mdSha256: "r", pages: 1, images: 0 });
    store.upsertDoc(d, { name: "deep-doc", groupId: idB, mdSha256: "d", pages: 9, images: 3 });
    const tree = store.buildTree(d);
    expect(tree.docs.map((x) => x.name)).toEqual(["root-doc"]);
    expect(tree.groups.length).toBe(1);
    const a = tree.groups[0];
    expect(a.path).toBe("A");
    expect(a.children.length).toBe(1);
    expect(a.children[0].path).toBe("A/B");
    expect(a.children[0].docs[0]).toMatchObject({ name: "deep-doc", groupPath: "A/B", pages: 9, hasPdf: false });
  });
});

describe("kb skill：目录骨架与管理", () => {
  test("createKb：SKILL.md/kb.json/docs/scripts/assets 齐备；重复建 → ALREADY_EXISTS", async () => {
    const meta = await skill.createKb("sk1", "财报知识库");
    expect(meta.title).toBe("财报知识库");
    expect(existsSync(path.join(kbSkillPath("sk1"), "SKILL.md"))).toBeTrue();
    expect(existsSync(path.join(kbSkillPath("sk1"), "docs"))).toBeTrue();
    expect(existsSync(path.join(kbSkillPath("sk1"), "scripts"))).toBeTrue();
    expect(existsSync(path.join(kbSkillPath("sk1"), "assets"))).toBeTrue();
    const kbJson = JSON.parse(readFileSync(path.join(kbSkillPath("sk1"), "kb.json"), "utf8"));
    expect(kbJson).toMatchObject({ _managedBy: "omp-gateway", type: "kb", slug: "sk1" });
    // 标准 skill 结构（skill-creator 规范）：frontmatter 触发语 + 精简 body + references/ 渐进披露
    expect(existsSync(path.join(kbSkillPath("sk1"), "references"))).toBeTrue();
    for (const f of ["retrieval.md", "pagination.md", "imaging.md"]) {
      expect(existsSync(path.join(kbSkillPath("sk1"), "references", f))).toBeTrue();
    }
    const md = readFileSync(path.join(kbSkillPath("sk1"), "SKILL.md"), "utf8");
    expect(md.startsWith("---\nname: kb-sk1\n")).toBeTrue();
    expect(md).toContain("description:");
    expect(md).toContain("何时使用");
    expect(md).toContain("references/");
    expect(md).toContain("p.68"); // 引用格式字面示例
    expect(md).not.toContain("python3"); // 标准写法是 python
    // M35：grep × qmd 双路组合，路由判断权在 omp（agent）
    expect(md).toContain("路由 + 定位");
    expect(md).toContain("按问题形态判断选路");
    const retrieval = readFileSync(path.join(kbSkillPath("sk1"), "references", "retrieval.md"), "utf8");
    expect(retrieval).toContain("路由判断");
    expect(retrieval).toContain("套路 A"); // qmd 定域 → grep 定行
    expect(retrieval).toContain("原生 ripgrep"); // omp grep 工具 = pi-natives 原生引擎
    expect(retrieval).not.toContain("兜底：grep"); // M29 的"grep 仅兜底"表述退役
    await expect(skill.createKb("sk1")).rejects.toThrow(ingest.KbError);
  });

  test("listKbs：kb.json 标记目录入列，docs 计数来自 kb.db", async () => {
    await skill.createKb("sk2");
    const d = store.openKbDb("sk2");
    store.upsertDoc(d, { name: "one", groupId: null, mdSha256: "x", pages: 0, images: 0 });
    const list = await skill.listKbs();
    const s2 = list.find((k) => k.slug === "sk2");
    expect(s2).toMatchObject({ slug: "sk2", skillName: "kb-sk2", docs: 1 });
    expect(list.find((k) => k.slug === "sk1")?.docs).toBe(0);
  });

  test("kb.json 守卫：writeSkill/deleteSkill 对 KB 目录抛 ManagementError", async () => {
    await expect(writeSkill(globalSkillsDir(), "kb-sk2", { description: "hijack" })).rejects.toThrow(
      new ManagementError("ALREADY_EXISTS", "directory is managed by KB module (kb.json)"),
    );
    await expect(deleteSkill(globalSkillsDir(), "kb-sk2")).rejects.toThrow(ManagementError);
    // 非 KB 目录不受影响
    await writeSkill(globalSkillsDir(), "plain-skill", { description: "d" });
    expect(await deleteSkill(globalSkillsDir(), "plain-skill")).toBeTrue();
  });
});

describe("kb ingest：zip 透传入库", () => {
  test("ingestZip：落 docs/<doc>/<doc>.md、pages/images 计数、前缀剥离、zip-slip 拒绝", async () => {
    await skill.createKb("ing");
    const r = await ingest.ingestZip("ing", mkZip({ prefix: "outer" }), "demo-report.zip");
    expect(r.doc).toBe("demo-report");
    expect(r.pages).toBe(3);
    expect(r.images).toBe(2);
    const docDir = path.join(kbSkillPath("ing"), "docs", "demo-report");
    expect(existsSync(path.join(docDir, "demo-report.md"))).toBeTrue();
    expect(existsSync(path.join(docDir, "middle_json.json"))).toBeTrue();
    expect(existsSync(path.join(docDir, "images", "page_1_table_1.jpg"))).toBeTrue();
    expect(existsSync(path.join(docDir, "markdown.md"))).toBeFalse(); // 已改名
    const row = store.getDoc(store.openKbDb("ing"), "demo-report")!;
    expect(row.mdSha256).toBe(r.mdSha256);
    // 缺 markdown.md → INVALID_ZIP
    const bad = zipSync({ "only.txt": strToU8("x") });
    try {
      await ingest.ingestZip("ing", bad, "bad.zip");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ingest.KbError);
      expect((e as InstanceType<typeof ingest.KbError>).code).toBe("INVALID_ZIP");
    }
    // zip-slip 条目 → KbNameError
    const evil = zipSync({ "markdown.md": strToU8("x"), "../evil.md": strToU8("y") });
    await expect(ingest.ingestZip("ing", evil, "evil.zip")).rejects.toThrow(KbNameError);
  });

  test("同名重传覆盖：旧文件清除、新内容落位、md_sha256 更新", async () => {
    const first = await ingest.ingestZip("ing", mkZip({ md: "v1", pages: 2, images: 1 }), "demo-report.zip");
    const second = await ingest.ingestZip("ing", mkZip({ md: "v2", pages: 4, images: 3 }), "demo-report.zip", "A");
    expect(second.mdSha256).not.toBe(first.mdSha256);
    const docDir = path.join(kbSkillPath("ing"), "docs", "demo-report");
    expect(readFileSync(path.join(docDir, "demo-report.md"), "utf8")).toContain("v2");
    expect(existsSync(path.join(docDir, "images", "page_3_table_1.jpg"))).toBeTrue();
    const row = store.getDoc(store.openKbDb("ing"), "demo-report")!;
    expect(row.pages).toBe(4);
    expect(row.images).toBe(3);
    // 分组：A 组已建，文档挂在 A 下
    expect(store.listGroups(store.openKbDb("ing")).map((g) => g.path)).toEqual(["A"]);
  });

  test("ingestPdf：has_pdf=1 且 source.pdf 落位；未入库文档 → DOC_NOT_FOUND", async () => {
    await ingest.ingestZip("ing", mkZip(), "pdf-target.zip");
    await ingest.ingestPdf("ing", "pdf-target", new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]));
    expect(store.getDoc(store.openKbDb("ing"), "pdf-target")!.hasPdf).toBe(1);
    expect(existsSync(path.join(kbSkillPath("ing"), "docs", "pdf-target", "source.pdf"))).toBeTrue();
    await expect(ingest.ingestPdf("ing", "ghost", new Uint8Array([0x25, 0x50]))).rejects.toThrow(ingest.KbError);
  });

  test("deleteDoc：db 行 + 目录联动；不存在 → DOC_NOT_FOUND", async () => {
    await ingest.ingestZip("ing", mkZip(), "todelete.zip");
    await ingest.deleteDoc("ing", "todelete");
    expect(store.getDoc(store.openKbDb("ing"), "todelete")).toBeNull();
    expect(existsSync(path.join(kbSkillPath("ing"), "docs", "todelete"))).toBeFalse();
    await expect(ingest.deleteDoc("ing", "todelete")).rejects.toThrow(ingest.KbError);
  });
});

describe("kb compose：junction 合成", () => {
  const ws = (name: string) => path.join(dataRoot, "kbws", name);
  // compose 以 global/skills 全集为 desired——每个用例先清掉历史 KB，保证断言封闭
  const cleanGlobalKbs = () => {
    try {
      for (const n of readdirSync(globalSkillsDir())) {
        if (n.startsWith("kb-")) rmSync(path.join(globalSkillsDir(), n), { recursive: true, force: true });
      }
    } catch {}
  };

  test("合成：junction 建立、manifest 记账、重复合成不重建", async () => {
    cleanGlobalKbs();
    await skill.createKb("cmp");
    const w = ws("w1");
    await composeKbForWorkspace(w);
    const link = path.join(w, ".omp", "skills", "kb-cmp");
    const st = lstatSync(link);
    expect(st.isSymbolicLink()).toBeTrue(); // Windows junction / Linux symlink 均为符号链接
    expect(existsSync(path.join(link, "SKILL.md"))).toBeTrue(); // 经链接可达语料
    const manifest = JSON.parse(readFileSync(path.join(w, ".omp", "skills", ".kb-composed.json"), "utf8"));
    expect(manifest).toEqual({ managedBy: "omp-gateway", names: ["kb-cmp"] });
    // 重复合成：幂等（链接仍在）
    await composeKbForWorkspace(w);
    expect(lstatSync(link).isSymbolicLink()).toBeTrue();
  });

  test("自管跳过：workspace 有未管理 kb-* 目录 → 整体不碰", async () => {
    cleanGlobalKbs();
    await skill.createKb("cmp2");
    const w = ws("w2");
    const selfDir = path.join(w, ".omp", "skills", "kb-mine");
    mkdirSync(selfDir, { recursive: true });
    writeFileSync(path.join(selfDir, "notes.txt"), "user content");
    await composeKbForWorkspace(w);
    expect(existsSync(path.join(selfDir, "notes.txt"))).toBeTrue();
    expect(existsSync(path.join(w, ".omp", "skills", "kb-cmp2"))).toBeFalse(); // 整体跳过
    expect(existsSync(path.join(w, ".omp", "skills", ".kb-composed.json"))).toBeFalse();
  });

  test("fork 快照：真目录但含 kb.json → 视为网关管理，保留快照", async () => {
    cleanGlobalKbs();
    await skill.createKb("cmp3");
    const w = ws("w3");
    const forkDir = path.join(w, ".omp", "skills", "kb-cmp3");
    mkdirSync(forkDir, { recursive: true });
    writeFileSync(path.join(forkDir, "kb.json"), '{"type":"kb"}');
    await composeKbForWorkspace(w);
    expect(lstatSync(forkDir).isSymbolicLink()).toBeFalse(); // 未被重建为链接
    const manifest = JSON.parse(readFileSync(path.join(w, ".omp", "skills", ".kb-composed.json"), "utf8"));
    expect(manifest.names).toEqual(["kb-cmp3"]); // 记入管理集（KB 删除时可清理）
  });

  test("stale 清理：KB 删除后下次合成移除链接与 manifest", async () => {
    cleanGlobalKbs();
    await skill.createKb("stale9");
    const w = ws("w5");
    await composeKbForWorkspace(w);
    expect(lstatSync(path.join(w, ".omp", "skills", "kb-stale9")).isSymbolicLink()).toBeTrue();
    rmSync(kbSkillPath("stale9"), { recursive: true, force: true }); // 模拟 DELETE /admin/kb/stale9
    await composeKbForWorkspace(w);
    expect(existsSync(path.join(w, ".omp", "skills", "kb-stale9"))).toBeFalse();
    expect(existsSync(path.join(w, ".omp", "skills", ".kb-composed.json"))).toBeFalse();
  });

  test("无 KB 且 workspace 未用过：不创建目录", async () => {
    cleanGlobalKbs();
    const w = ws("w4");
    await composeKbForWorkspace(w);
    expect(existsSync(path.join(w, ".omp"))).toBeFalse();
  });
});

describe("kb skill 删除：目录 + db 文件（含 -wal/-shm）", () => {
  test("removeKbDbFile + deleteKbSkillDir", async () => {
    await skill.createKb("del1");
    store.openKbDb("del1");
    // 路径取 globalKbDir()（config 生效值），不取本地 dataRoot——与其他单测共进程时 config 可能先被别家初始化
    const dbFile = path.join(globalKbDir(), "del1.db");
    writeFileSync(`${dbFile}-wal`, "x");
    await store.removeKbDbFile("del1");
    expect(existsSync(dbFile)).toBeFalse();
    expect(existsSync(`${dbFile}-wal`)).toBeFalse();
    expect(await skill.deleteKbSkillDir("del1")).toBeTrue();
    expect(existsSync(kbSkillPath("del1"))).toBeFalse();
    expect(await skill.deleteKbSkillDir("del1")).toBeFalse();
  });
});
