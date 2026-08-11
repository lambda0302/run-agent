/**
 * ask 决策的处理：可弹交互确认（仅 REPL + TTY）时询问 y/n/a；
 * 否则降级为 deny（绝不挂起）。"a"（始终允许）会写一条规则到 permissions.json。
 *
 * ask 由调用方注入（REPL 复用其唯一 readline 实例），避免在同一 stdin 上
 * 再建 readline 导致输入回显成多个字符（双 y / 三 y bug）。
 */
import * as readline from "node:readline";
import type { Tool } from "../tools.js";
import { addRule } from "./store.js";
import type { Decision, PermissionContext } from "./types.js";

/** 首次运行 Trust 对话：TTY 内询问是否信任当前项目。 */
export function askTrustProject(projectPath: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  return new Promise((resolve) => {
    rl.question(`\n是否信任此项目？ ${projectPath}\n[y=信任 / n=不信任] `, (a) => {
      rl.close();
      resolve(/^y/i.test(a.trim()));
    });
  });
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
): Promise<Decision> {
  if (!ctx.canPrompt) {
    return "deny"; // 非交互：由 CLI 输出拒绝原因
  }

  const desc = describe(input);
  const question = `\n允许 ${tool.name}${desc ? ` ${desc}` : ""}？ [y=本次允许 / n=拒绝 / a=始终允许] `;
  // 优先用调用方注入的 ask（REPL 复用同一 readline，杜绝双回显）；
  // 缺省时自行建临时 readline（仅测试/其它入口兜底）。
  const answer = ask
    ? await ask(question)
    : await new Promise<string>((resolve) => {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
          terminal: true,
        });
        rl.question(question, (a) => {
          rl.close();
          resolve(a);
        });
      });

  const a = answer.trim().toLowerCase();
  if (a === "a" || a === "always") {
    addRule({ tool: tool.name, action: "allow" });
    return "allow";
  }
  // 容忍旧版回显 bug 造成的连续 y（如 yy / yyy）：纯 y 串视为允许
  return a === "yes" || /^y+$/.test(a) ? "allow" : "deny";
}
