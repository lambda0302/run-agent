/**
 * extractMemories 子 agent(V7 决策 E,0.7.1)——后台记忆提取兜底(双轨之二)。
 * 双轨 = 主 agent 主动 remember(0.4.0)+ 每轮结束后台提取(本类型)。
 * 触发由 src/services/extract/extract.ts 引擎负责(fire-and-forget,直接 runAgent 不入 task registry);
 * 本文件是类型定义 + 提取指令 + 权限策略。
 * 工具集:read_file/glob/grep + remember;权限:read 三件套走主引擎单线管线(ask→deny,仅 cwd 内
 * + memory 豁免可读),remember→allow(仅 Trust);maxIterations 5 硬顶;
 * querySource 'extract_memories'(元数据标记,防 compact 递归语义)。
 */
import type { PermissionCheckResult } from "../../../core/execute.js";
import { NOT_TO_SAVE_GUIDANCE } from "../../../core/memory.js";
import { hasPermissionsToUseTool } from "../../../permissions/engine.js";
import type { PermissionRule } from "../../../permissions/types.js";
import type { Tool } from "../../../tools.js";
import type { AgentTypeDef } from "../registry.js";

/** extractMemories 工具集:只读三件套 + remember。 */
export const EXTRACT_MEMORY_TOOLS = new Set(["read_file", "glob", "grep", "remember"]);

/** 子 system:提取指令 + 「先读现有记忆再写」防重复 + 不存什么 + frontmatter 四类。 */
export const EXTRACT_MEMORY_SYSTEM = `你是后台记忆提取器:从会话增量消息中判断有哪些值得跨会话沉淀的稳定结论,用 remember 写入项目记忆。

=== 先读现有记忆再写 ===
写任何记忆前,先 read_file 读项目记忆索引(MEMORY.md)或相关 topic 文件——已存在的记忆不重复写;内容已过时用 remember 更新(同 name 覆盖,见 remember 工具描述)。

=== 什么时候写 ===
写「稳定的、反直觉的、非显而易见的」结论:用户偏好/工作方式、被反复确认的做法、跨会话有用的教训。
${NOT_TO_SAVE_GUIDANCE}

=== frontmatter 四类(type 字段) ===
- user: 用户身份/偏好/技能;feedback: 用户对我(agent)工作方式的纠正;project: 项目目标/约束/进展;reference: 外部资源指针。
- name: kebab-case 短文件名;description: 一句话钩子。都不给时自动推导。

=== 工作纪律 ===
- 只写最重要的 1-3 条;没把握不写(宁缺毋滥)。
- 只处理增量消息里的会话结论,禁止读项目源码做代码分析(那是主 agent 的事)。
- 用字面量工具调用,不编造内容;本次没沉淀价值就直接结束,无需解释。`;

/**
 * 权限策略(V8-P2 修复):read_file/glob/grep **不再无条件 allow**,改走主引擎单线管线
 * `hasPermissionsToUseTool`(default 模式)——记忆读豁免(`.run-agent/memory/**`·Trust)、路径危险段
 * (`.git`/`.claude`/`.run-agent`)、cwd 边界、Windows 可疑路径、用户 deny/allow 规则**全部生效**。
 * 后台无交互(轮末 fire-and-forget),engine 的 ask 一律降级 deny → 只读范围 = 记忆目录 + 项目内;
 * remember→allow(仅 Trust);其余 deny(本策略永不出 ask)。
 */
export function makeExtractMemCheckPermission(
  isTrusted: boolean,
  cwd: string,
  rules: PermissionRule[],
): (tool: Tool, input: unknown) => Promise<PermissionCheckResult> {
  return async (tool, input): Promise<PermissionCheckResult> => {
    if (tool.name === "remember") {
      return isTrusted
        ? { decision: "allow" }
        : { decision: "deny", reason: "未信任项目,禁止写记忆" };
    }
    if (tool.name === "read_file" || tool.name === "glob" || tool.name === "grep") {
      // 只读三件套:引擎 default 下 cwd 内/记忆豁免本就 allow;危险段与 cwd 外被拒。
      // ask 在后台无弹窗 → 降级 deny(只读工具 cwd 外是 ask,安全底线收紧为 deny)。
      const d = hasPermissionsToUseTool(tool.name, input, "default", rules, isTrusted, cwd);
      return d === "ask"
        ? { decision: "deny", reason: "后台提取仅可读项目内(memory 豁免 + cwd 内)" }
        : { decision: d };
    }
    return { decision: "deny", reason: `extractMemories 不可用工具: ${tool.name}` };
  };
}

/**
 * 内置类型定义(引擎直接使用)。checkPermission 由 extract.ts 触发时按 isTrusted/cwd/rules
 * 现配(见 extract.ts `run()`)——本定义不带静态策略。不注册进 builtinAgentTypes:
 * 这是系统内部机制,不进主 agent 可 spawn 的类型清单。
 */
export const extractMemoriesDef: AgentTypeDef = {
  name: "extractMemories",
  description: "后台记忆提取:分析会话增量,把稳定的跨会话结论用 remember 写入项目记忆。",
  resolveTools: (parent) => parent().filter((t) => EXTRACT_MEMORY_TOOLS.has(t.name)),
  system: EXTRACT_MEMORY_SYSTEM,
  maxIterations: 5,
};
