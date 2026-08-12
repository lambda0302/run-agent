/**
 * AgentRegistry — V7 决策 B：agent 类型注册表。
 * 内置三型（general-purpose / explore / verification[M5]）硬编码；M3 的 loader
 * 会把用户自定义 frontmatter 类型 merge 进来（内置优先，同名自定义被忽略）。
 */
import type { PermissionCheckResult } from "../../core/execute.js";
import type { Tool } from "../../tools.js";
import { globTool } from "../../tools/glob.js";
import { grepTool } from "../../tools/grep.js";
import { readTool } from "../../tools/read.js";
import { repoMapTool } from "../../tools/repo_map.js";
import {
  VERIFICATION_SYSTEM,
  VERIFICATION_TOOL_NAMES,
  makeVerificationCheckPermission,
} from "./builtin/verification.js";

export interface AgentTypeDef {
  name: string;
  description: string;
  /** 解析子查询工具集；内置 general-purpose 用父级池过滤（不含三件套，防递归）。 */
  resolveTools(parentTools: () => Tool[]): Tool[];
  /** 类型 base system（并入子 system，见决策 A5）。 */
  system?: string;
  maxIterations?: number;
  /** 类型级 model 覆盖（优先级：调用参数 > 类型 frontmatter > 继承父级）。 */
  model?: string;
  /** V7 决策 D3：类型级专门权限策略（如 verification 的 safe bash allow / 项目写 deny）。
   *  定义时替换父级继承的 checkPermission；缺省继承父级。 */
  checkPermission?: (tool: Tool, input: unknown) => Promise<PermissionCheckResult>;
}

/** 协调者三件套：只装配主 agent；子 agent 内置类型默认不含（worker 无协调权，防递归失控）。 */
export const CORE_TEAM_TOOLS = new Set(["agent", "send_message", "task_stop"]);

/** 0.4.1 explore 只读工具集：explore 类型复用（`src/tools/explore.ts` 私有 READONLY_TOOLSET 同构）。 */
const READONLY_TOOLSET: Tool[] = [repoMapTool, globTool, grepTool, readTool];

export function builtinAgentTypes(): AgentTypeDef[] {
  return [
    {
      name: "general-purpose",
      description: "通用委派 worker：父级全部工具（不含 agent/send_message/task_stop，防递归）",
      resolveTools: (parent) => parent().filter((t) => !CORE_TEAM_TOOLS.has(t.name)),
    },
    {
      name: "explore",
      description: "只读探索：repo_map/glob/grep/read_file，thoroughness 由调用方深度决定（默认 medium=8 轮）",
      resolveTools: () => [...READONLY_TOOLSET],
      system:
        "你是只读探索子 agent。只能读/搜项目（repo_map/glob/grep/read_file），绝不能改文件或执行命令。" +
        "目标是回答调用方的探索问题，返回结论与关键位置。",
      maxIterations: 8,
    },
    {
      // V7 决策 D（0.7.1）：对抗性验证专家——证据式 VERDICT 契约，工具集无写工具 + 专门权限策略
      name: "verification",
      description:
        "证据式验证专家：跑构建/测试/检查出具带命令证据的 VERDICT: PASS/FAIL/PARTIAL。" +
        "非平凡改动（3+ 文件/后端/API/基础设施）完成前必须 spawn。",
      resolveTools: (parent) => parent().filter((t) => VERIFICATION_TOOL_NAMES.has(t.name)),
      system: VERIFICATION_SYSTEM,
      maxIterations: 12,
      checkPermission: makeVerificationCheckPermission(),
    },
  ];
}

export class AgentRegistry {
  private readonly types = new Map<string, AgentTypeDef>();

  constructor(builtin: AgentTypeDef[] = []) {
    for (const t of builtin) this.types.set(t.name, t);
  }

  get(name: string): AgentTypeDef | undefined {
    return this.types.get(name);
  }

  list(): AgentTypeDef[] {
    return [...this.types.values()];
  }

  /** M3：merge 自定义 frontmatter 类型；内置优先，同名自定义被忽略（返回 false）。 */
  register(def: AgentTypeDef): boolean {
    if (this.types.has(def.name)) return false;
    this.types.set(def.name, def);
    return true;
  }
}
