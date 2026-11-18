/**
 * agent-compose 单元测试：全局 agents → workspace .omp/agents 合成。
 * - 用户同名覆盖全局（跳过合成）
 * - 自管目录（含未管理 .md）不碰
 * - manifest 记账：全局更新后重算刷新、全局删除后清理、fork 场景（已有合成文件）重算
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// config 在 import 时固定 dataRoot（读 GATEWAY_DATA_ROOT）——先备好临时根再动态加载被测模块
const dataRoot = mkdtempSync(path.join(tmpdir(), "omp-gw-agentcompose-"));
process.env.GATEWAY_DATA_ROOT = dataRoot;
const { composeAgentsForWorkspace } = await import("../src/core/agent-compose.ts");

const globalDir = path.join(dataRoot, "global", "agents");
const userDir = (uid: string) => path.join(dataRoot, "users", uid, "agent", "agents");
const ws = (name: string) => path.join(dataRoot, "ws", name);
const MD = (name: string, desc: string) => `---\nname: ${name}\ndescription: ${desc}\n---\n\nbody of ${name}\n`;

function put(dir: string, name: string, content: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${name}.md`), content);
}

describe("agent-compose：全局 agents 合成进 workspace", () => {
  test("基础合成：全局两个、用户同名一个 → workspace 只得未被覆盖的 + manifest 记账", async () => {
    put(globalDir, "kb-researcher", MD("kb-researcher", "global"));
    put(globalDir, "shared-one", MD("shared-one", "global"));
    put(userDir("u1"), "shared-one", MD("shared-one", "user"));
    const w = ws("w1");
    await composeAgentsForWorkspace("u1", w);
    expect(existsSync(path.join(w, ".omp", "agents", "kb-researcher.md"))).toBeTrue();
    expect(existsSync(path.join(w, ".omp", "agents", "shared-one.md"))).toBeFalse(); // 用户同名覆盖
    const manifest = JSON.parse(readFileSync(path.join(w, ".omp", "agents", ".gateway-composed.json"), "utf8"));
    expect(manifest.managedBy).toBe("omp-gateway");
    expect(manifest.files).toEqual(["kb-researcher.md"]);
  });

  test("全局更新 + fork 重算：已合成文件内容刷新为新版", async () => {
    put(globalDir, "kb-researcher", MD("kb-researcher", "global v2"));
    const w = ws("w1"); // 上一轮已合成（模拟 fork 拷贝后的重算）
    await composeAgentsForWorkspace("u1", w);
    expect(readFileSync(path.join(w, ".omp", "agents", "kb-researcher.md"), "utf8")).toContain("global v2");
  });

  test("全局删除 → 重算清理已合成文件与 manifest", async () => {
    rmSync(path.join(globalDir, "kb-researcher.md"));
    put(globalDir, "shared-one", MD("shared-one", "global")); // u1 覆盖它，仍不该合成
    const w = ws("w1");
    await composeAgentsForWorkspace("u1", w);
    expect(existsSync(path.join(w, ".omp", "agents", "kb-researcher.md"))).toBeFalse();
    expect(existsSync(path.join(w, ".omp", "agents", ".gateway-composed.json"))).toBeFalse(); // desired 为空 → 收走
  });

  test("自管目录：存在未管理 .md → 完全不碰", async () => {
    put(globalDir, "fresh-global", MD("fresh-global", "global"));
    const w = ws("w2");
    put(path.join(w, ".omp", "agents"), "self-managed", MD("self-managed", "mine"));
    await composeAgentsForWorkspace("u2", w);
    expect(existsSync(path.join(w, ".omp", "agents", "fresh-global.md"))).toBeFalse();
    expect(existsSync(path.join(w, ".omp", "agents", ".gateway-composed.json"))).toBeFalse();
    expect(readFileSync(path.join(w, ".omp", "agents", "self-managed.md"), "utf8")).toContain("mine");
  });

  test("全局为空 + workspace 未用过 → 不创建任何目录", async () => {
    for (const f of readdirSync(globalDir)) if (f.endsWith(".md")) rmSync(path.join(globalDir, f)); // 清空全局
    const w = ws("w3");
    await composeAgentsForWorkspace("u3", w);
    expect(existsSync(path.join(w, ".omp"))).toBeFalse();
  });
});
