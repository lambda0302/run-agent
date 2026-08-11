/**
 * V5 决策 B3：MCP 工具 → 标准 Tool 的包装器。
 * - 名：mcp__<normalizedServer>__<toolName>（normalizeNameForMCP：小写、非 [a-z0-9_] → _）。
 * - desc：截断到 MAX_MCP_DESCRIPTION_LENGTH（2048），防 OpenAPI 生成 server 的 15-60KB desc 灌爆上下文。
 * - inputSchema：z.record(z.string(), z.unknown())（passthrough 通配）——懒 schema，不为每个 MCP 工具
 *   传输/维护完整 zod schema，入参校验完全交给 server 自身；zodToJsonSchema 输出 { type:"object" }，几乎零 token。
 * - isConcurrencySafe = annotations?.readOnlyHint === true（只读工具可并行，其余串行）。
 * call 把 MCP callTool 的 text 内容拼回 tool_result；错误/isError 一律字符串回填（不 throw，loop 语义不变）。
 */
import { z } from "zod";
import type { Tool, ToolCallResult } from "../../tools.js";

export const MAX_MCP_DESCRIPTION_LENGTH = 2048;

/** MCP 工具描述（listTools 返回的工具元数据子集）。
 *  可选字段显式含 undefined：SDK 类型在 exactOptionalPropertyTypes 下声明为 string|undefined。 */
export interface McpToolDescriptor {
  name: string;
  description?: string | undefined;
  /** SDK 的 annotations 含 readOnlyHint/destructiveHint/…，全可选；用宽松结构承接。 */
  annotations?: { readOnlyHint?: boolean | undefined; [k: string]: unknown } | undefined;
}

/** 包装器依赖的最小 Client 表面（便于测试注入）。
 *  isError 显式含 undefined：SDK 返回类型在 exactOptionalPropertyTypes 下为 boolean|undefined。 */
export interface McpClientLike {
  callTool(params: { name: string; arguments?: Record<string, unknown> | undefined }): Promise<{
    content: Array<{ type: string; text?: string }>;
    isError?: boolean | undefined;
  }>;
}

/** 服务器名/tool 名规范化：小写、非 [a-z0-9_] → _（roadmap 的 mcp__server__tool 命名）。 */
export function normalizeNameForMCP(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

/** 包装一个 MCP 工具为标准 Tool。isConcurrencySafe 显式赋值（readOnlyHint 为 false 时串行）。 */
export function wrapMcpTool(
  serverName: string,
  mcpTool: McpToolDescriptor,
  client: McpClientLike,
): Tool {
  const name = `mcp__${normalizeNameForMCP(serverName)}__${mcpTool.name}`;
  const description = (mcpTool.description ?? "").slice(0, MAX_MCP_DESCRIPTION_LENGTH);
  const isReadOnly = mcpTool.annotations?.readOnlyHint === true;
  return {
    name,
    description:
      description || `MCP tool ${mcpTool.name} from server ${serverName}（server 未提供描述）`,
    inputSchema: z.record(z.string(), z.unknown()),
    isConcurrencySafe: isReadOnly,
    async call(input): Promise<ToolCallResult> {
      try {
        const args =
          input && typeof input === "object" && !Array.isArray(input)
            ? (input as Record<string, unknown>)
            : {};
        const r = await client.callTool({ name: mcpTool.name, arguments: args });
        const text = (r.content ?? [])
          .filter((c) => c.type === "text" && c.text !== undefined)
          .map((c) => c.text)
          .join("\n");
        if (r.isError) return { result: `MCP 工具 ${name} 返回错误：${text || "（无错误详情）"}` };
        return { result: text || "（MCP 工具无文本输出）" };
      } catch (e) {
        return {
          result: `MCP 工具 ${name} 调用失败: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    },
  };
}
