import type {
  ContentBlock,
  LLMMessage,
  LLMClient,
  StopReason,
  ToolUseBlock,
} from "../providers/types.js";
import { toToolSpecs } from "../tools.js";
import type { Tool } from "../tools.js";

export interface RunQueryOptions {
  client: LLMClient;
  tools: Tool[];
  maxTokens?: number;
  /** 防止死循环的轮数上限（V1 无 compact，靠它兜底） */
  maxIterations?: number;
  /** 增量文本回调（CLI 用于逐 token 渲染） */
  onText?: (text: string) => void;
  /** 工具即将执行时回调 */
  onToolCall?: (name: string, input: unknown) => void;
  /** 工具执行完成后回调 */
  onToolResult?: (name: string, result: string) => void;
}

export interface RunQueryResult {
  /** 完整对话（含最后的 assistant 回复），供持久化/续接 */
  messages: LLMMessage[];
  /** 最终回复文本（最后一轮 model 的 text 增量拼接） */
  reply: string;
  iterations: number;
}

const DEFAULT_MAX_ITERATIONS = 25;

/**
 * V1 极简 ReAct loop：
 * stream → 收集 text/tool_use → 按 stopReason 分流：
 *   end_turn 结束；tool_use 执行工具回填 tool_result 后继续；max_tokens/error 简单恢复。
 */
export async function runQuery(
  initial: LLMMessage[],
  opts: RunQueryOptions,
): Promise<RunQueryResult> {
  const messages: LLMMessage[] = [...initial];
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  let iterations = 0;
  let reply = "";

  while (iterations < maxIterations) {
    iterations++;

    const stream = opts.client.stream(messages, {
      tools: toToolSpecs(opts.tools),
      ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    });

    const textParts: string[] = [];
    const toolUses: ToolUseBlock[] = [];
    let stopReason: StopReason = "end_turn";

    for await (const ev of stream) {
      if (ev.type === "text") {
        textParts.push(ev.text);
        opts.onText?.(ev.text);
      } else if (ev.type === "tool_use") {
        toolUses.push({ type: "tool_use", id: ev.id, name: ev.name, input: ev.input });
      } else if (ev.type === "done") {
        stopReason = ev.stopReason;
      }
    }

    reply = textParts.join("");

    // 组织 assistant 消息：文本 + tool_use 块（保证 Anthropic 格式里 tool_result 跟在 tool_use 之后）
    const blocks: ContentBlock[] = [];
    if (reply) blocks.push({ type: "text", text: reply });
    for (const t of toolUses) blocks.push(t);
    messages.push({ role: "assistant", content: blocks.length ? blocks : "" });

    if (stopReason === "end_turn") {
      return { messages, reply, iterations };
    }

    if (stopReason === "tool_use") {
      for (const tu of toolUses) {
        const tool = opts.tools.find((t) => t.name === tu.name);
        if (!tool) {
          messages.push({ role: "tool", tool_use_id: tu.id, content: `未知工具: ${tu.name}` });
          continue;
        }
        opts.onToolCall?.(tu.name, tu.input);
        const parsed = tool.inputSchema.safeParse(tu.input);
        let content: string;
        if (!parsed.success) {
          content = `参数校验失败: ${parsed.error.message}`;
        } else {
          try {
            const r = await tool.call(parsed.data);
            content = r.result;
            opts.onToolResult?.(tu.name, r.result);
          } catch (e) {
            content = `工具执行错误: ${e instanceof Error ? e.message : String(e)}`;
          }
        }
        messages.push({ role: "tool", tool_use_id: tu.id, content });
      }
      continue;
    }

    if (stopReason === "max_tokens") {
      // V1 无 compact：截断时追加提示继续，让模型把话说完
      messages.push({ role: "user", content: "[输出被截断，请继续完成当前任务]" });
      continue;
    }

    // stopReason === "error"
    messages.push({ role: "user", content: "[模型返回错误，请重试]" });
  }

  return { messages, reply, iterations };
}
