import { createOpenAILikeClient } from "./openai.js";
import type { CreateClientOptions, LLMClient } from "./types.js";

const DEFAULT_OLLAMA_URL = "http://localhost:11434/v1";

/** Ollama 提供 OpenAI 兼容端点，直接复用 openai 实现。 */
export function createOllamaClient(options: CreateClientOptions = {}): LLMClient {
  return createOpenAILikeClient(
    {
      ...options,
      baseURL: options.baseURL ?? DEFAULT_OLLAMA_URL,
      apiKey: options.apiKey ?? "ollama", // 本地服务无需鉴权，SDK 要求非空
    },
    "ollama",
  );
}
