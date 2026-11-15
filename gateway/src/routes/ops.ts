/** 运维端点（内网无凭据）：healthz / readyz / metrics；openapi.json 由 index.ts 单独挂载。 */
import { Hono } from "hono";
import * as fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.ts";
import { registry } from "../core/session-registry.ts";
import { streamingGate } from "../core/streaming-gate.ts";
import { budgetExceededCount, rateLimitedCount } from "../core/rate-limit.ts";
import { usageTotals } from "../core/tenant-store.ts";
import { draining } from "../middleware/auth.ts";

/** 运维端点（内网，无 token——健康检查不依赖凭据）。 */
export const opsApp = new Hono();

opsApp.get("/healthz", (c) =>
  c.json(draining.value ? { status: "draining" } : { status: "ok" }, draining.value ? 503 : 200),
);

opsApp.get("/readyz", async (c) => {
  try {
    const probe = path.join(config.dataRoot, ".readyz-probe");
    await fs.writeFile(probe, String(Date.now()), "utf8");
    await fs.unlink(probe).catch(() => {});
    return c.json({ ready: true });
  } catch (err) {
    return c.json({ ready: false, error: String(err) }, 503);
  }
});

opsApp.get("/metrics", (c) => {
  let live = 0;
  let streaming = 0;
  for (const ctx of registry.values()) {
    live++;
    if (ctx.streaming) streaming++;
  }
  const usage = usageTotals();
  const gate = streamingGate.stats();
  const body = `${[
    "# TYPE omp_gateway_sessions_live gauge",
    `omp_gateway_sessions_live ${live}`,
    "# TYPE omp_gateway_sessions_streaming gauge",
    `omp_gateway_sessions_streaming ${streaming}`,
    "# TYPE omp_gateway_configured_max_global_streaming gauge",
    `omp_gateway_configured_max_global_streaming ${config.maxGlobalStreaming}`,
    "# TYPE omp_gateway_stream_slots_held gauge",
    `omp_gateway_stream_slots_held ${gate.held}`,
    "# TYPE omp_gateway_stream_queue_waiting gauge",
    `omp_gateway_stream_queue_waiting ${gate.waiting}`,
    "# TYPE omp_gateway_usage_turns_total counter",
    `omp_gateway_usage_turns_total ${usage.turns}`,
    "# TYPE omp_gateway_usage_input_tokens_total counter",
    `omp_gateway_usage_input_tokens_total ${usage.input}`,
    "# TYPE omp_gateway_usage_output_tokens_total counter",
    `omp_gateway_usage_output_tokens_total ${usage.output}`,
    "# TYPE omp_gateway_usage_cost_usd_total counter",
    `omp_gateway_usage_cost_usd_total ${usage.costUsd.toFixed(6)}`,
    "# TYPE omp_gateway_rate_limited_total counter",
    `omp_gateway_rate_limited_total ${rateLimitedCount()}`,
    "# TYPE omp_gateway_budget_exceeded_total counter",
    `omp_gateway_budget_exceeded_total ${budgetExceededCount()}`,
  ].join("\n")}\n`;
  return c.text(body);
});
