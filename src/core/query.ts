import type {
  ContentBlock,
  LLMMessage,
  LLMClient,
  StopReason,
  ToolUseBlock,
} from "../providers/types.js";
import { toToolSpecs } from "../tools.js";
import type { Tool } from "../tools.js";
import { isAbortError, isPromptTooLong } from "../utils/errors.js";
import {
  COMPACT_MIN_MESSAGES,
  computeCompactThreshold,
  hardTruncateToFit,
  maybeAutoCompact,
  normalizeToolPairing,
  spillOversizedResult,
} from "./compact.js";
import type { PermissionCheckResult, ToolTrace } from "./execute.js";
import { StreamingToolExecutor } from "./execute.js";

/** V6 决策 D：headless JSON 工具轨迹的 result 截断上限（全量在会话 JSONL）。 */
export const TOOL_TRACE_RESULT_LIMIT = 2000;

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
  /** V6 决策 A1：PostToolUse hook——工具执行完成（成功/失败）后触发，带入参与结果。 */
  onPostToolUse?: (name: string, input: unknown, result: string) => void;
  /** V2 权限回调：返回 allow/deny（ask 已由上层 resolve）；缺省 = 不设权限限制 */
  checkPermission?: (tool: Tool, input: unknown) => Promise<PermissionCheckResult>;
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
  /** V7 决策 C2：外部消息注入——每轮迭代开始时调用（SendMessage 送达；子查询 pending 队列取消息）。 */
  pollExternal?: () => LLMMessage[] | undefined;
  /** V7 决策 C3：外部 abort（TaskStop）——aborted 后提前结束，reply 保留部分结果。 */
  signal?: AbortSignal;
  /** V7 决策 A7：后台任务轮末自动收集——end_turn 返回前调用，有结果注入新 user 轮让模型收尾。 */
  onBackgroundDone?: () => Promise<string[]>;
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
  /** V6 决策 D：本轮全部工具调用轨迹（名 + 入参 + 结果[截断 2000] + 权限），headless JSON 用。 */
  toolCalls: ToolTrace[];
  /** V7 决策 C3：是否因外部 abort（TaskStop）提前结束；aborted 时 reply 是部分结果。 */
  aborted?: boolean;
}

const DEFAULT_MAX_ITERATIONS = 25;
const DEFAULT_MAX_RETRIES = 2;
// V7 空结论兜底：flash 模型（deepseek-v4 等）偶发返回完全空的完成（end_turn、无文本、无工具
// 调用）。直接接受会产出空「[explore 结论]」。有界重试 + 短退避，不影响正常完成路径。
const MAX_EMPTY_RETRIES = 2;
const EMPTY_RETRY_DELAY_MS = 400;

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
 * L1 预算提示：把迭代轮数上限告诉模型（Claude Code 式「模型知情」）——模型据此主动规划
 * 收尾，而不是被看不见的轮数墙硬切（子 agent 空结论/半截结论根因）。预算耗尽时收尾轮会
 * 停用工具并强制纯文本结论，这里提前告知，让模型自己提前收尾（质量更高）。
 */
