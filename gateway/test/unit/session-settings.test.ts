/**
 * 会话级 omp settings 合成（DESIGN §41.7）：OMP_SESSION_SETTINGS_JSON →
 * <workspace>/.omp/settings.json。覆盖：未设不写 / 合法写入 / 深度合并部署键优先 /
 * 坏 JSON fail-open / 内容一致不落盘。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { composeSessionSettingsForWorkspace } from "../../src/core/session-assembly.ts";

const ENV_KEY = "OMP_SESSION_SETTINGS_JSON";
let root: string;

const wsWith = async (content?: string): Promise<string> => {
  const ws = path.join(root, `ws-${Math.random().toString(36).slice(2, 8)}`);
  await fs.mkdir(ws, { recursive: true });
  if (content !== undefined) {
    await fs.mkdir(path.join(ws, ".omp"), { recursive: true });
    await fs.writeFile(path.join(ws, ".omp", "settings.json"), content, "utf8");
  }
  return ws;
};
const readSettings = (ws: string): Promise<string | null> =>
  fs.readFile(path.join(ws, ".omp", "settings.json"), "utf8").catch(() => null);

describe("composeSessionSettingsForWorkspace", () => {
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "omp-session-settings-"));
    delete process.env[ENV_KEY];
  });
  afterEach(() => {
    delete process.env[ENV_KEY];
    fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  test("env 未设 → 不写 settings（omp 默认行为）", async () => {
    const ws = await wsWith();
    await composeSessionSettingsForWorkspace(ws);
    expect(await readSettings(ws)).toBeNull();
  });

  test("合法 JSON → 写入 .omp/settings.json", async () => {
    const ws = await wsWith();
    process.env[ENV_KEY] = '{"web_search.enabled":false,"fetch.enabled":false}';
    await composeSessionSettingsForWorkspace(ws);
    const raw = await readSettings(ws);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toEqual({ "web_search.enabled": false, "fetch.enabled": false });
  });

  test("已存在 settings → 浅合并，部署键优先", async () => {
    const ws = await wsWith('{"fetch.enabled":true,"github.enabled":true}');
    process.env[ENV_KEY] = '{"fetch.enabled":false}';
    await composeSessionSettingsForWorkspace(ws);
    expect(JSON.parse((await readSettings(ws)) as string)).toEqual({
      "fetch.enabled": false, // 部署键覆盖
      "github.enabled": true, // 既有键保留
    });
  });

  test("坏 JSON env → 告警跳过，不写文件、不抛", async () => {
    const ws = await wsWith();
    process.env[ENV_KEY] = "{not-json";
    await composeSessionSettingsForWorkspace(ws);
    expect(await readSettings(ws)).toBeNull();
  });

  test("数组/标量 env → 同样跳过", async () => {
    const ws = await wsWith();
    process.env[ENV_KEY] = "[1,2]";
    await composeSessionSettingsForWorkspace(ws);
    expect(await readSettings(ws)).toBeNull();
  });

  test("fork 拷贝带来的同内容 settings → 不重复落盘", async () => {
    // 夹具用合成器的输出格式（pretty + 换行）：fork 来源就是上一个会话的合成产物
    const content = `${JSON.stringify({ "web_search.enabled": false }, null, 2)}\n`;
    const ws = await wsWith(content);
    process.env[ENV_KEY] = '{"web_search.enabled":false}';
    await composeSessionSettingsForWorkspace(ws);
    expect(await readSettings(ws)).toBe(content);
  });
});
