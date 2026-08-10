import type {
  ContentBlock,
  LLMMessage,
  LLMClient,
  StopReason,
  ToolUseBlock,
} from "../providers/types.js";
import { toToolSpecs } from "../tools.js";
import type { Tool } from "../tools.js";
import type { Decision } from "../permissions/types.js";
import { executeToolCalls } from "./execute.js";

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
  /** V2 权限回调：返回 allow/deny（ask 已由上层 resolve）；缺省 = 不设权限限制 */
  checkPermission?: (tool: Tool, input: unknown) => Promise<Decision>;
  /** 流式请求的 transient 错误重试次数，默认 2（可用 RUN_AGENT_MAX_RETRIES 覆盖） */
  maxRetries?: number;
}

export interface RunQueryResult {
  /** 完整对话（含最后的 assistant 回复），供持久化/续接 */
  messages: LLMMessage[];
  /** 最终回复文本（最后一轮 model 的 text 增量拼接） */
  reply: string;
  iterations: number;
}

const DEFAULT_MAX_ITERATIONS = 25;
const DEFAULT_MAX_RETRIES = 2;

function isTransientError(e: unknown): boolean {
  if (!(e instanceof Error)) return true;
  const status = (e as { status?: unknown }).status;
  if (typeof status === "number") return status === 429 || status >= 500;
  if (typeof status === "string") {
    const n = Number(status);
    if (Number.isFinite(n)) return n === 429 || n >= 500;
  }
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|network/i.test(e.message);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * ReAct loop：stream → 收集 text/tool_use → 按 stopReason 分流：
 *   end_turn 结束；tool_use 执行工具（只读并行/写串行 + 权限校验）回填后继续；
 *   max_tokens 追加提示续跑；error/transient 错误重试或简单恢复。
 */
export async function runQuery(
  initial: LLMMessage[],
  opts: RunQueryOptions,
): Promise<RunQueryResult> {
  const messages: LLMMessage[] = [...initial];
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const envRetries = Number(process.env.RUN_AGENT_MAX_RETRIES);
  const maxRetries =
    opts.maxRetries ??
    (Number.isFinite(envRetries) && envRetries >= 0 ? Math.floor(envRetries) : DEFAULT_MAX_RETRIES);
  let iterations = 0;
  let reply = "";

  while (iterations < maxIterations) {
    iterations++;

    // 流式请求：transient 错误（429/5xx/网络）指数退避重试；重试会丢弃已收集的增量重来一整轮
    let textParts: string[] = [];
    let toolUses: ToolUseBlock[] = [];
    let stopReason: StopReason = "end_turn";
    let attempt = 0;
    for (;;) {
      try {
        for await (const ev of opts.client.stream(messages, {
          tools: toToolSpecs(opts.tools),
          ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
        })) {
          if (ev.type === "text") {
            textParts.push(ev.text);
            opts.onText?.(ev.text);
          } else if (ev.type === "tool_use") {
            toolUses.push({ type: "tool_use", id: ev.id, name: ev.name, input: ev.input });
          } else if (ev.type === "done") {
            stopReason = ev.stopReason;
          }
        }
        break;
      } catch (e) {
        if (attempt >= maxRetries || !isTransientError(e)) throw e;
        attempt++;
        textParts = [];
        toolUses = [];
        await sleep(500 * 2 ** attempt); // 1s, 2s, …
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
      const results = await executeToolCalls(toolUses, {
        tools: opts.tools,
        ...(opts.checkPermission ? { checkPermission: opts.checkPermission } : {}),
        ...(opts.onToolCall ? { onToolCall: opts.onToolCall } : {}),
        ...(opts.onToolResult ? { onToolResult: opts.onToolResult } : {}),
      });
      for (let i = 0; i < toolUses.length; i++) {
        messages.push({ role: "tool", tool_use_id: toolUses[i]!.id, content: results[i]! });
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
