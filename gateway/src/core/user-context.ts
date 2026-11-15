import {
  discoverAuthStorage,
  ModelRegistry,
  Settings,
  type AuthStorage,
  type Settings as SettingsT,
} from "@oh-my-pi/pi-coding-agent";
import type { Model } from "@oh-my-pi/pi-catalog";
import { ensureUserScaffold, userAgentDir, userSessionsDir, userRoot } from "./paths.ts";
import path from "node:path";

/**
 * UserContext（DESIGN §9 集成层）：把一个 user_id 物化成该用户私有的 SDK 对象集合。
 * 同一用户的所有会话共享同一实例；models.yml / mcp.json 变更后调 reloadUserContext()。
 */
export interface UserContext {
  userId: string;
  agentDir: string;
  sessionsDir: string;
  settings: SettingsT;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  /** 在该用户的 registry 中解析 provider/modelId → Model 对象（setModel 收 Model）。 */
  resolveModel(provider: string, modelId: string): Model | undefined;
}

// userId → 构建中/已完成的 UserContext。缓存 Promise 而非结果：并发首调复用同一次构建。
const cache = new Map<string, Promise<UserContext>>();

/** 取（或构建）用户的 SDK 对象集合；构建失败会从缓存剔除，下次调用重试。 */
export function getUserContext(userId: string): Promise<UserContext> {
  let entry = cache.get(userId);
  if (!entry) {
    entry = build(userId).catch((err) => {
      cache.delete(userId);
      throw err;
    });
    cache.set(userId, entry);
  }
  return entry;
}

/** 配置变更（models.yml / mcp.json 等）后重建该用户的 SDK 对象；对活跃会话下次使用时生效。 */
export async function reloadUserContext(userId: string): Promise<UserContext> {
  const old = cache.get(userId);
  if (old) {
    try {
      await old; // 等待进行中的构建完成，避免并发双建
    } catch {}
  }
  cache.delete(userId);
  return getUserContext(userId);
}

async function build(userId: string): Promise<UserContext> {
  await ensureUserScaffold(userId);

  const agentDir = userAgentDir(userId);
  // 隔离实例（DESIGN §27 修复）：Settings.init 是**进程级单例**（首调 agentDir 决定，
  // 后续调用返回同一实例）——多租户下会让所有用户共享第一个用户的 config.yml
  //（approvalMode/disabledProviders 等全部串用户）。loadIsolated 不碰全局单例，
  // 且仍是可写实例（writeValue 持久化到该用户 agentDir/config.yml）。
  const settings = await Settings.loadIsolated({
    cwd: userRoot(userId),
    agentDir,
    // skills 不走 process 级发现（settings holder 会让跨用户目录互相泄漏）——
    // 由 session-factory 用 loadSkillsFromDir 逐用户加载后经 options.skills 直接注入（DESIGN §3 修订）
    overrides: {},
  });

  const authStorage = await discoverAuthStorage(agentDir, { settings });
  // 显式 models.yml 路径：多租户下绝不能让 registry 落回进程级 ~/.omp（DESIGN §3）。
  // options.settings 接上该用户 settings：模型可用性/上下文窗口策略按用户生效
  //（与 SDK 默认构造路径一致，sdk.ts 同样传 settings + cacheDbPath）。
  const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), {
    settings,
  });

  return {
    userId,
    agentDir,
    sessionsDir: userSessionsDir(userId),
    settings,
    authStorage,
    modelRegistry,
    resolveModel(provider: string, modelId: string): Model | undefined {
      return modelRegistry.getAvailable().find((m) => m.provider === provider && m.id === modelId);
    },
  };
}
