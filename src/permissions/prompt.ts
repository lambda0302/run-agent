/**
 * ask 决策的处理：可弹交互确认（仅 REPL + TTY）时用方向键菜单选择；
 * 否则降级为 deny（绝不挂起）。"a"（始终允许）会写一条规则到 permissions.json。
 *
 * ask 由调用方注入（REPL 复用其唯一 readline 实例，见 select.ts 的 rl 静音协作），
 * 避免在同一 stdin 上再建 readline 导致输入回显成多个字符（双 y / 三 y bug）。
 */
import type { Tool } from "../tools.js";
import { promptSelect } from "../ui/select.js";
import type { SelectOption } from "../ui/select.js";
import { inputPath, pathInCwd } from "./engine.js";
import { addRule } from "./store.js";
import type { Decision, PermissionContext } from "./types.js";

/** 权限确认三项菜单（与 resolveAsk 的 y/a/n 分支对应；REPL 与缺省路径共用）。 */
const ANSWER_OPTIONS: SelectOption<string>[] = [
  { label: "允许（本次执行）", value: "y" },
  { label: "允许并始终记住（写入规则）", value: "a" },
  { label: "拒绝", value: "n" },
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

export async function resolveAsk(
  tool: Tool,
  input: unknown,
  ctx: PermissionContext,
  ask?: (question: string) => Promise<string>,
  source?: string,
): Promise<Decision> {
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
  const question = `\n${who}允许 ${tool.name}${desc ? ` ${desc}` : ""}${note}？ [y=本次允许 / n=拒绝 / a=始终允许] `;
  // 优先用调用方注入的 ask（REPL 复用同一 readline 的方向键菜单，杜绝双回显）；
  // 缺省时自建 promptSelect（仅测试/其它入口兜底）。
  const answer = ask
    ? await ask(question)
    : await promptSelect<string>(ANSWER_OPTIONS, { out: process.stdout, input: process.stdin });

  const a = (answer ?? "n").trim().toLowerCase(); // Escape 取消 → 拒绝
  if (a === "a" || a === "always") {
    addRule({ tool: tool.name, action: "allow" });
    return "allow";
  }
  // 容忍旧版回显 bug 造成的连续 y（如 yy / yyy）：纯 y 串视为允许
  return a === "yes" || /^y+$/.test(a) ? "allow" : "deny";
}
