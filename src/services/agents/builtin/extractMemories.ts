/**
 * extractMemories 子 agent(V7 决策 E,0.7.1)——后台记忆提取兜底(双轨之二)。
 * 双轨 = 主 agent 主动 remember(0.4.0)+ 每轮结束后台提取(本类型)。
 * 触发由 src/services/extract/extract.ts 引擎负责(fire-and-forget,直接 runAgent 不入 task registry);
 * 本文件是类型定义 + 提取指令 + 权限策略。
 * 工具集:read_file/glob/grep + remember;权限 ask→deny,唯一例外 remember→allow(仅 Trust,后台无交互);
 * maxIterations 5 硬顶;querySource 'extract_memories'(元数据标记,防 compact 递归语义)。
 */
import type { PermissionCheckResult } from "../../../core/execute.js";
import { NOT_TO_SAVE_GUIDANCE } from "../../../core/memory.js";
import type { Tool } from "../../../tools.js";
import type { AgentTypeDef } from "../registry.js";

/** extractMemories 工具集:只读三件套 + remember。 */
export const EXTRACT_MEMORY_TOOLS = new Set(["read_file", "glob", "grep", "remember"]);

/** 子 system:提取指令 + 「先读现有记忆再写」防重复 + 不存什么 + frontmatter 四类。 */
export const EXTRACT_MEMORY_SYSTEM = `你是后台记忆提取器:从会话增量消息中判断有哪些值得跨会话沉淀的稳定结论,用 remember 写入项目记忆。

=== 先读现有记忆再写 ===
写任何记忆前,先 read_file 读项目记忆索引(MEMORY.md)或相关 topic 文件——已存在的记忆不重复写;内容已过时用 remember 更新(同 name 覆盖,见 remember 工具描述)。

=== 什么时候写 ===
写「稳定的、反直觉的、非显而易见」的结论:用户偏好/工作方式、被反复确认的做法、跨会话有用的教训。
${NOT_TO_SAVE_GUIDANCE}

=== frontmatter 四类(type 字段) ===
- user: 用户身份/偏好/技能;feedback: 用户对我(agent)工作方式的纠正;project: 项目目标/约束/进展;reference: 外部资源指针。
- name: kebab-case 短文件名;description: 一句话钩子。都不给时自动推导。

=== 工作纪律 ===
- 只写最重要的 1-3 条;没把握不写(宁缺毋滥)。
- 只处理增量消息里的会话结论,禁止读项目源码做代码分析(那是主 agent 的事)。
- 用字面量工具调用,不编造内容;本次没沉淀价值就直接结束,无需解释。`;

/** 权限策略:只读三件套 + remember 放行;其余 deny(本策略永不出 ask,后台无交互)。 */
export function makeExtractMemCheckPermission(
  isTrusted: boolean,
): (tool: Tool, input: unknown) => Promise<PermissionCheckResult> {
  return async (tool): Promise<PermissionCheckResult> => {
    if (tool.name === "remember") {
      return isTrusted
        ? { decision: "allow" }
        : { decision: "deny", reason: "未信任项目,禁止写记忆" };
    }
    if (tool.name === "read_file" || tool.name === "glob" || tool.name === "grep") {
      return { decision: "allow" };
    }
    return { decision: "deny", reason: `extractMemories 不可用工具: ${tool.name}` };
  };
}

/**
 * 内置类型定义(引擎直接使用;checkPermission 以 isTrusted=true 装配——引擎仅在 Trust 下触发,
 * 且父池里的 remember 工具内部仍有 Trust 门控兜底)。不注册进 builtinAgentTypes:
 * 这是系统内部机制,不进主 agent 可 spawn 的类型清单。
 */
export const extractMemoriesDef: AgentTypeDef = {
  name: "extractMemories",
  description: "后台记忆提取:分析会话增量,把稳定的跨会话结论用 remember 写入项目记忆。",
  resolveTools: (parent) => parent().filter((t) => EXTRACT_MEMORY_TOOLS.has(t.name)),
  system: EXTRACT_MEMORY_SYSTEM,
  maxIterations: 5,
  checkPermission: makeExtractMemCheckPermission(true),
};
