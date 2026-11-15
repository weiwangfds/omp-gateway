/**
 * 最小 stdio MCP 服务器（测试夹具）：提供 echo 工具，回显 text。
 * newline-delimited JSON-RPC 2.0；处理 initialize / tools/list / tools/call。
 */
import { createInterface } from "node:readline";

interface RpcMsg {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
}

const send = (msg: Record<string, unknown>) => {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
};

const TOOLS = [
  {
    name: "echo",
    description: "Echo back the given text (test fixture)",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "text to echo" } },
      required: ["text"],
    },
  },
];

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: RpcMsg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (!msg.method || msg.id === undefined) return; // notification
  switch (msg.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "mcp-echo-fixture", version: "1.0.0" },
        },
      });
      break;
    case "tools/list":
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
      break;
    case "tools/call": {
      const text = String(msg.params?.arguments?.text ?? "");
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: `ECHO:${text}` }] },
      });
      break;
    }
    default:
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
  }
});
