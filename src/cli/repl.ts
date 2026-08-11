import * as readline from "node:readline";
import { runQuery } from "../core/query.js";
import { hasPermissionsToUseTool, inputPath } from "../permissions/engine.js";
import { resolveAsk } from "../permissions/prompt.js";
import type { Decision, PermissionContext } from "../permissions/types.js";
import type { LLMMessage, LLMClient } from "../providers/types.js";
import type { Tool } from "../tools.js";
import { appendMessage } from "../utils/sessionStorage.js";

export interface AgentOptions {
  client: LLMClient;
  tools: Tool[];
  maxTokens?: number;
  sessionFile: string;
  /** 续接/初始上下文（--resume 时非空） */
  initialMessages?: LLMMessage[];
  out?: NodeJS.WritableStream;
  /** V2 权限上下文：REPL 用它构造 checkPermission（ask 复用本 REPL 的 readline） */
  ctx?: PermissionContext;
  /** 流式 transient 错误重试次数 */
  maxRetries?: number;
}

const DIM = "\x1b[90m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";
const DIVIDER = "─".repeat(60);

/** 工具入参打印：JSON 化并截断，避免刷屏。 */
function formatInput(input: unknown): string {
  let s = JSON.stringify(input);
  if (!s) s = String(input);
  return s.length > 200 ? s.slice(0, 200) + "…" : s;
}

/** 工具结果打印：只取第一行并截断。 */
function preview(result: string): string {
  const first = result.split("\n")[0] ?? "";
  return first.length > 120 ? first.slice(0, 120) + "…" : first;
}

function createHandlers(out: NodeJS.WritableStream) {
  return {
    onText: (t: string) => out.write(t),
    onToolCall: (name: string, input: unknown) =>
      out.write(`\n${CYAN}⚡ ${name}${RESET} ${formatInput(input)}\n`),
    onToolResult: (name: string, result: string) =>
      out.write(`${DIM}└ ${name}: ${preview(result)}${RESET}\n`),
  };
}

/**
 * 组装 checkPermission：engine 判定 + 对 "ask" 弹交互确认。
 * @param ask 可注入的提问函数——REPL 传 rl.question 复用同一 readline（杜绝双回显）。
 *            不传则用 resolveAsk 的缺省路径（one-shot 时 canPrompt=false 直接 deny，不弹）。
 */
export function makeCheckPermission(
  ctx: PermissionContext,
  out: NodeJS.WritableStream,
  ask?: (question: string) => Promise<string>,
): (tool: Tool, input: unknown) => Promise<Decision> {
  return async (tool, input) => {
    const d = hasPermissionsToUseTool(tool.name, input, ctx.mode, ctx.rules);
    if (d !== "ask") return d;
    const resolved = await resolveAsk(tool, input, ctx, ask);
    if (resolved === "deny") {
      const target = inputPath(input);
      out.write(`✗ 已拒绝执行 ${tool.name}${target ? ` ${target}` : ""}（未获授权）\n`);
    }
    return resolved;
  };
}

/** 单次执行：读 prompt → 工具循环 → 返回最终回复文本。 */
export async function runOneShot(opts: AgentOptions, prompt: string): Promise<string> {
  const out = opts.out ?? process.stdout;
  const messages: LLMMessage[] = [...(opts.initialMessages ?? [])];
  messages.push({ role: "user", content: prompt });
  await appendMessage(opts.sessionFile, messages[messages.length - 1]!);

  const checkPermission = opts.ctx ? makeCheckPermission(opts.ctx, out) : undefined;
  const before = messages.length;
  const result = await runQuery(messages, {
    client: opts.client,
    tools: opts.tools,
    ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
    ...(checkPermission ? { checkPermission } : {}),
    ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
    ...createHandlers(out),
  });
  out.write("\n");

  for (const m of result.messages.slice(before)) {
    await appendMessage(opts.sessionFile, m);
  }
  return result.reply;
}

const HELP = [
  "run-agent REPL — 直接输入 prompt 开始，agent 会读/写/改/搜/执行并汇报。",
  "  命令: /clear 清空上下文 · /help 帮助 · /exit 退出",
].join("\n");

/** 交互式 REPL 主循环。 */
export async function runRepl(opts: AgentOptions): Promise<void> {
  const out = opts.out ?? process.stdout;
  const messages: LLMMessage[] = [...(opts.initialMessages ?? [])];
  const terminal = Boolean(process.stdin.isTTY);

  const rl = readline.createInterface({
    input: process.stdin,
    output: out,
    terminal,
  });
  const handlers = createHandlers(out);

  // 权限确认复用本 REPL 的同一 readline（在 stdin 上再建 interface 是双回显 bug 的根因）
  const ask = (q: string) => new Promise<string>((resolve) => rl.question(q, resolve));
  const checkPermission = opts.ctx ? makeCheckPermission(opts.ctx, out, ask) : undefined;

  rl.on("SIGINT", () => {
    out.write("\n");
    rl.close();
  });
  rl.on("close", () => {
    // 结束
  });

  if (messages.length > 0) out.write(`${DIM}已续接 ${messages.length} 条历史消息${RESET}\n`);

  const promptLine = () => {
    rl.prompt();
  };
  rl.setPrompt("run-agent> ");
  promptLine();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) {
      promptLine();
      return;
    }
    if (input.startsWith("/")) {
      switch (input) {
        case "/exit":
        case "/quit":
          rl.close();
          return;
        case "/clear":
          messages.length = 0;
          out.write("已清空上下文\n");
          break;
        case "/help":
          out.write(`${HELP}\n`);
          break;
        default:
          out.write(`未知命令: ${input}（/help 查看）\n`);
      }
      promptLine();
      return;
    }

    messages.push({ role: "user", content: input });
    await appendMessage(opts.sessionFile, messages[messages.length - 1]!);

    const before = messages.length;
    const result = await runQuery(messages, {
      client: opts.client,
      tools: opts.tools,
      ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
      ...(checkPermission ? { checkPermission } : {}),
      ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
      ...handlers,
    });
    out.write("\n");

    for (const m of result.messages.slice(before)) {
      await appendMessage(opts.sessionFile, m);
    }
    // 清晰的任务完成分隔线：明确一轮已结束，避免“任务完成后输入 y 被当成新 prompt 又跑一遍”
    out.write(
      `${GREEN}${DIVIDER}${RESET}\n${GREEN}✔ 任务完成${RESET}${DIM} — 可继续输入下一条 prompt（/exit 退出）${RESET}\n${GREEN}${DIVIDER}${RESET}\n`,
    );
    promptLine();
  });
}
