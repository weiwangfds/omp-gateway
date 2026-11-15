/**
 * 用户级配置路由的**组合根**（DESIGN §31）。
 *
 * 端点实现按领域拆到 `routes/config/*`，本文件只负责：
 *  1. 挂全权身份中间件（models.yml 含明文 apiKey，分享令牌一律 403）
 *  2. 按固定顺序 mount 各子路由（同一 Hono 实例合并，保持路径优先级可预期）
 *
 * 子路由全部是纯 `Hono<ConfigEnv>` 实例，不感知挂载点；新增配置面时
 * 只需新增一个模块 + 在下方加一行 mount。
 */
import { Hono } from "hono";
import { requireFullAuth } from "../middleware/auth.ts";
import { approvalApp } from "./config/approval.ts";
import { contextFilesApp } from "./config/context-files.ts";
import type { ConfigEnv } from "./config/env.ts";
import { hooksApp } from "./config/hooks.ts";
import { httpToolsApp } from "./config/http-tools.ts";
import { limitsApp } from "./config/limits.ts";
import { mcpApp } from "./config/mcp.ts";
import { modelsCatalogApp } from "./config/models-catalog.ts";
import { providersApp } from "./config/providers.ts";
import { skillsPluginsApp } from "./config/skills-plugins.ts";
import { webhooksApp } from "./config/webhooks.ts";

export const configResourcesApp = new Hono<ConfigEnv>();

// 🔒 全权身份限定：在 mount 之前注册，子路由同样经过该中间件
configResourcesApp.use("*", requireFullAuth);

configResourcesApp.route("/", skillsPluginsApp);
configResourcesApp.route("/", approvalApp);
configResourcesApp.route("/", modelsCatalogApp);
configResourcesApp.route("/", webhooksApp);
configResourcesApp.route("/", contextFilesApp);
configResourcesApp.route("/", hooksApp);
configResourcesApp.route("/", httpToolsApp);
configResourcesApp.route("/", providersApp);
configResourcesApp.route("/", limitsApp);
configResourcesApp.route("/", mcpApp);
