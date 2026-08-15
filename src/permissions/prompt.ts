/**
 * ask 决策的处理：可弹交互确认（仅 REPL + TTY）时用方向键菜单选择；
 * 否则降级为 deny（绝不挂起）。"a"（始终允许）会写一条规则到 permissions.json。
 *
 * V8 决策 I：exit_plan_mode 的弹窗多一项「编辑后批准」——打开系统编辑器改计划文件，
 * 内容有变则批准时经 updatedInput 把新计划 + planWasEdited 透传给工具（模型据此知道
 * 计划被改过，对齐 CC CCR updatedInput 语义）。
 *
 * ask 由调用方注入（REPL 复用其唯一 readline 实例，见 select.ts 的 rl 静音协作），
 * 避免在同一 stdin 上再建 readline 导致输入回显成多个字符（双 y / 三 y bug）。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PermissionCheckResult } from "../core/execute.js";
import type { Tool } from "../tools.js";
import { promptSelect } from "../ui/select.js";
import type { SelectOption } from "../ui/select.js";
import { inputPath, pathInCwd } from "./engine.js";
import { addRule } from "./store.js";
import type { PermissionContext } from "./types.js";

/** 权限确认三项菜单（与 resolveAsk 的 y/a/n 分支对应；REPL 与缺省路径共用）。 */
export const ANSWER_OPTIONS: SelectOption<string>[] = [
  { label: "允许（本次执行）", value: "y" },
  { label: "允许并始终记住（写入规则）", value: "a" },
  { label: "拒绝", value: "n" },
];

/** V8 决策 I：exit_plan_mode 的四项菜单（比普通确认多「编辑后批准」）。 */
export const EXIT_OPTIONS: SelectOption<string>[] = [
  { label: "批准计划", value: "y" },
  { label: "编辑后批准", value: "e" },
  { label: "拒绝", value: "n" },
  { label: "批准并始终记住（写入规则）", value: "a" },
];

/** 首次运行 Trust 对话：TTY 内询问是否信任当前项目（V8 起为方向键菜单）。 */
export async function askTrustProject(projectPath: string): Promise<boolean> {
  process.stdout.write(`\n是否信任此项目？ ${projectPath}\n`);
  const choice = await promptSelect<boolean>(
    [
      { label: "信任此项目", value: true },
      { label: "不信任", value: false },
    ],
    { out: process.stdout, input: process.stdin },
  );
  return choice ?? false; // Escape 取消 → 不信任
}

function describe(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof o.file_path === "string") parts.push(o.file_path);
  else if (typeof o.path === "string") parts.push(o.path);
  if (typeof o.command === "string") parts.push(`\`${o.command.slice(0, 100)}\``);
  return parts.join(" ");
}

/** 读文件内容；不存在/不可读/空 → undefined（编辑器「编辑后批准」的编辑前快照）。 */
function safeRead(p: string): string | undefined {
  try {
    const s = readFileSync(p, "utf8");
    return s ? s : undefined;
  } catch {
    return undefined;
  }
}

/**
 * V8 决策 I：「编辑后批准」——仅 exit_plan_mode。用系统编辑器打开计划文件，
 * 等待关闭后重读；与编辑前快照比对：有变化 → 批准并携带 { plan: 新内容, planWasEdited: true }；
 * 无变化 → 仍批准（updatedInput 带当前内容，planWasEdited 不置位）。
 * 编辑器不可用 / 计划文件无法定位 / 编辑器取消或失败 → deny（保守，不静默批准）。
 */
async function editThenApprove(
  tool: Tool,
  input: unknown,
  ctx: PermissionContext,
  openEditor: (filePath: string) => Promise<string | undefined>,
): Promise<PermissionCheckResult> {
  if (tool.name !== "exit_plan_mode") return "deny"; // 编辑后批准只对计划审批有意义
  const filePath = ctx.planFilePath;
  if (!filePath) return "deny"; // 无法定位计划文件（未进入 plan / 无 onEnter 装配）
  // 编辑前快照：文件已存在就读；不存在则把当前 plan 入参先落盘，让编辑器有内容可改
  let before = safeRead(filePath);
  if (before === undefined) {
    const inline = (input as Record<string, unknown>).plan;
    if (typeof inline !== "string" || !inline.trim()) return "deny"; // 无内容可编辑
    try {
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, inline, "utf8");
      before = inline;
    } catch {
      return "deny";
    }
  }
  const after = await openEditor(filePath);
  if (after === undefined) return "deny"; // 编辑器取消/失败 → 拒绝（保守）
  if (after !== before) {
    return { decision: "allow", updatedInput: { plan: after, planWasEdited: true } };
  }
  return { decision: "allow", updatedInput: { plan: after } };
}

export async function resolveAsk(
  tool: Tool,
  input: unknown,
  ctx: PermissionContext,
  ask?: (question: string, options?: SelectOption<string>[]) => Promise<string>,
  source?: string,
  openEditor?: (filePath: string) => Promise<string | undefined>,
): Promise<PermissionCheckResult> {
  if (!ctx.canPrompt) {
    return "deny"; // 非交互：由 CLI 输出拒绝原因
  }

  const desc = describe(input);
  // V4.5 决策 B：路径在允许的工作目录之外时提示（唯一合法通道 = 用户 allow 规则）
  const p = inputPath(input);
  const outsideCwd = p !== undefined && !pathInCwd(p, ctx.cwd);
  const note = outsideCwd ? "（该路径在允许的工作目录之外，如需放行请配置 allow 规则）" : "";
  // 来源标签：子 agent（前台）的权限申请由 agent 工具包 wrap 注入，弹窗可直接分辨"谁在问"
  const who = source ? `[${source}] ` : "";
  // V8 决策 I：exit_plan_mode 的弹窗多一项「编辑后批准」
  const isExit = tool.name === "exit_plan_mode";
  const question = `\n${who}允许 ${tool.name}${desc ? ` ${desc}` : ""}${note}？ [y=${isExit ? "批准计划" : "本次允许"} / n=拒绝 / a=始终允许${isExit ? " / e=编辑后批准" : ""}] `;
  // 优先用调用方注入的 ask（REPL 复用同一 readline 的方向键菜单，杜绝双回显）；
  // 缺省时自建 promptSelect（仅测试/其它入口兜底）。
  const options = isExit ? EXIT_OPTIONS : ANSWER_OPTIONS;
  const answer = ask
    ? await ask(question, options)
    : await promptSelect<string>(options, { out: process.stdout, input: process.stdin });

  const a = (answer ?? "n").trim().toLowerCase(); // Escape 取消 → 拒绝
  if (a === "a" || a === "always") {
    addRule({ tool: tool.name, action: "allow" });
    return "allow";
  }
  if (a === "e" || a === "edit") {
    if (openEditor) return editThenApprove(tool, input, ctx, openEditor);
    return "deny"; // 无编辑器注入（headless/测试）→ 拒绝（保守）
  }
  // 容忍旧版回显 bug 造成的连续 y（如 yy / yyy）：纯 y 串视为允许
  return a === "yes" || /^y+$/.test(a) ? "allow" : "deny";
}
