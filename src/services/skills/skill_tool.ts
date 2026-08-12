/**
 * V6 决策 B2：SkillRegistry + SkillTool。
 *
 * SkillTool 是模型运行时加载技能的入口：
 *   1. 按 name 找技能；未找到 → 提示串「未知技能」+ 可用清单。
 *   2. 命中 → 从磁盘现读 SKILL.md 全文回填 tool_result（readSkillBody，惰性加载 + 热更新；
 *      模型接下来按指令执行）。
 *   3. 激活该技能：本 turn 剩余可用工具 = allowed-tools ∩ 工具池（支持 mcp__* 通配），
 *      内置只读工具始终保留（防技能把自己关死）。无 allowed-tools 则不限制。
 *
 * name→path 只经 registry.find 解析（readSkillBody 只用 registry 里登记过的路径），
 * 绝不从入参拼接——输入注入无法让 SkillTool 读取任意文件。
 * 子 agent 化留 V7（Claude Code 的 SkillTool spawn 子 agent）；V6 用「主循环内注入 + 工具过滤」近似。
 */
import { z } from "zod";
import { isBuiltinReadOnlyTool } from "../../permissions/engine.js";
import type { Tool } from "../../tools.js";
import { readSkillBody } from "./loader.js";
import type { Skill } from "./loader.js";

/** allowed-tools 支持 `mcp__*` 这类通配（决策 B2 测试：含 mcp__* 放行）。 */
function matchPattern(pattern: string, name: string): boolean {
  if (!pattern.includes("*")) return pattern === name;
  const re = new RegExp(
    "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
  );
  return re.test(name);
}

/** 技能注册表：技能列表 + turn 级活跃技能状态 + allowed-tools 过滤。 */
export class SkillRegistry {
  private readonly skills: Skill[];
  private active: Skill | undefined;

  constructor(skills: Skill[]) {
    this.skills = skills;
  }

  get all(): Skill[] {
    return this.skills;
  }

  get activeSkill(): Skill | undefined {
    return this.active;
  }

  find(name: string): Skill | undefined {
    return this.skills.find((s) => s.name === name);
  }

  /** SkillTool.call 调用时激活（本 turn 剩余工具受限）。 */
  activate(skill: Skill | undefined): void {
    this.active = skill;
  }

  /** 每轮 runQuery 开始前重置（turn 边界）。 */
  resetActive(): void {
    this.active = undefined;
  }

  /**
   * allowed-tools 过滤：活跃技能限定的工具集 = 内置只读 ∪ (allowed-tools ∩ 池)。
   * 无活跃技能或技能无 allowed-tools → 原样返回。
   */
  filterToolsForActiveSkill(tools: Tool[]): Tool[] {
    const active = this.active;
    if (!active?.allowedTools || active.allowedTools.length === 0) return tools;
    return tools.filter(
      (t) =>
        isBuiltinReadOnlyTool(t.name) || active.allowedTools!.some((p) => matchPattern(p, t.name)),
    );
  }
}

/** 由 registry 构造 SkillTool（技能为空时由 buildTools 跳过装配）。 */
export function makeSkillTool(registry: SkillRegistry): Tool {
  return {
    name: "SkillTool",
    description:
      "加载技能并按技能指令执行。技能是预写的专业工作流（SKILL.md），加载后 body 会以 tool_result 返回，且本 turn 可用工具可能被技能的 allowed-tools 限制。用 name 指定技能。",
    inputSchema: z.object({
      name: z.string().min(1),
      args: z.record(z.string(), z.unknown()).optional(),
    }),
    isConcurrencySafe: false, // 激活技能改变工具池状态，串行
    async call(input) {
      const name = (input as { name: string }).name;
      const skill = registry.find(name);
      if (!skill) {
        const list =
          registry.all.length === 0
            ? "（当前无可用技能）"
            : registry.all.map((s) => `- ${s.name}: ${s.description}`).join("\n");
        return { result: `未知技能「${name}」。可用技能:\n${list}` };
      }
      registry.activate(skill);
      // 惰性读取：body 不入内存，每次调用从磁盘现读（热更新；失败返回错误文本，不抛）
      return { result: readSkillBody(skill) };
    },
  };
}
