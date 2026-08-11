/**
 * V5 决策 B3：mcp_connect 工具（按需连接入口，工厂装配）。
 * - 入参 { server }；连接该 server → listTools → 包装注册进 manager → 返回工具清单。
 * - 权限：mcp_connect 免确认（engine 的 default 兜底是 ask，但 M1 的「导航工具」豁免不覆盖它——
 *   见 permissions/types.ts 的导航工具集合；mcp_connect 需要显式放行）。
 *   用户写好配置 = 已授权；项目级配置仅 Trust 加载是第二道门（对齐参考实现的连接语义）。
 */
import { z } from "zod";
import type { Tool, ToolCallResult } from "../../tools.js";
import type { McpManager } from "./manager.js";

const schema = z.object({
  server: z.string().min(1).describe("MCP server name（/mcp 查看已配置列表）"),
});

/** 每工具清单行：名 + desc 截断，避免刷屏。 */
const DESC_PREVIEW = 120;

export function makeMcpConnectTool(manager: McpManager): Tool {
  return {
    name: "mcp_connect",
    description:
      "Connect to an MCP server on demand (see the system prompt for configured servers). " +
      "Registers its tools as mcp__<server>__<tool> so you can call them. " +
      "Only connect the server you actually need — each connection spawns a subprocess or opens a network session.",
    inputSchema: schema,
    isConcurrencySafe: false,
    async call(input): Promise<ToolCallResult> {
      const { server } = schema.parse(input);
      const res = await manager.connect(server);
      if (!res.ok) return { result: res.error };
      if (res.tools.length === 0) {
        return { result: `已连接 MCP server ${server}，但未注册到任何工具。` };
      }
      const lines = res.tools.map((t) => {
        const desc = t.description.replace(/\s+/g, " ").slice(0, DESC_PREVIEW);
        return `- ${t.name}: ${desc}${t.description.length > DESC_PREVIEW ? "…" : ""}`;
      });
      return {
        result: `已连接 MCP server ${server}，注册 ${res.tools.length} 个工具（下轮起可调用）：\n${lines.join("\n")}`,
      };
    },
  };
}
