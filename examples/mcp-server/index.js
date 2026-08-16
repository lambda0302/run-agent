#!/usr/bin/env node
/**
 * run-agent MCP 示例 server（最小 stdio server，供本地验证，无真实 I/O 副作用）。
 *
 * 用途：验证 run-agent 的 MCP 接入端到端链路——
 *   配置 mcp.json → 启动预连 demo → 模型调 mcp__demo__echo / mcp__demo__timestamp
 *
 * 运行（仓库根目录，node_modules 已装 SDK）：
 *   node examples/mcp-server/index.js
 *
 * 暴露两个工具：
 *   - echo       只读标注（readOnlyHint）——连上后 plan 模式可用、可并行
 *   - timestamp  非只读（写类语义示范）——default 下必 ask、plan 下 deny
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "run-agent-demo", version: "0.5.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echo the given text back. Read-only: no side effects.",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      annotations: { readOnlyHint: true },
    },
    {
      name: "timestamp",
      description: "Return a formatted timestamp string. Non-read-only example.",
      inputSchema: { type: "object", properties: { format: { type: "string" } } },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  switch (name) {
    case "echo":
      return { content: [{ type: "text", text: `echo:${String(args?.text ?? "")}` }] };
    case "timestamp":
      return { content: [{ type: "text", text: new Date().toISOString() }] };
    default:
      return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
