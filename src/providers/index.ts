import type { CreateClientOptions, LLMClient, ProviderName } from "./types.js";
import { createAnthropicClient, DEFAULT_MODEL as ANTHROPIC_DEFAULT } from "./anthropic.js";
import {
  createOpenAIClient,
  createOpenAICompatibleClient,
  DEFAULT_MODEL as OPENAI_DEFAULT,
} from "./openai.js";
import { createOllamaClient } from "./ollama.js";

/** V6 决策 D：headless JSON 里报告实际生效的 model（未显式指定时用适配器默认）。 */
export function resolveModelName(provider: ProviderName, model?: string): string {
  switch (provider) {
    case "anthropic":
      return model ?? ANTHROPIC_DEFAULT;
    case "openai":
      return model ?? OPENAI_DEFAULT;
    case "openai-compatible":
      // 适配器内部同样默认 gpt-4o-mini（未显式指定时），JSON 报告与实跑一致
      return model ?? OPENAI_DEFAULT;
    case "ollama":
      return model ?? "";
  }
}

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
