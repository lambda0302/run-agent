/**
 * runAgent — V7 决策 A1：子 agent 核心原语。runQuery 的薄封装：
 * 独立上下文（子查询消息不污染主会话）+ 独立 transcript（可选）+ querySource 防 compact 递归。
 * 前台由 agent 工具 await；后台由 BackgroundTaskManager spawn（fire-and-forget）。
 * signal/pollExternal 透传支持 TaskStop(abort) / SendMessage(迭代边界注入)。
 */
import type { LLMClient, LLMMessage } from "../providers/types.js";
import type { Tool } from "../tools.js";
import type { PermissionCheckResult } from "./execute.js";
import { runQuery } from "./query.js";
import { appendMessage } from "../utils/sessionStorage.js";

/** V7 决策 A4：主循环 checkPermission 桥——REPL/one-shot 构造完 checkPermission 后写入，
 * agent 工具的子查询读取（前台复用父级权限可弹窗；后台被 manager 包装成 ask→deny 永不弹窗）。
 * 解决循环依赖：repl.ts 需要 buildTools 的 agent 工具，agent 工具需要主循环的 checkPermission。 */
export interface PermissionBridge {
  /** 必填但可 undefined：exactOptionalPropertyTypes 下允许 repl/one-shot 无条件赋值。 */
  checkPermission: ((tool: Tool, input: unknown, source?: string) => Promise<PermissionCheckResult>) | undefined;
}

export interface AgentRunOptions {
  /** 子查询首条 user 消息（委派任务） */
  prompt: string;
  client: LLMClient;
  /** 子查询工具集（由 agent 类型解析：general-purpose 过滤父级 / explore 固定只读集）。 */
  tools: Tool[] | (() => Tool[]);
  /** 类型 base system + 主 system 快照拼接（决策 A5）；缺省无。 */
  system?: string;
  contextWindow?: number;
  /** 子查询权限；前台继承父级（bridge），后台由 manager 包装 ask→deny。缺省 engine 兜底。
   *  source 为权限弹窗来源标签（如 "子 agent [explore]"），由 agent 工具包 wrap 注入。 */
  checkPermission?: (tool: Tool, input: unknown, source?: string) => Promise<PermissionCheckResult>;
  maxIterations?: number;
  /** 标记本请求来源（子查询走普通来源；compact 摘要走 'compact' 防递归） */
  querySource?: string;
  /** 增量文本回调（子 agent 逐 token 渲染） */
  onText?: (t: string) => void;
  /** V7 决策 C4：子查询独立 transcript（JSONL 逐条落盘）；缺省不落盘。 */
  transcriptFile?: string;
  /** V3 决策 8：超大工具结果落盘目录 */
  resultsDir?: string;
  /** V7 决策 C3：外部 abort（TaskStop）传播。 */
  signal?: AbortSignal;
  /** V7 决策 C2：外部消息注入（SendMessage 送达）。 */
  pollExternal?: () => LLMMessage[] | undefined;
}

export interface AgentRunResult {
  /** 最终回复文本 */
  reply: string;
  /** 完整对话（含最后 assistant 回复） */
  messages: LLMMessage[];
  iterations: number;
  /** 是否因外部 abort（TaskStop）提前结束；aborted 时 reply 是部分结果。 */
  aborted: boolean;
}

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const result = await runQuery([{ role: "user", content: opts.prompt }], {
    client: opts.client,
    tools: opts.tools,
    ...(opts.system !== undefined ? { system: opts.system } : {}),
    ...(opts.contextWindow !== undefined ? { contextWindow: opts.contextWindow } : {}),
    ...(opts.checkPermission !== undefined ? { checkPermission: opts.checkPermission } : {}),
    ...(opts.maxIterations !== undefined ? { maxIterations: opts.maxIterations } : {}),
    ...(opts.querySource !== undefined ? { querySource: opts.querySource } : {}),
    ...(opts.onText !== undefined ? { onText: opts.onText } : {}),
    ...(opts.resultsDir !== undefined ? { resultsDir: opts.resultsDir } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.pollExternal !== undefined ? { pollExternal: opts.pollExternal } : {}),
  });
  // V7 决策 C4：独立 transcript——先落 user prompt（初始消息不进 added，需显式写），
  // 再逐条落盘 added（assistant/tool 轮 + SendMessage 注入消息，天然记录）
  if (opts.transcriptFile) {
    await appendMessage(opts.transcriptFile, { role: "user", content: opts.prompt });
    for (const m of result.added) {
      await appendMessage(opts.transcriptFile, m);
    }
  }
  return {
    reply: result.reply,
    messages: result.messages,
    iterations: result.iterations,
    aborted: result.aborted ?? false,
  };
}
