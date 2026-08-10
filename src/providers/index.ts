import type { CreateClientOptions, LLMClient, ProviderName } from "./types.js";
import { createAnthropicClient } from "./anthropic.js";
import { createOpenAIClient, createOpenAICompatibleClient } from "./openai.js";
import { createOllamaClient } from "./ollama.js";

export function createClient(provider: ProviderName, options: CreateClientOptions = {}): LLMClient {
  switch (provider) {
    case "anthropic":
      return createAnthropicClient(options);
    case "openai":
      return createOpenAIClient(options);
    case "openai-compatible":
      if (!options.baseURL) {
        throw new Error(
          "provider 为 openai-compatible 时必须提供 baseURL（如 https://api.deepseek.com/v1）",
        );
      }
      return createOpenAICompatibleClient(options);
    case "ollama":
      return createOllamaClient(options);
  }
}
