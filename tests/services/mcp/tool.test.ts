/**
 * V5 决策 B3 测试：wrapMcpTool 包装规则——命名 / desc 截断 2048 / 懒 schema / readOnlyHint /
 * call 的 text 提取与 isError 回填。
 */
import { describe, expect, it } from "vitest";
import { zodToJsonSchema } from "../../../src/tools.js";
import type { McpClientLike, McpToolDescriptor } from "../../../src/services/mcp/tool.js";
import {
  MAX_MCP_DESCRIPTION_LENGTH,
  normalizeNameForMCP,
  wrapMcpTool,
} from "../../../src/services/mcp/tool.js";

/** 记录参数的 mock client。 */
function stubClient(impl?: {
  text?: string;
  isError?: boolean;
  call?: (args: Record<string, unknown>) => { text: string; isError?: boolean };
}): { client: McpClientLike; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const client: McpClientLike = {
    async callTool(params) {
      calls.push(params.arguments ?? {});
      const r = impl?.call ? impl.call(params.arguments ?? {}) : undefined;
      const text = r?.text ?? impl?.text ?? "ok";
      const isError = r?.isError ?? impl?.isError;
      return { content: [{ type: "text", text }], ...(isError !== undefined ? { isError } : {}) };
    },
  };
  return { client, calls };
}

describe("normalizeNameForMCP", () => {
  it("小写 + 非 [a-z0-9_] → _", () => {
    expect(normalizeNameForMCP("My Server")).toBe("my_server");
    expect(normalizeNameForMCP("filesystem")).toBe("filesystem");
    expect(normalizeNameForMCP("a.b-c/d")).toBe("a_b_c_d");
    expect(normalizeNameForMCP("UPPER_Case")).toBe("upper_case");
  });
});

describe("wrapMcpTool", () => {
  const desc: McpToolDescriptor = { name: "read_file" };

  it("命名 mcp__<server>__<tool>", () => {
    const tool = wrapMcpTool("filesystem", desc, stubClient().client);
    expect(tool.name).toBe("mcp__filesystem__read_file");
  });

  it("desc 截断到 2048；超长截断、空 desc 兜底", () => {
    const long = "x".repeat(5000);
    const t1 = wrapMcpTool("s", { name: "a", description: long }, stubClient().client);
    expect(t1.description.length).toBe(MAX_MCP_DESCRIPTION_LENGTH);

    const t2 = wrapMcpTool("s", { name: "b", description: "short" }, stubClient().client);
    expect(t2.description).toBe("short");

    const t3 = wrapMcpTool("s", { name: "c" }, stubClient().client);
    expect(t3.description).toContain("c");
  });

  it("懒 schema：z.record passthrough → JSON Schema { type: object }（零 token）", () => {
    const tool = wrapMcpTool("s", desc, stubClient().client);
    const json = zodToJsonSchema(tool.inputSchema);
    expect(json).toEqual({ type: "object", additionalProperties: {} });
  });

  it("isConcurrencySafe = readOnlyHint；只读 true / 非只读 false", () => {
    const ro = wrapMcpTool(
      "s",
      { name: "a", annotations: { readOnlyHint: true } },
      stubClient().client,
    );
    expect(ro.isConcurrencySafe).toBe(true);
    const rw = wrapMcpTool("s", { name: "b" }, stubClient().client);
    expect(rw.isConcurrencySafe).toBe(false);
  });

  it("call 把 MCP text content 拼回 result；参数透传 server", async () => {
    const { client, calls } = stubClient({ call: (a) => ({ text: `echo:${String(a.path)}` }) });
    const tool = wrapMcpTool("s", { name: "read_file" }, client);
    const r = await tool.call({ path: "/x" });
    expect(r.result).toBe("echo:/x");
    expect(calls).toEqual([{ path: "/x" }]);
  });

  it("isError → 错误文本回填（不 throw）", async () => {
    const { client } = stubClient({ text: "boom", isError: true });
    const tool = wrapMcpTool("s", { name: "x" }, client);
    const r = await tool.call({});
    expect(r.result).toContain("错误");
    expect(r.result).toContain("boom");
  });

  it("client 抛错 → 字符串回填（不 throw）", async () => {
    const client: McpClientLike = {
      async callTool() {
        throw new Error("ECONNREFUSED");
      },
    };
    const tool = wrapMcpTool("s", { name: "x" }, client);
    const r = await tool.call({});
    expect(r.result).toContain("ECONNREFUSED");
  });

  it("多段 text content 拼接；无 text 输出兜底文案", async () => {
    const client: McpClientLike = {
      async callTool() {
        return {
          content: [{ type: "text", text: "a" }, { type: "text", text: "b" }, { type: "image" }],
        };
      },
    };
    const t = wrapMcpTool("s", { name: "x" }, client);
    expect((await t.call({})).result).toBe("a\nb");

    const empty: McpClientLike = {
      async callTool() {
        return { content: [{ type: "image" }] };
      },
    };
    const t2 = wrapMcpTool("s", { name: "x" }, empty);
    expect((await t2.call({})).result).toContain("无文本输出");
  });
});
