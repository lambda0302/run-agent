/**
 * M2 测试辅助：用 MCP SDK 的 InMemoryTransport 在测试进程内起一个最小 server（hermetic，无网络）。
 * 暴露 client 端传输给 McpManager.connect 注入；close() 关闭 server。
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export interface MockToolDef {
  name: string;
  description?: string;
  readOnlyHint?: boolean;
  /** 处理调用；返回文本（缺省 "ok:<name>"）。 */
  handler?: (args: Record<string, unknown>) => string;
  /** 置 true 时 handler 返回 isError。 */
  error?: boolean;
}

export interface MockServerHandle {
  /** 交给 McpManager.connect 的 client 端传输。 */
  clientTransport: Transport;
  close(): Promise<void>;
}

/** 启动一个 in-memory MCP server，返回 client 端传输。server 连接在 close 时一并回收。 */
export async function startMockServer(tools: MockToolDef[]): Promise<MockServerHandle> {
  const server = new Server({ name: "mock", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
      ...(t.readOnlyHint ? { annotations: { readOnlyHint: true } } : {}),
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const def = tools.find((t) => t.name === name);
    if (!def) {
      return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
    }
    const text = def.handler ? def.handler(args ?? {}) : `ok:${name}`;
    return { content: [{ type: "text", text }], ...(def.error ? { isError: true } : {}) };
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  // server 端开始监听（握手由 client.connect 完成）
  const serverReady = server.connect(serverTransport);
  return {
    clientTransport,
    async close() {
      try {
        await server.close();
      } catch {
        // 已关闭
      }
      await serverReady.catch(() => {});
    },
  };
}
