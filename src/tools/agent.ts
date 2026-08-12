/**
 * agent 工具（V7 决策 A2）——泛化 explore 的嵌套 runQuery 为通用委派原语。
 * schema: description/prompt/agentType/model/run_in_background。
 * foreground: await runAgent → 回填 [<类型> 结论]<reply>。
 * background: BackgroundTaskManager.spawn → 立即返回可寻址占位（可 SendMessage/TaskStop）。
 * 子 agent 工具集由 agent 类型解析（决策 B）：general-purpose = 父级池过滤三件套；explore = 只读集。
 * isConcurrencySafe: true（多 specialist 并行，task registry 仅 Map push 无竞态）。
 */
import { z } from "zod";
import type { PermissionCheckResult } from "../core/execute.js";
import { runAgent } from "../core/run_agent.js";
import type { LLMClient } from "../providers/types.js";
import type { AgentRegistry } from "../services/agents/registry.js";
import type { BackgroundTaskManager } from "../services/agents/team/registry.js";
import type { Tool, ToolCallResult } from "../tools.js";

const schema = z.object({
  description: z.string().min(1).describe("A short (3-5 word) description of the task"),
  prompt: z.string().min(1).describe("The task for the agent to perform"),
  agentType: z
    .string()
    .optional()
    .describe("general-purpose | explore | verification | 自定义 frontmatter 类型（缺省 general-purpose）"),
  model: z
    .string()
    .optional()
    .describe("Model override; 优先级: 调用参数 > 类型 frontmatter > 继承父级"),
  run_in_background: z
    .boolean()
    .optional()
    .describe("后台运行:立即返回 task_id,本轮结束自动收集结果汇总"),
});

export interface AgentToolOptions {
  client: LLMClient;
  /** 主 system 快照（含 MEMORY.md 索引）——并入子 system（A5）。 */
  system?: string;
  contextWindow?: number;
  /** 子查询权限:主循环 checkPermission（bridge 提供,前台可弹窗）。缺省 engine 兜底。
   *  第三参 source 为权限弹窗来源标签,由本工具包 wrap 注入（"子 agent [<类型>]"）。 */
  checkPermission?: (tool: Tool, input: unknown, source?: string) => Promise<PermissionCheckResult>;
  /** model 覆盖工厂（CLI 注入）:provider/apiKey/baseURL 与主一致,只换 model（A3）。 */
  makeModelClient?: (model: string) => LLMClient;
  registry: AgentRegistry;
  backgroundTasks?: BackgroundTaskManager;
  resultsDir?: string;
  /** V7 决策 C4：后台任务独立 transcript 目录。 */
  transcriptDir?: string;
  /** 父级工具池 getter（延迟绑定,每轮更新,含 MCP 已连接工具）。 */
  parentTools: () => Tool[];
}

export function makeAgentTool(opts: AgentToolOptions): Tool {
  // 动态列出注册表里全部可委派类型（内置 + 自定义 frontmatter）——模型直接看到
  // agentType 有哪些可选值，不必去文件系统瞎猜/创建类型（.run-agent/ 对工具不可见）。
  const typeNames = opts.registry.list().map((t) => t.name).join(" / ");
  return {
    name: "agent",
    description:
      `Spawn a sub-agent to perform a task, then return its conclusion. ` +
      `Use to delegate a well-scoped task to a specialist. Available agentType values: ${typeNames}. ` +
      `run_in_background=true returns a task_id immediately and the ` +
      `result is collected at end of turn (use send_message to add input / task_stop to abort). ` +
      `Sub-agents inherit the parent's permissions but can never exceed them.`,
    inputSchema: schema,
    isConcurrencySafe: true,
    async call(input): Promise<ToolCallResult> {
      const { prompt, agentType, model, run_in_background } = schema.parse(input);
      const typeName = agentType ?? "general-purpose";
      const def = opts.registry.get(typeName);
      if (!def) {
        const avail = opts.registry.list().map((t) => t.name).join(", ");
        return { result: `未知 agent 类型 "${typeName}"。可用类型: ${avail}` };
      }
      // model 解析（调用参数 > 类型 frontmatter > 继承父级）
      const modelName = model ?? def.model;
      let client = opts.client;
      if (modelName) {
        if (!opts.makeModelClient) {
          return { result: `无法用模型 "${modelName}" 创建子 agent: 当前会话未注入 model 工厂` };
        }
        client = opts.makeModelClient(modelName);
      }
      // 子 system = 类型 base system + 主 system 快照（一次性组装,A5）
      const subSystem = [def.system, opts.system].filter((s) => s && s.length > 0).join("\n\n");
      // V7 决策 D3：类型级专门权限策略优先（verification 的 safe bash allow / 项目写 deny），
      // 否则继承父级 checkPermission（engine 硬底线 / 用户规则在子查询同样生效）。
      // 继承时包一层注入「子 agent [<类型>]」来源标签 → 权限弹窗可分辨请求来自子 agent。
      const typeCp = def.checkPermission;
      const inheritedCp = opts.checkPermission;
      const cp =
        typeCp ??
        (inheritedCp
          ? (tool: Tool, input: unknown): Promise<PermissionCheckResult> =>
              inheritedCp(tool, input, `子 agent: ${typeName}`)
          : undefined);
      const shared = {
        client,
        tools: def.resolveTools(opts.parentTools),
        ...(subSystem ? { system: subSystem } : {}),
        ...(opts.contextWindow !== undefined ? { contextWindow: opts.contextWindow } : {}),
        ...(cp !== undefined ? { checkPermission: cp } : {}),
        ...(def.maxIterations !== undefined ? { maxIterations: def.maxIterations } : {}),
        ...(opts.resultsDir !== undefined ? { resultsDir: opts.resultsDir } : {}),
      };

      if (run_in_background) {
        if (!opts.backgroundTasks) {
          return { result: "后台运行不可用: 当前会话未装配后台任务管理器" };
        }
        const id = opts.backgroundTasks.spawn({
          type: typeName,
          prompt,
          ...shared,
          ...(opts.transcriptDir !== undefined ? { transcriptDir: opts.transcriptDir } : {}),
        });
        return {
          result: `[后台子 agent ${id}(${typeName}) 已启动 — ${prompt.slice(0, 60)};运行中可用 send_message 补充 / task_stop 停止]`,
        };
      }
      const result = await runAgent({ prompt, ...shared });
      const body = result.reply.trim();
      // V7 空结论兜底：query 层的空 completion 重试耗尽仍为空 → 明确提示，别让协调者看到
      // 空「[explore 结论]」误以为成功
      return {
        result: `[${typeName} 结论]\n${body || "(子 agent 空结论——重试后仍无文本输出，请重新委派或补充任务)"}`,
      };
    },
  };
}
