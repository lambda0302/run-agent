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
import { isPromptTooLong } from "../utils/errors.js";
import {
  COMPACT_MIN_MESSAGES,
  computeCompactThreshold,
  hardTruncateToFit,
  maybeAutoCompact,
  normalizeToolPairing,
  spillOversizedResult,
} from "./compact.js";
import { StreamingToolExecutor } from "./execute.js";

export interface RunQueryOptions {
  client: LLMClient;
  /** V5 决策 B3：工具池可为函数（每轮重建——mcp_connect 注册新 MCP 工具后，下一轮迭代即可调用）。 */
  tools: Tool[] | (() => Tool[]);
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
  /** V3 system prompt：首条 system 消息进请求、不进返回/持久化 */
  system?: string;
  /** V3 上下文窗口（token 估算）；设了才启用自动压缩 */
  contextWindow?: number;
  /** V3 压缩发生时回调（REPL 用于提示） */
  onCompact?: () => void;
  /** 标记本请求来源（compact 摘要请求走 'compact'，跳过主动压缩防递归） */
  querySource?: string;
  /** V3 决策 8：超大工具结果落盘目录（缺省不落盘，结果原样进消息列表） */
  resultsDir?: string;
}

export interface RunQueryResult {
  /** 完整对话（含最后的 assistant 回复），供持久化/续接 */
  messages: LLMMessage[];
  /** 本轮回调期间新增的消息（与 messages 尾部一致，REPL 用它逐条持久化） */
  added: LLMMessage[];
  /** 最终回复文本（最后一轮 model 的 text 增量拼接） */
  reply: string;
  iterations: number;
  /** 本轮回调期间触发的压缩次数 */
  compacts: number;
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
  // system 只进请求，不污染持久化/返回的对话
  const messages: LLMMessage[] = initial.filter((m) => m.role !== "system");
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const envRetries = Number(process.env.RUN_AGENT_MAX_RETRIES);
  const maxRetries =
    opts.maxRetries ??
    (Number.isFinite(envRetries) && envRetries >= 0 ? Math.floor(envRetries) : DEFAULT_MAX_RETRIES);
  // V5 决策 B3：每轮解析工具池（函数 → 重建；mcp_connect 注册后下一轮即可调用）
  const getTools = (): Tool[] => (typeof opts.tools === "function" ? opts.tools() : opts.tools);
  const added: LLMMessage[] = [];
  let compacts = 0;
  let spillSeq = 0;
  let iterations = 0;
  let reply = "";

  // 统一入队：同时进 messages 与 added（REPL 用 added 逐条持久化）
  const pushConversation = (m: LLMMessage): void => {
    messages.push(m);
    added.push(m);
  };

