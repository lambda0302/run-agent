import * as readline from "node:readline";
import { runQuery } from "../core/query.js";
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
}

const DIM = "\x1b[90m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

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

/** 单次执行：读 prompt → 工具循环 → 返回最终回复文本。 */
export async function runOneShot(opts: AgentOptions, prompt: string): Promise<string> {
  const out = opts.out ?? process.stdout;
  const messages: LLMMessage[] = [...(opts.initialMessages ?? [])];
  messages.push({ role: "user", content: prompt });
  await appendMessage(opts.sessionFile, messages[messages.length - 1]!);

  const before = messages.length;
  const result = await runQuery(messages, {
    client: opts.client,
    tools: opts.tools,
    ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
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
      ...handlers,
    });
    out.write("\n");

    for (const m of result.messages.slice(before)) {
      await appendMessage(opts.sessionFile, m);
    }
    promptLine();
  });
}
