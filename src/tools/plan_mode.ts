/**
 * V5 决策 A：Plan 模式导航工具（enter_plan_mode / exit_plan_mode，同文件工厂装配）。
 * - enter_plan_mode：无入参，把当前权限模式切到 "plan"（强制只读）。校验：已在 plan 时报错。
 * - exit_plan_mode：入参 { plan }，把计划直写到 <cwd>/.run-agent/plans/plan-<ts>.md（系统行为，
 *   不经权限管线——参考实现 ExitPlanModeV2Tool 同样直写），恢复进入 plan 前的权限模式，
 *   返回「用户已批准 + plan 全文 + 文件路径」（/compact 后的上下文重建也能看到计划）。
 * 用户审批不在此处：engine 的 plan 分支对 exit_plan_mode 返回 ask，由 repl 的 makeCheckPermission
 * → resolveAsk 弹窗负责（one-shot 不装配本工具，无弹窗，防死锁）。
 *
 * prePlanMode 存工厂闭包（单会话单实例，天然安全）；/plan 手动入口与 enter_plan_mode 共用
 * 同一状态机（决策 A5）——两者都通过本工厂暴露的 enterPlanManually / call 记录 prePlanMode。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { PermissionMode } from "../permissions/types.js";
import type { Tool, ToolCallResult } from "../tools.js";

export interface PlanModeOptions {
  /** 查询当前权限模式（repl 闭包读 ctx.mode） */
  getMode: () => PermissionMode;
  /** 切换权限模式（repl 闭包写 ctx.mode） */
  setMode: (mode: PermissionMode) => void;
  /** 是否可弹交互确认；one-shot=false 时调用方不装配本工具。 */
  canPrompt: boolean;
  /** plan 文件目录（缺省 <cwd>/.run-agent/plans；测试注入临时目录） */
  plansDir?: string;
  /** 时间戳注入（测试用）；缺省 new Date() */
  now?: () => Date;
}

/** 工厂返回值：工具列表 + /plan 手动入口（共享 prePlanMode 闭包）。 */
export interface PlanTools {
  tools: Tool[];
  /** /plan 手动进入：已在 plan 返回 false；否则记录 prePlanMode 并 setMode("plan")。 */
  enterPlanManually(): boolean;
}

/** plan 文件名时间戳：ISO 去掉冒号/句点（文件系统安全）。 */
function tsName(d: Date): string {
  return d.toISOString().replace(/[:.]/g, "-");
}

export function makePlanTools(deps: PlanModeOptions): PlanTools {
  // 进入 plan 前的权限模式（enter_plan_mode 与 /plan 手动入口共用，决策 A5）
  let prePlanMode: PermissionMode = "default";

  const enter: Tool = {
    name: "enter_plan_mode",
    description:
      "Switch to read-only plan mode: explore the codebase, weigh options, then present a plan " +
      "for approval via exit_plan_mode. In plan mode write/edit/run_bash/remember are denied. " +
      "Use for complex, multi-file or design tasks. Exits (and restores the previous mode) only " +
      "after the user approves the plan.",
    inputSchema: z.object({}),
    isConcurrencySafe: true,
    async call(): Promise<ToolCallResult> {
      if (deps.getMode() === "plan") {
        return {
          result: "已在 plan 模式：用 exit_plan_mode 呈现计划，用户批准后自动恢复执行权限。",
        };
      }
      prePlanMode = deps.getMode();
      deps.setMode("plan");
      return {
        result:
          "已进入 plan 模式（只读）。现在只读探索代码库、考虑多种方案，然后用 exit_plan_mode " +
          "呈现计划。注意：plan 模式下写/改/执行一律被拒绝——DO NOT write, edit, or run commands.",
      };
    },
  };

  const exitSchema = z.object({
    plan: z.string().min(1).describe("The full plan you are presenting for user approval"),
  });

  const exit: Tool = {
    name: "exit_plan_mode",
    description:
      "Present a plan for user approval. Only usable in plan mode (entered via enter_plan_mode " +
      "or /plan). On approval the plan is saved to .run-agent/plans/ and the previous permission " +
      "mode is restored.",
    inputSchema: exitSchema,
    isConcurrencySafe: false,
    denyMessage:
      "用户拒绝了你的计划。立即停止当前工作，不要再次调用 enter_plan_mode 或 exit_plan_mode，" +
      "等待用户下一条指令；若用户有修改意见，按其指示调整后再重新呈现计划。",
    async call(input): Promise<ToolCallResult> {
      if (deps.getMode() !== "plan") {
        return {
          result:
            "不在 plan 模式：exit_plan_mode 仅用于在 plan 模式下呈现计划（先用 enter_plan_mode 或 /plan 进入）。",
        };
      }
      const { plan } = exitSchema.parse(input);
      const plansDir = deps.plansDir ?? path.join(process.cwd(), ".run-agent", "plans");
      const now = (deps.now ?? (() => new Date()))();
      const filePath = path.join(plansDir, `plan-${tsName(now)}.md`);
      mkdirSync(plansDir, { recursive: true });
      // 直写 plan 文件（系统行为，不经权限管线——`.run-agent` 危险目录对 agent 工具 deny，此处不冲突）
      writeFileSync(filePath, plan, "utf8");
      deps.setMode(prePlanMode);
      return {
        result: `用户已批准计划。\n计划已保存到 ${filePath}\n\n${plan}`,
        artifacts: [filePath],
      };
    },
  };

  return {
    tools: [enter, exit],
    enterPlanManually(): boolean {
      if (deps.getMode() === "plan") return false;
      prePlanMode = deps.getMode();
      deps.setMode("plan");
      return true;
    },
  };
}
