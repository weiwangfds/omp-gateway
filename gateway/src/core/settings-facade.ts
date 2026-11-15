import type { Settings } from "@oh-my-pi/pi-coding-agent";
import { getUserContext, reloadUserContext } from "./user-context.ts";

/**
 * 用户级设置门面（Facade）：把 "取 UserContext → 导入 cfg 常量 → get/writeValue" 的样板收敛。
 *
 * 此前 approval / model-roles / providers-settings 三个路由各自动态 import setting 常量并
 * 直接操作 uctx.settings；语义（global 层、内存即时生效、不 rebuild）散落各处。
 * 这里统一：
 * - `read(uid, setting)`  同步读内存视图
 * - `write(uid, setting, value)` 写 global 层（持久化到该用户 agentDir/config.yml）
 * - `reload(uid)` 仅在 registry 需要重建时显式调用（settings 写入本身不需要）
 */
export interface SettingHandle<T> {
  id: string;
  get(settings: Settings): T | undefined;
}

export const userSettings = {
  async context(uid: string) {
    return getUserContext(uid);
  },

  /** 读当前生效值（内存视图，无需 reload）。 */
  async read<T>(uid: string, setting: SettingHandle<T>): Promise<T | undefined> {
    const uctx = await getUserContext(uid);
    return setting.get(uctx.settings);
  },

  /** 批量读（一次取 UserContext）。 */
  async readMany(uid: string, settings: Array<SettingHandle<unknown>>): Promise<Array<unknown>> {
    const uctx = await getUserContext(uid);
    return settings.map((s) => s.get(uctx.settings));
  },

  /**
   * 写 global 层（落盘 best-effort 异步）。**不 rebuild UserContext**：
   * 立即 reload 会读到尚未落盘的旧文件；内存视图已即时生效，ModelRegistry 持同一实例。
   */
  async write<T>(uid: string, setting: SettingHandle<T>, value: T): Promise<void> {
    const uctx = await getUserContext(uid);
    uctx.settings.writeValue(setting as never, value, "global");
  },

  async unset(uid: string, setting: SettingHandle<unknown>): Promise<void> {
    const uctx = await getUserContext(uid);
    uctx.settings.unsetGlobalValue(setting as never);
  },

  /** 需要重建 registry（models.yml/mcp.json 变更）时使用。 */
  async rebuild(uid: string) {
    return reloadUserContext(uid);
  },
};
