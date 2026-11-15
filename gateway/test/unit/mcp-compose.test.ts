import { beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { config } from "../../src/config.ts";
import { composeMcpForWorkspace } from "../../src/core/mcp-compose.ts";

const root = config.dataRoot; // preload 已指向临时目录
const writeJson = (file: string, obj: unknown) =>
  fs.mkdir(path.dirname(file), { recursive: true }).then(() => fs.writeFile(file, JSON.stringify(obj, null, 2)));
const readJson = async (file: string) => JSON.parse(await fs.readFile(file, "utf8"));

async function freshUser(name: string, servers: Record<string, unknown> | null) {
  const agentDir = path.join(root, "users", name, "agent");
  if (servers) await writeJson(path.join(agentDir, "mcp.json"), { mcpServers: servers });
  return { agentDir, ws: path.join(root, "users", name, "workspaces", "ws1") };
}

beforeEach(async () => {
  await writeJson(path.join(root, "global", "mcp.json"), {
    mcpServers: {
      "shared-fs": { type: "stdio", command: "global-cmd" },
      "global-only": { type: "http", url: "https://g" },
    },
  });
});

describe("composeMcpForWorkspace", () => {
  test("无用户配置 → 全局原样注入 + 网关标记", async () => {
    const { ws } = await freshUser("u-empty", null);
    await composeMcpForWorkspace("u-empty", ws);
    const out = await readJson(path.join(ws, ".omp", "mcp.json"));
    expect(out._managedBy).toBe("omp-gateway");
    expect(Object.keys(out.mcpServers).sort()).toEqual(["global-only", "shared-fs"]);
  });

  test("用户同名覆盖全局，其余全局保留", async () => {
    const { ws } = await freshUser("u-over", {
      "shared-fs": { type: "stdio", command: "user-cmd" },
      "user-only": { type: "http", url: "https://u" },
    });
    await composeMcpForWorkspace("u-over", ws);
    const out = await readJson(path.join(ws, ".omp", "mcp.json"));
    expect(out.mcpServers["shared-fs"].command).toBe("user-cmd");
    expect(out.mcpServers["global-only"].url).toBe("https://g");
    expect(out.mcpServers["user-only"].url).toBe("https://u");
  });

  test("项目自管 mcp.json（无标记）→ 网关不碰", async () => {
    const { ws } = await freshUser("u-proj", { "user-only": {} });
    const projectFile = path.join(ws, ".omp", "mcp.json");
    await writeJson(projectFile, { mcpServers: { "project-own": { type: "stdio", command: "proj" } } });
    await composeMcpForWorkspace("u-proj", ws);
    const out = await readJson(projectFile);
    expect(out).toEqual({ mcpServers: { "project-own": { type: "stdio", command: "proj" } } });
  });

  test("网关自管文件 → 下次合成刷新", async () => {
    const { ws } = await freshUser("u-mgd", null);
    await composeMcpForWorkspace("u-mgd", ws);
    // 全局新增一个 server 后重合成
    await writeJson(path.join(root, "global", "mcp.json"), {
      mcpServers: { added: { type: "http", url: "https://x" } },
    });
    await composeMcpForWorkspace("u-mgd", ws);
    const out = await readJson(path.join(ws, ".omp", "mcp.json"));
    expect(Object.keys(out.mcpServers)).toEqual(["added"]);
  });

  test("幂等：内容相同不重写（mtime 不变）", async () => {
    const { ws } = await freshUser("u-idem", null);
    const file = path.join(ws, ".omp", "mcp.json");
    await composeMcpForWorkspace("u-idem", ws);
    const m1 = (await fs.stat(file)).mtimeMs;
    await new Promise((r) => setTimeout(r, 30));
    await composeMcpForWorkspace("u-idem", ws);
    expect((await fs.stat(file)).mtimeMs).toBe(m1);
  });
});
