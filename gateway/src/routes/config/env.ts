/** 用户级配置路由共享的 Hono 环境（X-User-Id 由 auth 中间件注入）。 */
export type ConfigEnv = { Variables: { userId: string } };
