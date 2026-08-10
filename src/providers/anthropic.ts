import Anthropic from "@anthropic-ai/sdk";
import type {
  CreateClientOptions,
  LLMClient,
  LLMMessage,
  StopReason,
  StreamEvent,
  StreamOptions,
} from "./types.js";

const DEFAULT_MODEL = "claude-sonnet-5"; // 按当时最新主力模型调整

/**
 * 把内部统一消息转成 Anthropic 的 messages 数组。
 * 规则：
 * - system 抽到顶层 system 参数（这里跳过，由调用方处理）；
 * - tool 角色合并进 user 消息的 tool_result 块（Anthropic 要求 tool_result 放在 user turn）；
 * - assistant 的 tool_use 块原样透传。
 */
function toAnthropicMessages(messages: LLMMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      const block: Anthropic.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: m.tool_use_id,
        content: m.content,
      };
      const last = out[out.length - 1];
      // 连续 tool 结果合并进同一条 user 消息
      if (
        last &&
        last.role === "user" &&
        Array.isArray(last.content) &&
        last.content.length > 0 &&
        last.content[0]?.type === "tool_result"
      ) {
        last.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
    } else {
      const blocks: Anthropic.ContentBlockParam[] = m.content.map((b) =>
        b.type === "text"
          ? { type: "text", text: b.text }
          : { type: "tool_use", id: b.id, name: b.name, input: b.input },
      );
      out.push({ role: m.role, content: blocks });
    }
  }
  return out;
}

function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    default:
      return "end_turn";
  }
}

export function createAnthropicClient(options: CreateClientOptions = {}): LLMClient {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const client = new Anthropic({ ...(apiKey ? { apiKey } : {}) });
  const model = options.model ?? DEFAULT_MODEL;

  async function* stream(messages: LLMMessage[], opts?: StreamOptions): AsyncIterable<StreamEvent> {
    const system = messages.find((m) => m.role === "system")?.content;
    const anthropicTools = opts?.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      // ToolSpec 的 JSON Schema 由 zod 生成，保证是 object 类型；跨 SDK 边界做一次窄化
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }));

    const res = await client.messages.create({
      model,
      max_tokens: opts?.maxTokens ?? 8192,
      messages: toAnthropicMessages(messages),
      ...(system ? { system } : {}),
      ...(anthropicTools && anthropicTools.length ? { tools: anthropicTools } : {}),
      stream: true,
    });

    // 跨事件聚合 tool_use 的 input（partial_json 增量到达）
    const toolBuffers = new Map<number, { id: string; name: string; json: string }>();

    for await (const event of res) {
      switch (event.type) {
        case "content_block_start": {
          const block = event.content_block;
          if (block.type === "tool_use") {
            toolBuffers.set(event.index, { id: block.id, name: block.name, json: "" });
          }
          break;
        }
        case "content_block_delta": {
          const d = event.delta;
          if (d.type === "text_delta") {
            yield { type: "text", text: d.text };
          } else if (d.type === "input_json_delta") {
            const buf = toolBuffers.get(event.index);
            if (buf) buf.json += d.partial_json;
          }
          break;
        }
        case "content_block_stop": {
          const buf = toolBuffers.get(event.index);
          if (buf) {
            toolBuffers.delete(event.index);
            let input: unknown;
            try {
              input = buf.json ? JSON.parse(buf.json) : {};
            } catch {
              input = { _raw: buf.json };
            }
            yield { type: "tool_use", id: buf.id, name: buf.name, input };
          }
          break;
        }
        case "message_delta":
          yield { type: "done", stopReason: mapStopReason(event.delta.stop_reason) };
          break;
        default:
          break;
      }
    }
  }

  return { provider: "anthropic", stream };
}
