/**
 * V2 工具执行：只读并行 / 写串行 + 结果重排。
 * partitionToolCalls 是 V5 StreamingToolExecutor 的前身（V5 把"收集完整 batch 再执行"改为边流式边并行）。
 * 关键约定：无论并发与否，返回的 result 数组顺序必须与传入 calls 一致——tool_result 回填时才能一一对应。
 */
import type { Decision } from "../permissions/types.js";
import type { ToolUseBlock } from "../providers/types.js";
import type { Tool } from "../tools.js";

export const MAX_CONCURRENCY = 10;

export interface ExecuteOptions {
  tools: Tool[];
  /** 权限回调：返回 allow/deny（ask 已由上层 resolve）；缺省 = 不设权限限制 */
  checkPermission?: (tool: Tool, input: unknown) => Promise<Decision>;
  onToolCall?: (name: string, input: unknown) => void;
  onToolResult?: (name: string, result: string) => void;
  /** 并发上限（仅作用于只读并行批），默认 10 */
  maxConcurrency?: number;
}

interface Item {
  tu: ToolUseBlock;
  index: number;
}

/** 单次工具调用的完整流程：找工具 → 权限校验 → 参数校验 → 执行 → 异常兜底。 */
async function runOne(tu: ToolUseBlock, opts: ExecuteOptions): Promise<string> {
  const tool = opts.tools.find((t) => t.name === tu.name);
  if (!tool) return `未知工具: ${tu.name}`;

  opts.onToolCall?.(tu.name, tu.input);
  if (opts.checkPermission) {
    const d = await opts.checkPermission(tool, tu.input);
    if (d === "deny") return `权限被拒绝: 未授权执行 ${tu.name}`;
  }

  const parsed = tool.inputSchema.safeParse(tu.input);
  if (!parsed.success) return `参数校验失败: ${parsed.error.message}`;

  try {
    const r = await tool.call(parsed.data);
    opts.onToolResult?.(tu.name, r.result);
    return r.result;
  } catch (e) {
    return `工具执行错误: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 分区：isConcurrencySafe === true 进并行批；其余（含未声明）进串行批——未声明的按保守处理。 */
function partitionToolCalls(
  calls: ToolUseBlock[],
  tools: Tool[],
): { concurrent: Item[]; serial: Item[] } {
  const concurrent: Item[] = [];
  const serial: Item[] = [];
  calls.forEach((tu, index) => {
    const tool = tools.find((t) => t.name === tu.name);
    const item: Item = { tu, index };
    if (tool?.isConcurrencySafe === true) concurrent.push(item);
    else serial.push(item);
  });
  return { concurrent, serial };
}

/** 信号量式并发：最多 maxConcurrency 个 worker 并行消费队列。 */
async function runConcurrent(items: Item[], opts: ExecuteOptions, max: number): Promise<string[]> {
  const results = new Array<string>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(max, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      const item = items[i]!;
      results[i] = await runOne(item.tu, opts);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function executeToolCalls(
  calls: ToolUseBlock[],
  opts: ExecuteOptions,
): Promise<string[]> {
  const results = new Array<string>(calls.length);
  const { concurrent, serial } = partitionToolCalls(calls, opts.tools);

  // 并行批：结果按 items 内顺序存放
  const concurrentResults = await runConcurrent(
    concurrent,
    opts,
    opts.maxConcurrency ?? MAX_CONCURRENCY,
  );
  for (let i = 0; i < concurrent.length; i++) {
    results[concurrent[i]!.index] = concurrentResults[i]!;
  }

  // 串行批：按原顺序逐个执行（含副作用工具，绝不并行）
  for (const item of serial) {
    results[item.index] = await runOne(item.tu, opts);
  }

  return results;
}
