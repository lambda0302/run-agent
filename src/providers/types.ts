/**
 * 统一的多提供商 LLM 抽象。
 *
 * 内部消息格式对齐 Anthropic 的 tool_use / tool_result block；OpenAI 的
 * tool_calls / tool role 在适配器层互转，agent loop 层只见内部格式。
 * V1：流式 + 工具调用。
 */

/** 文本块 */
export interface TextBlock {
  type: "text";
  text: string;
}

/** 模型请求调用某个工具（对齐 Anthropic tool_use block） */
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export type ContentBlock = TextBlock | ToolUseBlock;

/**
 * 统一内部消息。
 * - tool 角色是对一次工具调用的结果回填（OpenAI 的 tool role 对应物）。
 * - user / assistant 的 content 可以是纯文本或多段块（含 tool_use）。
 */
export type LLMMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentBlock[] }
  | { role: "assistant"; content: string | ContentBlock[] }
  | { role: "tool"; tool_use_id: string; content: string };

/** 结束原因：本轮结束 / 请求工具 / 触顶 / 出错 */
export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "error";

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "done"; stopReason: StopReason };

/** 暴露给模型的工具定义（输入用 JSON Schema 描述） */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface StreamOptions {
  tools?: ToolSpec[];
  maxTokens?: number;
}

export interface LLMClient {
  readonly provider: string;
  /** 流式对话：text 增量与 tool_use 事件按到达顺序发射，最后必有 done。 */
  stream(messages: LLMMessage[], opts?: StreamOptions): AsyncIterable<StreamEvent>;
}

export interface CreateClientOptions {
  /** 显式传入；缺省时各适配器回退到对应环境变量（如 ANTHROPIC_API_KEY）。 */
  apiKey?: string;
  /** 模型名；缺省时各适配器用默认模型。 */
  model?: string;
  /** 覆盖 API 端点（openai-compatible / ollama 必须）。 */
  baseURL?: string;
}

export type ProviderName = "anthropic" | "openai" | "openai-compatible" | "ollama";
