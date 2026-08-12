/**
 * send_message 工具（V7 决策 C2）——协调者三件套之一：向指定后台子 agent 注入消息。
 * 消息在子查询下一次迭代边界送达（BackgroundTaskManager.poll 原子取空）。
 * 只装配主 agent 工具池（子 agent 类型过滤，worker 无协调权，防递归失控）。
 * 无文件/外部副作用 → 归内置只读（default 免确认）。
 */
import { z } from "zod";
import type { BackgroundTaskManager } from "../services/agents/team/registry.js";
import type { Tool, ToolCallResult } from "../tools.js";

const schema = z.object({
  task_id: z
    .string()
    .min(1)
    .describe("后台子 agent 任务 id（agent 工具 run_in_background=true 返回的 task-<n>）"),
  message: z.string().min(1).describe("要注入的新指令/补充要求"),
});

export function makeSendMessageTool(tasks: BackgroundTaskManager): Tool {
  return {
    name: "send_message",
    description:
      "Send a follow-up message to a running background sub-agent (task_id from the agent tool). " +
      "The message is injected at the sub-agent's next iteration boundary. Returns a confirmation, " +
      "or the task's status + current result if it already finished.",
    inputSchema: schema,
    isConcurrencySafe: true,
    async call(input): Promise<ToolCallResult> {
      const { task_id, message } = schema.parse(input);
      return { result: tasks.send(task_id, message) };
    },
  };
}
