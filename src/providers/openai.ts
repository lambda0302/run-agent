import OpenAI from "openai";
import type {
  CreateClientOptions,
  LLMClient,
  LLMMessage,
  ProviderName,
  StopReason,
  StreamEvent,
  StreamOptions,
  ToolUseBlock,
} from "./types.js";

const DEFAULT_MODEL = "gpt-4o-mini";

type OpenAIChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string | null;
        type?: string | null;
        function?: { name?: string | null; arguments?: string | null };
      } | null>;
    };
    finish_reason?: string | null;
  }>;
};

/** 内部消息 → OpenAI chat messages。assistant 的 tool_use 转成 tool_calls，tool 角色转成 tool role。 */
function toOpenAIMessages(messages: LLMMessage[]): OpenAI.Chat.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      out.push({ role: "system", content: m.content });
    } else if (m.role === "user") {
      const text =
        typeof m.content === "string"
          ? m.content
          : m.content
              .filter((b) => b.type === "text")
              .map((b) => (b as { text: string }).text)
              .join("");
      out.push({ role: "user", content: text });
    } else if (m.role === "assistant") {
      const text =
        typeof m.content === "string"
          ? m.content
          : m.content
              .filter((b) => b.type === "text")
              .map((b) => (b as { text: string }).text)
              .join("");
      const toolUses = (Array.isArray(m.content) ? m.content : []).filter(
        (b): b is ToolUseBlock => b.type === "tool_use",
      );
      const msg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
        role: "assistant",
        content: text || null,
      };
      if (toolUses.length > 0) {
        msg.tool_calls = toolUses.map((t) => ({
          id: t.id,
          type: "function",
          function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) },
        }));
      }
      out.push(msg);
    } else {
      out.push({ role: "tool", tool_call_id: m.tool_use_id, content: m.content });
    }
  }
  return out;
}

function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    default:
      return "end_turn";
  }
}

/** 共享实现：openai / openai-compatible 只是 baseURL 与 provider 名不同。 */
export function createOpenAILikeClient(
  options: CreateClientOptions = {},
  provider: ProviderName,
): LLMClient {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  const client = new OpenAI({
    ...(apiKey ? { apiKey } : {}),
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
  });
  const model = options.model ?? DEFAULT_MODEL;

  async function* stream(messages: LLMMessage[], opts?: StreamOptions): AsyncIterable<StreamEvent> {
    const openaiTools = opts?.tools?.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));

    const res = await client.chat.completions.create({
      model,
      messages: toOpenAIMessages(messages),
      ...(openaiTools && openaiTools.length ? { tools: openaiTools } : {}),
      stream: true,
      ...(opts?.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
    });

    // OpenAI 流式把 tool_calls 按 index 分片传（name/arguments 跨 chunk 增量）
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let finishReason: string | null = null;

    for await (const chunk of res as AsyncIterable<OpenAIChunk>) {
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (delta.content) {
        yield { type: "text", text: delta.content };
      }
      for (const tc of delta.tool_calls ?? []) {
        if (!tc) continue;
        const idx = tc.index ?? 0;
        let c = calls.get(idx);
        if (!c) {
          c = { id: "", name: "", args: "" };
          calls.set(idx, c);
        }
        if (tc.id) c.id += tc.id;
        if (tc.function?.name) c.name += tc.function.name;
        if (tc.function?.arguments) c.args += tc.function.arguments;
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    for (const c of calls.values()) {
      let input: unknown;
      try {
        input = c.args ? JSON.parse(c.args) : {};
      } catch {
        input = { _raw: c.args };
      }
      yield { type: "tool_use", id: c.id, name: c.name, input };
    }

    yield { type: "done", stopReason: mapStopReason(finishReason) };
  }

  return { provider, stream };
}

export function createOpenAIClient(options: CreateClientOptions = {}): LLMClient {
  return createOpenAILikeClient(options, "openai");
}

/** OpenAI 兼容端点：一个 baseURL 覆盖 DeepSeek / Qwen / vLLM / 本地推理等。 */
export function createOpenAICompatibleClient(options: CreateClientOptions = {}): LLMClient {
  return createOpenAILikeClient(options, "openai-compatible");
}