function withBudgetHint(system: string, maxIterations: number): string {
  return `${system}\n\n## 迭代预算（重要）\n本次任务你最多还有约 ${maxIterations} 轮工具调用循环（每轮可调用多个工具，含当前轮）。请按任务复杂度主动规划：证据足够或结论可得出时就及时收尾并给出回答，不要把轮数全花在取证/验证上。若你到轮数上限仍在调用工具，系统会停止放行工具并强制你以纯文本给出最终结论——在那之前自行收尾通常质量更高。`;
}

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
  // L1 预算提示：把轮数上限注入 system（模型知情 → 主动规划收尾）。compact 摘要等子请求
  // 仍用原始 opts.system（短任务不需要预算提示）。
  const system = opts.system ? withBudgetHint(opts.system, maxIterations) : undefined;
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
  let emptyRetries = 0;
  // V7 收尾轮标志：预算耗尽/空重试耗尽后置位，下一轮清空工具、明示模型给最终结论，
  // 保证 reply 是真正结论而非末轮工具调用前的片段（子 agent 空结论/半截结论根因）。
  let finalizing = false;
  // V6 决策 D：跨全部迭代的工具轨迹（headless JSON 审计用）
  const toolCalls: ToolTrace[] = [];

  // 统一入队：同时进 messages 与 added（REPL 用 added 逐条持久化）
  const pushConversation = (m: LLMMessage): void => {
    messages.push(m);
    added.push(m);
  };

  while (iterations < maxIterations || finalizing) {
    iterations++;

    // V7 决策 C2：外部消息注入（SendMessage 送达）——迭代边界取 pending，非空注入为新的
    // user 轮并 continue（消息进 added/子 transcript）。放压缩检查前：注入一并参与压缩决策。
    if (opts.pollExternal) {
      const ext = opts.pollExternal();
      if (ext && ext.length > 0) {
        for (const m of ext) pushConversation(m);
        continue;
      }
    }
    // V7 决策 C3：外部 abort（TaskStop）——提前结束，保留已产出部分文本（不抛，避免上层当失败）
    if (opts.signal?.aborted) {
      return { messages, reply, iterations, added, compacts, toolCalls, aborted: true };
    }

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

    // V5 决策 B3：工具 spec 每轮重建（MCP 工具按需连接后动态注入下一轮）。
    // 收尾轮（finalizing）不给任何工具——强制模型以纯文本给出最终结论。
    const toolSpecs = toToolSpecs(finalizing ? [] : getTools());

    // V5 决策 C：流式执行器——tool_use block 一完整就 addTool 入队执行，不必等响应完结。
    // 每次 stream 尝试新建一个：transient 重试/反应式压缩会丢弃旧尝试的已收集增量。
    let textParts: string[] = [];
    let toolUses: ToolUseBlock[] = [];
    // V6 决策 D：本尝试的工具轨迹（与 textParts/toolUses 同生命周期——transient 重试丢弃旧尝试）；
    // 尝试成功后并入全局 toolCalls。
    let attemptCalls: ToolTrace[] = [];
    const recordTrace = (t: ToolTrace): void => {
      attemptCalls.push({
        ...t,
        result:
          t.result.length > TOOL_TRACE_RESULT_LIMIT
            ? `${t.result.slice(0, TOOL_TRACE_RESULT_LIMIT)}…（已截断）`
            : t.result,
      });
    };
    let stopReason: StopReason = "end_turn";
    let attempt = 0;
    let executor: StreamingToolExecutor | null = null;
    // 0.3.1 反应式压缩阶段：0=未反应；1=已强制压缩；2=已硬截断（再超长则抛原错误）
    let reactiveStage = 0;
    for (;;) {
      // 工具池传函数（getTools）：每轮解析，MCP 工具同轮连接后后续 block 也能找到
      executor = new StreamingToolExecutor({
        // 收尾轮清空工具池：模型若仍发 tool_use 会走「未知工具」路径，绝不执行副作用
        tools: finalizing ? () => [] : getTools,
        ...(opts.checkPermission ? { checkPermission: opts.checkPermission } : {}),
        ...(opts.onToolCall ? { onToolCall: opts.onToolCall } : {}),
        ...(opts.onToolResult ? { onToolResult: opts.onToolResult } : {}),
        ...(opts.onPostToolUse ? { onPostToolUse: opts.onPostToolUse } : {}),
        // 始终收集轨迹（返回 toolCalls 是 core 契约，非可选回调）
        onToolTrace: recordTrace,
      });
      try {
        // system 拼到请求消息数组首条（不进 messages，适配器已会抽顶层/内联）
        const requestMessages: LLMMessage[] = system
          ? [{ role: "system", content: system }, ...messages]
          : messages;
        for await (const ev of opts.client.stream(requestMessages, {
          tools: toolSpecs,
          ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
          // V7 决策 C3：abort 透传底层 SDK/fetch——TaskStop 中断 in-flight 请求（立即生效）
          ...(opts.signal ? { signal: opts.signal } : {}),
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
        // V7 决策 C3：AbortError 直接结束——不重试、不进 transient 退避、不进反应式压缩
        //（否则「停止」被吞掉重跑）。reply 保留本尝试已产出的部分文本。
        if (isAbortError(e)) {
          return {
            messages,
            reply: textParts.join(""),
            iterations,
            added,
            compacts,
            toolCalls,
            aborted: true,
          };
        }
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
              attemptCalls = [];
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
          attemptCalls = [];
          continue;
        }
        if (attempt >= maxRetries || !isTransientError(e)) throw e;
        attempt++;
        textParts = [];
        toolUses = [];
        attemptCalls = [];
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

    // V6 决策 D：轨迹并入全局——必须在 getResults 之后（onToolTrace 在 settle 时触发，
    // 先合并会把仍在执行中的工具轨迹漏掉）。
    toolCalls.push(...attemptCalls);

    if (stopReason === "end_turn") {
      // V7 决策 A7：后台任务轮末自动收集——有完成结果则注入新 user 轮让模型收尾汇总
      if (opts.onBackgroundDone) {
        const summaries = await opts.onBackgroundDone();
        if (summaries.length > 0) {
          pushConversation({
            role: "user",
            content: `[后台子 agent 结果]\n${summaries.join("\n")}`,
          });
          continue;
        }
      }
      // V7 空结论兜底：end_turn 且无文本、无工具调用 = 空 completion（flash 模型偶发）。
      // 有界重试 + 短退避；耗尽仍空才返回（上层 agent 工具再给「子 agent 空结论」提示）。
      // 放 onBackgroundDone 之后：有后台汇总时优先收集，不被空重试循环吞掉。空完成无工具
      // 入队，跳过 getResults 安全；continue 走 while 顶部重新 stream（下一轮 executor 重建）。
      if (textParts.length === 0 && toolUses.length === 0) {
        if (emptyRetries < MAX_EMPTY_RETRIES) {
          emptyRetries++;
          await sleep(EMPTY_RETRY_DELAY_MS);
          continue;
        }
        // V7 空结论兜底增强：重试耗尽仍空 → 做一次收尾轮（无工具、明示给结论），
        // 仍空才放弃返回（上层 agent 工具再给「子 agent 空结论」提示）。有界：只多一轮。
        if (!finalizing) {
          finalizing = true;
          pushConversation({
            role: "user",
            content: "[你刚才未输出任何内容，请直接给出你的结论或回答，不要再调用任何工具]",
          });
          continue;
        }
      }
      // end_turn 下模型未请求工具（toolUses 应为空）；即便异常非空也保持原语义返回
      return { messages, reply, iterations, added, compacts, toolCalls };
    }

    if (stopReason === "tool_use") {
      // 预算内：继续工具循环
      if (iterations < maxIterations) continue;
      // V7 收尾轮（核心修复）：预算耗尽且模型仍在调工具 → 清空工具、明示给最终结论。
      // 否则 runQuery 返回的 reply 只剩末轮工具调用前的文本片段——explore 子 agent 常把
      // 8 轮全花在取证上、从没进入「给结论」阶段，这就是子 agent 空结论/半截结论的根因
      //（见 subagent-task-1.jsonl：末轮是「Let me get exact line numbers… + grep」）。
      if (!finalizing) {
        finalizing = true;
        pushConversation({
          role: "user",
          content: "[工具轮数已耗尽，请立即给出最终结论，不要再调用任何工具]",
        });
        continue;
      }
      // 收尾轮仍调了工具 → 以当前文本结束（有界，绝不无限循环）
      return { messages, reply, iterations, added, compacts, toolCalls };
    }

    if (stopReason === "max_tokens") {
      // V1 无 compact：截断时追加提示继续，让模型把话说完（已执行的工具结果已回填）
      pushConversation({ role: "user", content: "[输出被截断，请继续完成当前任务]" });
      if (!finalizing) {
        // 预算耗尽且被截断 → 下一轮转收尾（否则 reply 是被截断的半截文本）
        if (iterations >= maxIterations) finalizing = true;
        continue;
      }
      // 收尾轮仍被截断 → 有界返回（防 while(finalizing) 永不退出的死循环）
      return { messages, reply, iterations, added, compacts, toolCalls };
    }

    // stopReason === "error"
    pushConversation({ role: "user", content: "[模型返回错误，请重试]" });
    if (!finalizing) {
      // 预算耗尽且出错 → 下一轮转收尾
      if (iterations >= maxIterations) finalizing = true;
      continue;
    }
    // 收尾轮仍出错 → 有界返回
    return { messages, reply, iterations, added, compacts, toolCalls };
  }

  return { messages, reply, iterations, added, compacts, toolCalls };
}
