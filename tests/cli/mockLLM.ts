/**
 * M4 测试辅助：OpenAI-compatible 流式 mock LLM HTTP server（hermetic，无真实网络）。
 * 子进程（dist/cli.js）经 --base-url 指向这里；每次 /chat/completions 请求交给 respond 回调
 * 决定返回的 chunk 序列，同时记录收到的请求体供断言（如「第二轮含 tool 结果」）。
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type OpenAIChatBody = {
  model?: string;
  messages: Array<{
    role: string;
    content?: string | null;
    tool_calls?: unknown[];
    tool_call_id?: string;
  }>;
  tools?: unknown[];
};

export interface MockLLMHandle {
  /** 传给 --base-url 的地址（含 /v1）。 */
  url: string;
  /** 收到的全部请求体（含 messages/tools），供断言模型收到了什么。 */
  requests: OpenAIChatBody[];
  close(): Promise<void>;
}

export interface Chunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: Record<string, unknown>;
    finish_reason: string | null;
  }>;
}

/** 工具调用 chunk 序列：先发 tool_calls 增量，再发 finish_reason=tool_calls。 */
export function toolCallChunks(toolCall: {
  id: string;
  name: string;
  args: string; // JSON 字符串
}): Chunk[] {
  return [
    {
      id: "chatcmpl-mock",
      object: "chat.completion.chunk",
      created: 0,
      model: "mock",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: toolCall.id,
                type: "function",
                function: { name: toolCall.name, arguments: toolCall.args },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chatcmpl-mock",
      object: "chat.completion.chunk",
      created: 0,
      model: "mock",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    },
  ];
}

/** 纯文本回复 chunk 序列（finish_reason=stop）。 */
export function textChunks(text: string): Chunk[] {
  return [
    {
      id: "chatcmpl-mock",
      object: "chat.completion.chunk",
      created: 0,
      model: "mock",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    },
    {
      id: "chatcmpl-mock",
      object: "chat.completion.chunk",
      created: 0,
      model: "mock",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
  ];
}

/** 起一个流式 mock server；respond 每次请求被调用，返回要发的 chunk 序列。 */
export function startMockLLM(respond: (body: OpenAIChatBody) => Chunk[]): Promise<MockLLMHandle> {
  const requests: OpenAIChatBody[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c));
    req.on("end", () => {
      try {
        const body = JSON.parse(raw) as OpenAIChatBody;
        requests.push(body);
        const chunks = respond(body);
        res.statusCode = 200;
        res.setHeader("content-type", "text/event-stream");
        for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      } catch (e) {
        res.statusCode = 500;
        res.end(String(e));
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}/v1`,
        requests,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

/** 请求体是否已含 tool 结果（role=tool）——用于区分第几轮。 */
export function hasToolResult(body: OpenAIChatBody): boolean {
  return body.messages.some((m) => m.role === "tool");
}
