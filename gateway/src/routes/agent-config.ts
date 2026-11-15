/**
 * 用户级模型角色 / Agent 定义 / MCP 设置的**组合根**（DESIGN §28 / §31）。
 *
 * - model-roles.ts    config.yml 的 modelRoles / cycleOrder
 * - agents.ts         agentDir/agents/*.md CRUD（原文 + 结构化 JSON）
 * - mcp-settings.ts   mcp.json 的 disabledServers/enabledServers
 */
import { Hono } from "hono";
import { requireFullAuth } from "../middleware/auth.ts";
import { mountAgentDefinitionRoutes } from "./agent-config/agents.ts";
import type { AgentConfigEnv } from "./agent-config/env.ts";
import { mountMcpSettingsRoutes } from "./agent-config/mcp-settings.ts";
import { mountModelRoleRoutes } from "./agent-config/model-roles.ts";

export type Env = AgentConfigEnv;

export const agentConfigApp = new Hono<Env>();
agentConfigApp.use("*", requireFullAuth);

mountModelRoleRoutes(agentConfigApp);
mountAgentDefinitionRoutes(agentConfigApp);
mountMcpSettingsRoutes(agentConfigApp);
