/**
 * V5 决策 A：Plan 模式导航工具（enter_plan_mode / exit_plan_mode，同文件工厂装配）。
 * - enter_plan_mode：无入参，把当前权限模式切到 "plan"（强制只读）。校验：已在 plan 时报错。
 * - exit_plan_mode：把计划直写到 <cwd>/.run-agent/plans/plan-<ts>.md（系统行为，不经权限
 *   管线——参考实现 ExitPlanModeV2Tool 同样直写），恢复进入 plan 前的权限模式，
 *   返回「用户已批准 + plan 全文 + 文件路径」（/compact 后的上下文重建也能看到计划）。
 * 用户审批不在此处：engine 的 plan 分支对 exit_plan_mode 返回 ask，由 repl 的 makeCheckPermission
 * → resolveAsk 弹窗负责（one-shot 不装配本工具，无弹窗，防死锁）。
 *
 * V8 决策 G（计划文件前置）：进入 plan 即确定计划文件路径（planFilePath，未落盘——首次写盘才
 * 建文件，G4）。模型 plan 期间可用 write_file/edit_file 增量打磨该文件（engine 精确文件豁免，
 * 见 engine.ts 步骤 4.5）；exit_plan_mode 的 plan 入参变可选覆盖、缺省读盘。批准时文件即最终计划。
 *
 * prePlanMode / planFilePath 存工厂闭包（单会话单实例，天然安全）；/plan 手动入口与
 * enter_plan_mode 共用同一状态机（决策 A5）——两者都通过本工厂的 enter 记录 prePlanMode
 * 并确定 planFilePath（经 onEnter 回调给 cli 写入 ctx.planFilePath，供引擎豁免/审批编辑使用）。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  /** V8 决策 G：进入 plan 时回调，携带确定好的计划文件路径（cli 写入 ctx.planFilePath，
   *  供引擎 plan 文件豁免 + 审批弹窗「编辑后批准」定位文件）。 */
  onEnter?: (planFilePath: string) => void;
}

/** 工厂返回值：工具列表 + /plan 手动入口（共享 prePlanMode 闭包）+ 计划文件路径查询。 */
export interface PlanTools {
  tools: Tool[];
  /** /plan 手动进入：已在 plan 返回 false；否则记录 prePlanMode 并 setMode("plan")。 */
  enterPlanManually(): boolean;
  /** V8 决策 G：当前 plan 会话的计划文件路径（进入 plan 后确定；未进入时 undefined）。 */
  getPlanFilePath(): string | undefined;
}

/** plan 文件名时间戳：ISO 去掉冒号/句点（文件系统安全）。 */
function tsName(d: Date): string {
  return d.toISOString().replace(/[:.]/g, "-");
}

export function makePlanTools(deps: PlanModeOptions): PlanTools {
  // 进入 plan 前的权限模式（enter_plan_mode 与 /plan 手动入口共用，决策 A5）
  let prePlanMode: PermissionMode = "default";
  // V8 决策 G：当前 plan 会话的计划文件路径（进入 plan 时确定；exit 后保留但已被新路径取代）
  let planFilePath: string | undefined;

  const resolvePlanFilePath = (): string => {
    const plansDir = deps.plansDir ?? path.join(process.cwd(), ".run-agent", "plans");
    const now = (deps.now ?? (() => new Date()))();
    return path.join(plansDir, `plan-${tsName(now)}.md`);
  };

  /** 进入 plan 的公共状态机（工具路径与 /plan 手动入口共用）：记录 prePlanMode + 确定文件路径。 */
  const doEnter = (): { entered: boolean; filePath?: string } => {
    if (deps.getMode() === "plan") return { entered: false };
    prePlanMode = deps.getMode();
    planFilePath = resolvePlanFilePath();
    deps.setMode("plan");
    deps.onEnter?.(planFilePath);
    return { entered: true, filePath: planFilePath };
  };

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
      const { entered, filePath } = doEnter();
      if (!entered) {
        return {
          result: "已在 plan 模式：用 exit_plan_mode 呈现计划，用户批准后自动恢复执行权限。",
        };
      }
      return {
        result:
          `已进入 plan 模式（只读）。计划文件路径: ${filePath}\n` +
          "现在只读探索代码库、考虑多种方案；可用 write_file/edit_file 增量打磨计划文件，准备就绪后 " +
          "用 exit_plan_mode 呈现计划。注意：plan 模式下写/改/执行一律被拒绝——DO NOT write, edit, or run commands.",
      };
    },
  };

  const exitSchema = z.object({
    plan: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The full plan text to present for approval. Optional: if omitted, the current plan file " +
          "(returned by enter_plan_mode) is read as the plan.",
      ),
    planWasEdited: z
      .boolean()
      .optional()
      .describe(
        "True when the user edited the plan during approval (set by the approval dialog). " +
          "Used to label the approved plan as user-edited.",
      ),
  });

  const exit: Tool = {
    name: "exit_plan_mode",
    description:
      "Present a plan for user approval. Only usable in plan mode (entered via enter_plan_mode " +
      "or /plan). On approval the plan is saved to .run-agent/plans/ and the previous permission " +
      "mode is restored. The plan comes from the plan file by default; pass `plan` to override.",
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
      const { plan: planOverride, planWasEdited } = exitSchema.parse(input);
      const filePath = planFilePath ?? resolvePlanFilePath();
      let plan: string;
      if (planOverride !== undefined) {
        // 覆盖写盘：有显式 plan 入参 → 直接采用（批准时落盘，文件首次写即建）
        plan = planOverride;
        mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileSync(filePath, plan, "utf8");
      } else {
        // 缺省读盘：计划文件是最终计划（模型 plan 期间 write/edit 增量打磨的产物）
        try {
          plan = readFileSync(filePath, "utf8");
        } catch {
          return {
            result:
              `计划文件不存在或不可读: ${filePath}\n` +
              "请先调用 write_file 把计划写入该文件（或直接传 plan 入参）。",
          };
        }
        if (!plan.trim()) {
          return {
            result:
              `计划文件为空: ${filePath}\n` +
              "请先调用 write_file 写入计划内容（或直接传 plan 入参）。",
          };
        }
      }
      deps.setMode(prePlanMode);
      return {
        result: `用户已批准计划${planWasEdited === true ? "（用户已编辑）" : ""}。\n计划已保存到 ${filePath}\n\n${plan}`,
        artifacts: [filePath],
      };
    },
  };

  return {
    tools: [enter, exit],
    enterPlanManually(): boolean {
      return doEnter().entered;
    },
    getPlanFilePath: () => planFilePath,
  };
}
