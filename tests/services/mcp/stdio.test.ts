/**
 * V5 决策 B2/B3 集成：真实 stdio MCP server 端到端（生产 makeTransport 路径，非 InMemory）。
 * hermetic：spawn 仓库内示例 server（node 子进程，无网络）；CI 有 node + SDK。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { McpServerConfig } from "../../../src/services/mcp/config.js";
import { McpManager } from "../../../src/services/mcp/manager.js";

const exampleServer = path.join(dirname(), "..", "..", "..", "examples", "mcp-server", "index.js");

function dirname(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

describe("McpManager 真实 stdio server（生产传输路径）", () => {
  it("连接示例 server → 注册 echo/timestamp → 调用 echo 拿到结果；readOnlyHint 生效", async () => {
    const cfg: Record<string, McpServerConfig> = {
      demo: {
        type: "stdio",
        command: process.execPath,
        args: [exampleServer],
      },
    };
    const m = new McpManager(cfg);
    try {
      const res = await m.connect("demo");
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error(res.error);
      const names = res.tools.map((t) => t.name).sort();
      expect(names).toEqual(["mcp__demo__echo", "mcp__demo__timestamp"]);
      // readOnlyHint → 只读名进入权限闭包
      expect(m.isReadOnly("mcp__demo__echo")).toBe(true);
      expect(m.isReadOnly("mcp__demo__timestamp")).toBe(false);
      expect(m.getStatuses()[0]).toEqual({ name: "demo", status: "connected" });

      const echo = res.tools.find((t) => t.name === "mcp__demo__echo")!;
      const r = await echo.call({ text: "你好" });
      expect(r.result).toBe("echo:你好");
    } finally {
      await m.closeAll();
    }
  });
});
