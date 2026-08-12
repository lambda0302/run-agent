/**
 * task_stop 工具（V7 决策 C3）——协调者三件套之一：停止指定后台子 agent。
 * abort 传播（子查询迭代边界检查 + 适配器 signal 中断 in-flight 请求）→ 状态标记 stopped，
 * 部分结果轮末随 awaitAll 汇总。幂等。
 * 只装配主 agent 工具池（子 agent 类型过滤，worker 无协调权，防递归失控）。
 */
import { z } from "zod";
import type { BackgroundTaskManager } from "../services/agents/team/registry.js";
import type { Tool, ToolCallResult } from "../tools.js";

const schema = z.object({
  task_id: z
    .string()
    .min(1)
    .describe("后台子 agent 任务 id（agent 工具 run_in_background=true 返回的 task-<n>）"),
});

export function makeTaskStopTool(tasks: BackgroundTaskManager): Tool {
  return {
    name: "task_stop",
    description:
      "Stop a running background sub-agent (task_id from the agent tool). Aborts its current " +
      "request and marks the task stopped; its partial result is collected at end of turn.",
    inputSchema: schema,
    isConcurrencySafe: true,
    async call(input): Promise<ToolCallResult> {
      const { task_id } = schema.parse(input);
      return { result: tasks.stop(task_id) };
    },
  };
}
