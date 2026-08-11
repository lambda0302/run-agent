/**
 * V5 决策 B3 测试：mcp_connect 工具（按需连接工厂）——成功清单 / 空工具 / 失败 / 权限豁免。
 */
import { describe, expect, it } from "vitest";
import type { McpServerConfig } from "../../../src/services/mcp/config.js";
import { McpManager } from "../../../src/services/mcp/manager.js";
import { makeMcpConnectTool } from "../../../src/services/mcp/mcp_connect.js";
import { startMockServer } from "./mockServer.js";

async function connectedManager(tools: Parameters<typeof startMockServer>[0]): Promise<McpManager> {
  const m = new McpManager({ mock: { type: "stdio", command: "x" } as McpServerConfig });
  const srv = await startMockServer(tools);
  await m.connect("mock", srv.clientTransport);
  return m;
}

describe("makeMcpConnectTool", () => {
  it("入参校验：缺 server → 抛错；连接成功 → 返回工具清单（desc 截断）", async () => {
    const m = await connectedManager([
      { name: "read_file", description: "Read a file from disk. ".repeat(20) },
    ]);
    try {
      const tool = makeMcpConnectTool(m);
      expect(tool.name).toBe("mcp_connect");
      expect(tool.isConcurrencySafe).toBe(false);
      await expect(tool.call({} as never)).rejects.toThrow();

      const r = await tool.call({ server: "mock" });
      expect(r.result).toContain("已连接 MCP server mock");
      expect(r.result).toContain("mcp__mock__read_file");
      // desc 截断到 120 字符 + 省略号
      expect(r.result).toContain("…");
    } finally {
      await m.closeAll();
    }
  });

  it("server 无工具 → 提示已连接但零工具", async () => {
    const m = await connectedManager([]);
    try {
      const r = await makeMcpConnectTool(m).call({ server: "mock" });
      expect(r.result).toContain("未注册到任何工具");
    } finally {
      await m.closeAll();
    }
  });

  it("连接失败 → 错误回填（不 throw）", async () => {
    const m = new McpManager({ bad: { type: "stdio", command: "not-a-real-command" } });
    const r = await makeMcpConnectTool(m).call({ server: "bad" });
    expect(r.result).toContain("失败");
  });

  it("未知 server → 错误回填", async () => {
    const m = new McpManager({});
    const r = await makeMcpConnectTool(m).call({ server: "nope" });
    expect(r.result).toContain("未知");
  });
});
