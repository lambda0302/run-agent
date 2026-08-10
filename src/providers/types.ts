/**
 * 统一的多提供商 LLM 客户端抽象。
 * V0 只有最简 chat；V1 将在此接口上扩展：流式、工具调用(tool_use)、
 * 内部统一消息格式（对齐 Anthropic 的 tool_use/tool_result 与 OpenAI 的 tool_calls）。
 */
export interface LLMMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface LLMClient {
  readonly provider: string;
  /** 非流式单轮对话，V1 升级为流式。 */
  chat(messages: LLMMessage[]): Promise<string>;
}

export interface CreateClientOptions {
  /** 显式传入；缺省时各适配器回退到对应环境变量（如 ANTHROPIC_API_KEY）。 */
  apiKey?: string;
  /** 模型名；缺省时各适配器用默认模型。 */
  model?: string;
}

export type ProviderName = "anthropic";
// V1 扩展：ProviderName = "anthropic" | "openai" | "ollama" | "openai-compatible";
