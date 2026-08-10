import Anthropic from "@anthropic-ai/sdk";
import type { CreateClientOptions, LLMClient } from "./types.js";

const DEFAULT_MODEL = "claude-sonnet-5"; // 按当时最新主力模型调整

export function createAnthropicClient(options: CreateClientOptions = {}): LLMClient {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const client = new Anthropic({ ...(apiKey ? { apiKey } : {}) });
  const model = options.model ?? DEFAULT_MODEL;

  return {
    provider: "anthropic",
    async chat(messages) {
      const system = messages.find((m) => m.role === "system")?.content;
      const res = await client.messages.create({
        model,
        max_tokens: 1024,
        messages: messages
          .filter((m) => m.role !== "system")
          .map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
        ...(system ? { system } : {}),
      });

      return res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    },
  };
}
