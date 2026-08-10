/**
 * ask 决策的处理：可弹交互确认（仅 REPL + TTY）时询问 y/n/a；
 * 否则降级为 deny（绝不挂起）。"a"（始终允许）会写一条规则到 permissions.json。
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
): Promise<Decision> {
  if (!ctx.canPrompt) {
    return "deny"; // 非交互：由 CLI 输出拒绝原因
  }

  const desc = describe(input);
  const question = `\n允许 ${tool.name}${desc ? ` ${desc}` : ""}？ [y=本次允许 / n=拒绝 / a=始终允许] `;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
  rl.close();

  const a = answer.trim().toLowerCase();
  if (a === "a" || a === "always") {
    addRule({ tool: tool.name, action: "allow" });
    return "allow";
  }
  return a === "y" || a === "yes" ? "allow" : "deny";
}
