/**
 * V2 工具执行 → V5 StreamingToolExecutor：只读并行 / 写串行 + 结果重排 + 流式即时执行。
 *
 * V5 决策 C：旧 executeToolCalls 是「收集完整 batch → 全批执行」；StreamingToolExecutor 把执行
 * 前移到流式期间——tool_use block 一完整就 addTool 入队执行，不必等响应完结（长时间任务里模型
 * 最后一行文本不再延迟第一批工具）。
 *
 * 关键约定（延续）：无论并发与否，返回的 result 数组顺序必须与传入 calls 一致——tool_result
 * 回填时才能一一对应。
 *
 * 队列规则（对齐参考实现 StreamingToolExecutor）：
 *   - 并发安全（isConcurrencySafe === true）工具：仅当「所有正在执行的工具都是并发安全」才允许
 *     并入（上限 maxConcurrency）；写类工具执行期间不并入任何新工具。
 *   - 非安全（写类）工具：一次只跑一个，且不打断当前正在执行的工具（等其全部完成才启动）。
 *   - 队列严格 FIFO：安全工具不越过前面排队的写工具抢先启动（结果仍按 index 重排，顺序契约不变）。
 */
import type { Decision } from "../permissions/types.js";
import type { ToolUseBlock } from "../providers/types.js";
import type { Tool } from "../tools.js";

export const MAX_CONCURRENCY = 10;

export interface ExecuteOptions {
  /** V5 决策 B3：工具池可为函数（每轮解析——mcp_connect 注册新 MCP 工具后，同轮后续 block 也可找到）。 */
  tools: Tool[] | (() => Tool[]);
  /** 权限回调：返回 allow/deny（ask 已由上层 resolve）；缺省 = 不设权限限制 */
  checkPermission?: (tool: Tool, input: unknown) => Promise<Decision>;
  onToolCall?: (name: string, input: unknown) => void;
  onToolResult?: (name: string, result: string) => void;
  /** 并发上限（仅作用于只读并行批），默认 10 */
  maxConcurrency?: number;
}

interface ExecutorItem {
  tu: ToolUseBlock;
  index: number;
  /** isConcurrencySafe === true 进并行批；其余（含未声明）按写类保守处理 */
  safe: boolean;
  /** addTool 里解析的工具；null = 未知工具（直接回填提示串，不执行） */
  tool: Tool | null;
  result: string | null;
  resolve: (r: string) => void;
  promise: Promise<string>;
}

export class StreamingToolExecutor {
  private readonly opts: ExecuteOptions;
  private readonly max: number;
  private readonly items: ExecutorItem[] = [];
  /** 待启动队列（FIFO）——已 settle 的（未知/deny）不在此队列 */
  private queue: ExecutorItem[] = [];
  private running = 0;
  private runningAllSafe = true;

  constructor(opts: ExecuteOptions) {
    this.opts = opts;
    this.max = opts.maxConcurrency ?? MAX_CONCURRENCY;
  }

  private resolveTools(): Tool[] {
    return typeof this.opts.tools === "function" ? this.opts.tools() : this.opts.tools;
  }

  /**
   * 流式期间调用：tool_use block 完整即入队执行。
   * 权限校验复用 runOne 的判定段（找工具 → onToolCall → checkPermission）。
   * 未知工具 / 权限 deny → 立即回填提示串（不执行、不入队），保证 loop 语义不变。
   */
  async addTool(tu: ToolUseBlock, index: number): Promise<void> {
    const tool = this.resolveTools().find((t) => t.name === tu.name) ?? null;

    let resolve!: (r: string) => void;
    const promise = new Promise<string>((res) => (resolve = res));
    const item: ExecutorItem = {
      tu,
      index,
      safe: tool?.isConcurrencySafe === true,
      tool,
      result: null,
      resolve,
      promise,
    };
    this.items.push(item);

    if (!tool) {
      this.settle(item, `未知工具: ${tu.name}`);
      return;
    }
    this.opts.onToolCall?.(tu.name, tu.input);
    if (this.opts.checkPermission) {
      const d = await this.opts.checkPermission(tool, tu.input);
      if (d === "deny") {
        this.settle(item, tool.denyMessage ?? `权限被拒绝: 未授权执行 ${tu.name}`);
        return;
      }
    }
    this.queue.push(item);
    this.processQueue();
  }

  private settle(item: ExecutorItem, result: string): void {
    item.result = result;
    item.resolve(result);
  }

  /** 队列推进：见文件头规则。执行是 fire-and-forget（不 await），让流式期间也能并行跑。 */
  private processQueue(): void {
    while (this.queue.length > 0) {
      const item = this.queue[0]!;
      if (item.safe) {
        // 写类在执行中 → 不并入新 safe 工具；已达上限 → 等完成一个再补
        if (!this.runningAllSafe || this.running >= this.max) return;
        this.queue.shift();
        this.start(item);
      } else {
        // 写类：一次一个、不打断——正在执行任何工具时都等待
        if (this.running > 0) return;
        this.queue.shift();
        this.start(item);
      }
    }
  }

  private start(item: ExecutorItem): void {
    this.running++;
    if (!item.safe) this.runningAllSafe = false;
    void this.execute(item).then(() => {
      this.running--;
      if (this.running === 0) this.runningAllSafe = true;
      this.processQueue();
    });
  }

  /** 单次执行：参数校验 → 调用 → 异常兜底（与 runOne 同语义：一律字符串回填，不 throw）。 */
  private async execute(item: ExecutorItem): Promise<void> {
    let result: string;
    try {
      const tool = item.tool!;
      const parsed = tool.inputSchema.safeParse(item.tu.input);
      if (!parsed.success) {
        result = `参数校验失败: ${parsed.error.message}`;
      } else {
        const r = await tool.call(parsed.data);
        this.opts.onToolResult?.(item.tu.name, r.result);
        result = r.result;
      }
    } catch (e) {
      result = `工具执行错误: ${e instanceof Error ? e.message : String(e)}`;
    }
    this.settle(item, result);
  }

  /**
   * 等全部完成，结果按 index 重排回填。幂等：多次调用返回相同数组。
   * 每个 item 的 promise 只 resolve 一次（settle），后续调用 Promise.all 已结算立即返回。
   */
  async getResults(): Promise<string[]> {
    await Promise.all(this.items.map((it) => it.promise));
    const results = new Array<string>(this.items.length);
    for (const it of this.items) results[it.index] = it.result ?? "";
    return results;
  }
}

/**
 * V2 兼容入口：一次性 addTool 全部 + getResults。
 * 对外契约不变（结果顺序 / 错误文本 / 并发上限 10），原并发用例全量回归锁定。
 */
export async function executeToolCalls(
  calls: ToolUseBlock[],
  opts: ExecuteOptions,
): Promise<string[]> {
  const executor = new StreamingToolExecutor(opts);
  for (let i = 0; i < calls.length; i++) {
    await executor.addTool(calls[i]!, i);
  }
  return executor.getResults();
}
