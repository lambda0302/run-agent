import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMMessage, StreamEvent } from "../../src/providers/types.js";

// mock `openai` 包：默认导出是 OpenAI 类，chat.completions.create 返回流式 chunk
const { create, ctor } = vi.hoisted(() => ({
  create: vi.fn(),
  ctor: vi.fn(),
}));

vi.mock("openai", () => ({
  default: class {
    constructor(opts: unknown) {
      ctor(opts);
    }
    chat = { completions: { create } };
  },
}));

import { createOpenAICompatibleClient, createOpenAIClient } from "../../src/providers/openai.js";

function chunk(delta: Record<string, unknown>, finishReason: string | null = null) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 0,
    model: "gpt-4o-mini",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function streamOf<T>(chunks: T[]): AsyncIterable<T> {
  return (async function* () {
    for (const c of chunks) yield c;
  })();
}

async function collect(client: ReturnType<typeof createOpenAIClient>, msgs: LLMMessage[]) {
  const events: StreamEvent[] = [];
  for await (const ev of client.stream(msgs)) events.push(ev);
  return events;
}

describe("createOpenAIClient（function calling 互转）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("把文本流翻译成 text 事件并以 end_turn 结束", async () => {
    create.mockResolvedValueOnce(
      streamOf([
        chunk({ role: "assistant", content: "你" }),
        chunk({ content: "好" }),
        chunk({}, "stop"),
      ]),
    );

    const client = createOpenAIClient({ apiKey: "test-key" });
    const events = await collect(client, [{ role: "user", content: "hi" }]);

    expect(events).toEqual([
      { type: "text", text: "你" },
      { type: "text", text: "好" },
      { type: "done", stopReason: "end_turn" },
    ]);
  });

  it("聚合分片的 tool_calls 并触发 tool_use 事件", async () => {
    create.mockResolvedValueOnce(
      streamOf([
        chunk({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: '{"file_' },
            },
          ],
        }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: 'path":"a.txt"}' } }] }),
        chunk({}, "tool_calls"),
      ]),
    );

    const client = createOpenAIClient({ apiKey: "test-key" });
    const events = await collect(client, [{ role: "user", content: "hi" }]);

    expect(events[0]).toEqual({
      type: "tool_use",
      id: "call_1",
      name: "read_file",
      input: { file_path: "a.txt" },
    });
    expect(events[1]).toEqual({ type: "done", stopReason: "tool_use" });
  });

  it("把内部消息正确转成 OpenAI chat messages（system/assistant tool_calls/tool role）", async () => {
    create.mockResolvedValueOnce(streamOf([chunk({}, "stop")]));

    const client = createOpenAIClient({ apiKey: "test-key" });
    const msgs: LLMMessage[] = [
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "read_file", input: { p: 1 } }],
      },
      { role: "tool", tool_use_id: "t1", content: "ok" },
    ];
    await collect(client, msgs);

    const sent = create.mock.calls[0]![0];
    expect(sent.messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "t1", type: "function", function: { name: "read_file", arguments: '{"p":1}' } },
        ],
      },
      { role: "tool", tool_call_id: "t1", content: "ok" },
    ]);
  });

  it("openai-compatible 工厂把 baseURL 传给 SDK", async () => {
    create.mockResolvedValueOnce(streamOf([chunk({}, "stop")]));
    const client = createOpenAICompatibleClient({
      apiKey: "k",
      baseURL: "https://api.deepseek.com/v1",
    });
    expect(client.provider).toBe("openai-compatible");
    await collect(client, [{ role: "user", content: "hi" }]);
    expect(ctor).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: "https://api.deepseek.com/v1", apiKey: "k" }),
    );
  });
});
