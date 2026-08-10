import { describe, expect, it } from "vitest";
import { z } from "zod";
import type {
  LLMMessage,
  LLMClient,
  StreamEvent,
  StreamOptions,
} from "../../src/providers/types.js";
import { runQuery } from "../../src/core/query.js";
import type { Tool } from "../../src/tools.js";

/** 脚本化的 fake LLM：每次 stream() 弹出下一组事件，并记录收到的消息与 tools。 */
class FakeClient implements LLMClient {
  provider = "fake";
  calls: LLMMessage[][] = [];
  toolSpecs: StreamOptions["tools"][] = [];

  constructor(private scripted: StreamEvent[][]) {}

  async *stream(messages: LLMMessage[], opts?: StreamOptions): AsyncIterable<StreamEvent> {
    this.calls.push(messages);
    this.toolSpecs.push(opts?.tools);
    const next = this.scripted.shift();
    for (const ev of next ?? [{ type: "done", stopReason: "end_turn" }]) yield ev;
  }
}

const echoTool: Tool = {
  name: "echo",
  description: "Echo the given text back",
  inputSchema: z.object({ text: z.string() }),
  async call(input) {
    const { text } = input as { text: string };
    return { result: `echo:${text}` };
  },
};

describe("runQuery（mock LLM 的 golden 场景）", () => {
  it("单轮直接完成：收集 text 增量并返回 reply", async () => {
    const fake = new FakeClient([
      [
        { type: "text", text: "hi" },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    const r = await runQuery([{ role: "user", content: "ping" }], {
      client: fake,
      tools: [echoTool],
    });

    expect(r.reply).toBe("hi");
    expect(r.iterations).toBe(1);
    expect(r.messages).toEqual([
      { role: "user", content: "ping" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ]);
    // 传给模型的 ToolSpec 已做 JSON Schema 化
    expect(fake.toolSpecs[0]).toEqual([
      {
        name: "echo",
        description: "Echo the given text back",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
    ]);
  });

  it("工具轮→回填 tool_result→再请求→完成", async () => {
    const fake = new FakeClient([
      [
        { type: "tool_use", id: "t1", name: "echo", input: { text: "x" } },
        { type: "done", stopReason: "tool_use" },
      ],
      [
        { type: "text", text: "done" },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    const calls: string[] = [];
    const results: string[] = [];
    const r = await runQuery([{ role: "user", content: "go" }], {
      client: fake,
      tools: [echoTool],
      onToolCall: (name) => calls.push(name),
      onToolResult: (name, result) => results.push(`${name}:${result}`),
    });

    expect(r.reply).toBe("done");
    expect(r.iterations).toBe(2);

    // 第二轮请求应包含 assistant(tool_use) + tool(echo:x)
    const second = fake.calls[1]!;
    expect(second.find((m) => m.role === "tool")).toEqual({
      role: "tool",
      tool_use_id: "t1",
      content: "echo:x",
    });
    expect(second.some((m) => m.role === "assistant" && m.content !== "")).toBe(true);
    // 回调被触发
    expect(calls).toEqual(["echo"]);
    expect(results).toEqual(["echo:echo:x"]);
  });

  it("未知工具 → tool_result 回填未知工具提示", async () => {
    const fake = new FakeClient([
      [
        { type: "tool_use", id: "t9", name: "nope", input: {} },
        { type: "done", stopReason: "tool_use" },
      ],
      [
        { type: "text", text: "ok" },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    const r = await runQuery([{ role: "user", content: "go" }], {
      client: fake,
      tools: [echoTool],
    });

    const toolMsg = r.messages.find((m) => m.role === "tool");
    expect(toolMsg).toEqual({ role: "tool", tool_use_id: "t9", content: "未知工具: nope" });
  });

  it("max_tokens 截断 → 追加提示继续 → 正常完成", async () => {
    const fake = new FakeClient([
      [{ type: "done", stopReason: "max_tokens" }],
      [
        { type: "text", text: "fin" },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    const r = await runQuery([{ role: "user", content: "go" }], {
      client: fake,
      tools: [echoTool],
    });

    expect(r.reply).toBe("fin");
    expect(r.iterations).toBe(2);
    expect(
      r.messages.some(
        (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("截断"),
      ),
    ).toBe(true);
  });

  it("超过 maxIterations 兜底返回", async () => {
    const fake = new FakeClient([
      [
        { type: "tool_use", id: "t1", name: "echo", input: { text: "x" } },
        { type: "done", stopReason: "tool_use" },
      ],
    ]);
    const r = await runQuery([{ role: "user", content: "go" }], {
      client: fake,
      tools: [echoTool],
      maxIterations: 1,
    });
    expect(r.iterations).toBe(1);
  });
});