  while (iterations < maxIterations) {
    iterations++;

    // 主动压缩：整段历史（含最新 user 请求）估算超阈值 → 摘要 → 单边界消息。
    // compact 摘要请求自身（querySource='compact'）跳过，防递归。
    if (
      opts.contextWindow &&
      opts.querySource !== "compact" &&
      messages.length >= COMPACT_MIN_MESSAGES
    ) {
      const compactResult = await maybeAutoCompact(messages, {
        client: opts.client,
        tools: getTools(),
        ...(opts.system !== undefined ? { system: opts.system } : {}),
        contextWindow: opts.contextWindow,
      });
      if (compactResult.compacted) {
        compacts++;
        messages.length = 0;
        messages.push(...compactResult.messages);
        added.push(...compactResult.messages); // 边界消息也走 added 契约，供 REPL 持久化
        opts.onCompact?.();
      }
    }

    // V5 决策 B3：工具 spec 每轮重建（MCP 工具按需连接后动态注入下一轮）
    const toolSpecs = toToolSpecs(getTools());

    // V5 决策 C：流式执行器——tool_use block 一完整就 addTool 入队执行，不必等响应完结。
    // 每次 stream 尝试新建一个：transient 重试/反应式压缩会丢弃旧尝试的已收集增量。
    let textParts: string[] = [];
    let toolUses: ToolUseBlock[] = [];
    let stopReason: StopReason = "end_turn";
    let attempt = 0;
    let executor: StreamingToolExecutor | null = null;
    // 0.3.1 反应式压缩阶段：0=未反应；1=已强制压缩；2=已硬截断（再超长则抛原错误）
    let reactiveStage = 0;
    for (;;) {
      // 工具池传函数（getTools）：每轮解析，MCP 工具同轮连接后后续 block 也能找到
      executor = new StreamingToolExecutor({
        tools: getTools,
        ...(opts.checkPermission ? { checkPermission: opts.checkPermission } : {}),
        ...(opts.onToolCall ? { onToolCall: opts.onToolCall } : {}),
        ...(opts.onToolResult ? { onToolResult: opts.onToolResult } : {}),
      });
      try {
        // system 拼到请求消息数组首条（不进 messages，适配器已会抽顶层/内联）
        const requestMessages: LLMMessage[] = opts.system
          ? [{ role: "system", content: opts.system }, ...messages]
          : messages;
        for await (const ev of opts.client.stream(requestMessages, {
          tools: toolSpecs,
          ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
        })) {
          if (ev.type === "text") {
            textParts.push(ev.text);
            opts.onText?.(ev.text);
          } else if (ev.type === "tool_use") {
            const block: ToolUseBlock = {
              type: "tool_use",
              id: ev.id,
              name: ev.name,
              input: ev.input,
            };
            toolUses.push(block);
            // 流式期间即时执行：block 完整即入队（只读并行/写串行由 executor 调度）。
            // await 只等权限校验+入队，工具本体执行是 fire-and-forget，不阻塞流继续。
            await executor.addTool(block, toolUses.length - 1);
          } else if (ev.type === "done") {
            stopReason = ev.stopReason;
          }
        }
        break;
      } catch (e) {
        // 先收尾本尝试已入队的执行：工具可能在错误前已启动，必须等其完成再重试，
        // 否则旧任务残留在后台、onToolResult 会与重试轮交叠。
        await executor.getResults();
        // 0.3.1 反应式压缩：模型报上下文超长 → 强制压缩/硬截断后重试（每轮至多一次，防死循环）
        if (isPromptTooLong(e)) {
          if (!opts.contextWindow || reactiveStage >= 2) throw e;
          if (reactiveStage === 0) {
            const c = await maybeAutoCompact(messages, {
              client: opts.client,
              tools: getTools(),
              ...(opts.system !== undefined ? { system: opts.system } : {}),
              contextWindow: opts.contextWindow,
              force: true, // 模型已经说不下了，忽略估算阈值
            });
            if (c.compacted) {
              reactiveStage = 1;
              compacts++;
              messages.length = 0;
              messages.push(...c.messages);
              added.push(...c.messages);
              opts.onCompact?.();
              attempt = 0;
              textParts = [];
              toolUses = [];
              continue;
            }
          }
          // 压缩不可行（消息过少）或压缩后仍超长 → 硬截断 + 修复 tool 配对
          reactiveStage = 2;
          const fit = hardTruncateToFit(messages, computeCompactThreshold(opts.contextWindow));
          const normalized = normalizeToolPairing(fit);
          if (JSON.stringify(normalized) === JSON.stringify(messages)) throw e; // 裁不动
          messages.length = 0;
          messages.push(...normalized);
          attempt = 0;
          textParts = [];
          toolUses = [];
          continue;
        }
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
    pushConversation({ role: "assistant", content: blocks.length ? blocks : "" });

    // V5 决策 C：流式期间工具已即时执行；流结束统一 getResults（等全部完成）并按 index 回填。
    // 非 end_turn 一律回填 tool_result：max_tokens/error 下已执行的工具结果也落地，
    // 避免孤儿 tool_use 与模型重复执行同批工具。
    const results = executor ? await executor.getResults() : [];
    for (let i = 0; i < toolUses.length; i++) {
      let content: string = results[i] ?? "";
      // 决策 8：超大结果落盘换指针（需 resultsDir；缺省原样进消息列表）
      if (opts.resultsDir) {
        content = await spillOversizedResult(content, spillSeq++, opts.resultsDir);
      }
      pushConversation({ role: "tool", tool_use_id: toolUses[i]!.id, content });
    }

    if (stopReason === "end_turn") {
      // end_turn 下模型未请求工具（toolUses 应为空）；即便异常非空也保持原语义返回
      return { messages, reply, iterations, added, compacts };
    }

    if (stopReason === "tool_use") {
      continue;
    }

    if (stopReason === "max_tokens") {
      // V1 无 compact：截断时追加提示继续，让模型把话说完（已执行的工具结果已回填）
      pushConversation({ role: "user", content: "[输出被截断，请继续完成当前任务]" });
      continue;
    }

    // stopReason === "error"
    pushConversation({ role: "user", content: "[模型返回错误，请重试]" });
  }

  return { messages, reply, iterations, added, compacts };
}
