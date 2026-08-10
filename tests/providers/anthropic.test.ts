import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMMessage, StreamEvent } from "../../src/providers/types.js";

// vi.mock 会被提升到文件顶部，因此 mock 工厂需要的数据必须用 vi.hoisted 定义。
// createMock 必须返回同一个实例（单例）：源码里是 `new Anthropic(...)`。
const { mockClient } = vi.hoisted(() => {
  const mockClient = {
    messages: {
      create: vi.fn(),
    },
  };
  return { mockClient };
});

vi.mock("@anthropic-ai/sdk", () => ({
  // 普通函数（非箭头）才能被 `new Anthropic()` 构造
  default: vi.fn(function () {
    return mockClient;
  }),
}));

import { createAnthropicClient } from "../../src/providers/anthropic.js";

/** 构造 Anthropic 流式事件序列（覆盖 V1 用到的分支）。 */
function streamOf<T>(events: T[]): AsyncIterable<T> {
  return (async function* () {
    for (const e of events) yield e;
  })();
}

describe("createAnthropicClient（流式）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("把 text_delta 转成 text 事件，end_turn 结束", async () => {
    mockClient.messages.create.mockResolvedValue(
      streamOf([
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "pong" } },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: {},
        },
      ]),
    );

    const client = createAnthropicClient({ apiKey: "test-key" });
    const events: StreamEvent[] = [];
    for await (const ev of client.stream([{ role: "user", content: "ping" }])) events.push(ev);

    expect(events).toEqual([
      { type: "text", text: "pong" },
      { type: "done", stopReason: "end_turn" },
    ]);
  });

  it("聚合 tool_use 的 partial_json，且 system/tools 放到顶层参数", async () => {
    mockClient.messages.create.mockResolvedValue(
      streamOf([
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tu1", name: "read_file", input: {} },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"file_' },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: 'path":"a.txt"}' },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: {},
        },
      ]),
    );

    const client = createAnthropicClient({ apiKey: "test-key" });
    const events: StreamEvent[] = [];
    for await (const ev of client.stream(
      [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
      ],
      { tools: [{ name: "read_file", description: "d", inputSchema: {} }] },
    ))
      events.push(ev);

    expect(events[0]).toEqual({
      type: "tool_use",
      id: "tu1",
      name: "read_file",
      input: { file_path: "a.txt" },
    });
    expect(events[1]).toEqual({ type: "done", stopReason: "tool_use" });

    const args = mockClient.messages.create.mock.calls[0]![0];
    expect(args.system).toBe("be brief");
    expect(args.tools).toEqual([{ name: "read_file", description: "d", input_schema: {} }]);
    expect(args.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("把 tool 结果合并进 user 消息的 tool_result 块（连续合并）", async () => {
    mockClient.messages.create.mockResolvedValue(
      streamOf([
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: {},
        },
      ]),
    );

    const client = createAnthropicClient({ apiKey: "test-key" });
    const msgs: LLMMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu1", name: "read_file", input: { p: 1 } }],
      },
      { role: "tool", tool_use_id: "tu1", content: "file content" },
      { role: "tool", tool_use_id: "tu2", content: "more" },
    ];
    for await (const _ of client.stream(msgs)) void _;

    const args = mockClient.messages.create.mock.calls[0]![0];
    expect(args.messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", id: "tu1", name: "read_file", input: { p: 1 } }],
    });
    expect(args.messages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu1", content: "file content" },
        { type: "tool_result", tool_use_id: "tu2", content: "more" },
      ],
    });
  });
});
