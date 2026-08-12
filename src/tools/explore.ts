/**
 * explore 工具（0.4.1 决策 E / 8.2）：只读探索子 agent。
 * 用只读工具集（repo_map/glob/grep/read_file）跑一个嵌套 runQuery，把最终 reply 回填 tool_result。
 * 上下文独立（带 contextWindow 时子查询超长可自动压缩），不污染主会话；复用主 system（含 MEMORY.md 索引）。
 * isConcurrencySafe: false（昂贵、串行）；权限继承父级；工具集硬编码只读，不信任任何调用方参数。
 * 后台运行与模型选择留到 V7（泛化为 Agent 工具）。
 */
import { z } from "zod";
import { runQuery } from "../core/query.js";
import type { Decision } from "../permissions/types.js";
import type { LLMClient, LLMMessage } from "../providers/types.js";
import type { Tool, ToolCallResult } from "../tools.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { readTool } from "./read.js";
import { repoMapTool } from "./repo_map.js";

type Thoroughness = "quick" | "medium" | "very thorough";

/** 只读工具集：子 agent 只能读，绝不写（不含 write/edit/bash/remember）。 */
const READONLY_TOOLSET: Tool[] = [repoMapTool, globTool, grepTool, readTool];

/** thoroughness → 子查询最大轮数（学 Claude Code EXPLORE_AGENT 的调用方深度声明）。
 *  0.7.2 上调 medium/very thorough：实测 explore 子 agent 常在 8 轮内只完成取证、来不及给结论
 *  （query.ts 收尾轮是兜底，这里再留足取证余量，深任务尽量自然完成）。 */
const MAX_ITERATIONS: Record<Thoroughness, number> = {
  quick: 4,
  medium: 12,
  "very thorough": 16,
};

const schema = z.object({
  prompt: z
    .string()
    .min(1)
    .describe(
      "Read-only exploration task for the sub-agent (e.g. 'find where X is handled and how the pieces are wired together')",
    ),
  thoroughness: z
    .enum(["quick", "medium", "very thorough"])
    .optional()
    .describe("Search depth (default 'medium')"),
});

export interface ExploreToolOptions {
  client: LLMClient;
  /** 复用主会话的 system prompt（含 MEMORY.md 索引）；缺省不给子查询 system。 */
  system?: string;
  /** 子查询上下文窗口；设了子 agent 超长可自动压缩。 */
  contextWindow?: number;
  /** 权限继承父级；子查询只读工具 default 下免确认，用户 deny 规则仍生效。 */
  checkPermission?: (tool: Tool, input: unknown) => Promise<Decision>;
}

export function makeExploreTool(deps: ExploreToolOptions): Tool {
  return {
    name: "explore",
    description:
      "Run a read-only sub-agent to explore the codebase and answer a question, then return its conclusion. " +
      "The sub-agent can only read/search (repo_map/glob/grep/read_file) — it cannot modify files or run commands. " +
      "Use for multi-file investigation like 'where is X implemented and how is it wired together?'. " +
      "thoroughness controls search depth: quick/medium/very thorough.",
    inputSchema: schema,
    isConcurrencySafe: false,
    async call(input): Promise<ToolCallResult> {
      const { prompt, thoroughness } = schema.parse(input);
      const depth = thoroughness ?? "medium";
      const initial: LLMMessage[] = [{ role: "user", content: prompt }];
      try {
        const result = await runQuery(initial, {
          client: deps.client,
          tools: READONLY_TOOLSET,
          maxIterations: MAX_ITERATIONS[depth],
          ...(deps.system !== undefined ? { system: deps.system } : {}),
          ...(deps.contextWindow !== undefined ? { contextWindow: deps.contextWindow } : {}),
          ...(deps.checkPermission !== undefined ? { checkPermission: deps.checkPermission } : {}),
        });
        return { result: result.reply };
      } catch (e) {
        // 子查询错误不抛出、转为 tool_result 文本（无副作用可安全重试）
        return { result: `explore 子查询失败: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  };
}
