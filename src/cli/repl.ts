import * as readline from "node:readline";
import { COMPACT_MIN_MESSAGES, maybeAutoCompact } from "../core/compact.js";
import { buildSystemPrompt } from "../core/context.js";
import type { SystemContext } from "../core/context.js";
import { runQuery } from "../core/query.js";
import {
  hasPermissionsToUseTool,
  inputPath,
  isBuiltinReadOnlyTool,
} from "../permissions/engine.js";
import { resolveAsk } from "../permissions/prompt.js";
import type { Decision, PermissionContext } from "../permissions/types.js";
import type { LLMMessage, LLMClient } from "../providers/types.js";
import type { Tool } from "../tools.js";
import type { PlanTools } from "../tools/plan_mode.js";
import type { McpManager } from "../services/mcp/manager.js";
import { appendMessage } from "../utils/sessionStorage.js";

export interface AgentOptions {
  client: LLMClient;
  /** V5 决策 B3：工具池可为函数（每轮重建，MCP 工具按需连接后动态注入）。 */
  tools: Tool[] | (() => Tool[]);
  maxTokens?: number;
  sessionFile: string;
  /** 续接/初始上下文（--resume 时非空） */
  initialMessages?: LLMMessage[];
  out?: NodeJS.WritableStream;
  /** V2 权限上下文：REPL 用它构造 checkPermission（ask 复用本 REPL 的 readline） */
  ctx?: PermissionContext;
  /** 流式 transient 错误重试次数 */
  maxRetries?: number;
  /** V3 system 组装所需上下文；缺省不注入 system */
  systemCtx?: SystemContext;
  /** V3 上下文窗口（token 估算）；设了才启用自动压缩 */
  contextWindow?: number;
  /** V3 压缩发生时回调（REPL 用于提示） */
  onCompact?: () => void;
  /** V3 决策 8：超大工具结果落盘目录 */
  resultsDir?: string;
  /** V5 决策 A：plan 模式导航工具 + /plan 手动入口。one-shot 不传。 */
  planMode?: PlanTools;
  /** V5 决策 B2：MCP 连接管理器（/mcp 命令用；配置了 MCP server 才存在）。 */
  mcpManager?: McpManager;
  /** V5 决策 B4：只读判定闭包（并入 MCP readOnlyHint）；缺省 = 内置只读 ∪ explore。 */
  readOnlyNames?: (name: string) => boolean;
  /** 测试注入：readline 输入流（缺省 process.stdin）。生产不传。 */
  input?: NodeJS.ReadableStream;
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

/**
 * 输出缓冲门（0.5.1 显示修复）：权限弹窗期间缓冲 agent 输出，结束后按序刷出。
 * 流式并行下，弹窗前已入队的后台只读工具会在 rl.question 等待期间完成并打印结果，
 * 结果直接落在 y/n 提示行上——看起来像"卡住"或"输入被吞"。
 * 弹窗时流式循环阻塞在 await addTool → checkPermission → ask，缓冲量极小、成本可忽略。
 */
export function createOutputGate(out: NodeJS.WritableStream) {
  let buffer: string[] | null = null;
  return {
    emit: (s: string) => {
      if (buffer) buffer.push(s);
      else out.write(s);
    },
    /** 弹窗前调用：后续输出先入缓冲。 */
    begin: () => {
      buffer = [];
    },
    /** 弹窗结束后调用：按序刷出缓冲，恢复直写。 */
    end: () => {
      const buffered = buffer;
      buffer = null;
      if (buffered) for (const s of buffered) out.write(s);
    },
  };
}

/** 装配 agent 输出回调：全部经 emit（= 直写，或经输出门缓冲）。 */
export function createHandlers(emit: (s: string) => void) {
  return {
    onText: (t: string) => emit(t),
    onToolCall: (name: string, input: unknown) =>
      emit(`\n${CYAN}⚡ ${name}${RESET} ${formatInput(input)}\n`),
    onToolResult: (name: string, result: string) =>
      emit(`${DIM}└ ${name}: ${preview(result)}${RESET}\n`),
  };
}

/**
 * 组装 checkPermission：engine 判定 + 对 "ask" 弹交互确认。
 * @param ask 可注入的提问函数——REPL 传 rl.question 复用同一 readline（杜绝双回显）。
 *            不传则用 resolveAsk 的缺省路径（one-shot 时 canPrompt=false 直接 deny，不弹）。
 * @param readOnlyNames 只读判定闭包（V5 决策 B4）。缺省 = 内置只读 ∪ explore；
 *            CLI 装配时并入 MCP readOnlyHint 名（manager.isReadOnly）。plan 下 explore 也放行（内部只用只读工具）。
 */
export function makeCheckPermission(
  ctx: PermissionContext,
  out: NodeJS.WritableStream,
  ask?: (question: string) => Promise<string>,
  readOnlyNames?: (name: string) => boolean,
): (tool: Tool, input: unknown) => Promise<Decision> {
  const isReadOnlyName =
    readOnlyNames ?? ((name: string) => isBuiltinReadOnlyTool(name) || name === "explore");
  return async (tool, input) => {
    const d = hasPermissionsToUseTool(
      tool.name,
      input,
      ctx.mode,
      ctx.rules,
      ctx.isTrusted,
      ctx.cwd,
      isReadOnlyName,
    );
    if (d !== "ask") return d;
    const resolved = await resolveAsk(tool, input, ctx, ask);
    if (resolved === "deny") {
      const target = inputPath(input);
      const reason =
        ctx.mode === "plan" ? "plan 模式下只读：先调用 exit_plan_mode 呈现计划" : "未获授权";
      out.write(`✗ 已拒绝执行 ${tool.name}${target ? ` ${target}` : ""}（${reason}）\n`);
    }
    return resolved;
  };
}

/** 组装 runQuery 的公共选项（system/contextWindow/onCompact/...）。 */
function queryOpts(opts: AgentOptions, system: string | undefined) {
  return {
    client: opts.client,
    tools: opts.tools,
    ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
    ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
    ...(system ? { system } : {}),
    ...(opts.contextWindow ? { contextWindow: opts.contextWindow } : {}),
    ...(opts.onCompact ? { onCompact: opts.onCompact } : {}),
    ...(opts.resultsDir ? { resultsDir: opts.resultsDir } : {}),
  };
}

/** 单次执行：读 prompt → 工具循环 → 返回最终回复文本。 */
export async function runOneShot(opts: AgentOptions, prompt: string): Promise<string> {
  const out = opts.out ?? process.stdout;
  const messages: LLMMessage[] = [...(opts.initialMessages ?? [])];
  messages.push({ role: "user", content: prompt });
  await appendMessage(opts.sessionFile, messages[messages.length - 1]!);

  const system = opts.systemCtx ? await buildSystemPrompt(opts.systemCtx) : undefined;
  const checkPermission = opts.ctx
    ? makeCheckPermission(opts.ctx, out, undefined, opts.readOnlyNames)
    : undefined;
  const result = await runQuery(messages, {
    ...queryOpts(opts, system),
    ...(checkPermission ? { checkPermission } : {}),
    ...createHandlers((s: string) => out.write(s)),
  });
  out.write("\n");

  // added 契约：只持久化本轮回调新增的消息
  for (const m of result.added) {
    await appendMessage(opts.sessionFile, m);
  }
  return result.reply;
}

const HELP = [
  "run-agent REPL — 直接输入 prompt 开始，agent 会读/写/改/搜/执行并汇报。",
  "  命令: /clear 清空上下文 · /compact 压缩上下文 · /plan 进入只读计划模式 · /mcp 查看/连接 MCP server · /help 帮助 · /exit 退出",
].join("\n");

/** 交互式 REPL 主循环。 */
export async function runRepl(opts: AgentOptions): Promise<void> {
  const out = opts.out ?? process.stdout;
  let messages: LLMMessage[] = [...(opts.initialMessages ?? [])];
  const terminal = Boolean(process.stdin.isTTY);

  const rl = readline.createInterface({
    input: opts.input ?? process.stdin,
    output: out,
    terminal,
  });
  const gate = createOutputGate(out);
  const handlers = createHandlers(gate.emit);

  // 权限确认复用本 REPL 的同一 readline（在 stdin 上再建 interface 是双回显 bug 的根因）
  // 弹窗开始前打开输出门：后台并行工具的结果先缓冲，答完刷出，不污染 y/n 提示行（0.5.1 显示修复）
  const ask = (q: string) => {
    gate.begin();
    return new Promise<string>((resolve) =>
      rl.question(q, (answer) => {
        gate.end();
        resolve(answer);
      }),
    );
  };
  const checkPermission = opts.ctx
    ? makeCheckPermission(opts.ctx, out, ask, opts.readOnlyNames)
    : undefined;

  rl.on("SIGINT", () => {
    out.write("\n");
    rl.close();
  });
  rl.on("close", () => {
    // 结束
  });

  if (messages.length > 0) out.write(`${DIM}已续接 ${messages.length} 条历史消息${RESET}\n`);

  const promptLine = () => {
    // readline 已关（stdin EOF / Ctrl-D / /exit）后不再 prompt——异步命令处理期间输入
    // 可能已 EOF（测试注入的流尤其如此），此时 rl.prompt() 会抛 "readline was closed"
    if ((rl as unknown as { closed: boolean }).closed) return;
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
      // V5 决策 B2：/mcp 前缀子命令在 switch 之前处理（switch 是严格相等，`/mcp connect x`
      // 无法命中 case "/mcp"）
      if (input === "/mcp" || input.startsWith("/mcp ")) {
        const mgr = opts.mcpManager;
        if (!mgr) {
          out.write(
            "未配置 MCP server（~/.config/run-agent/mcp.json 或受信任项目的 .run-agent/mcp.json）\n",
          );
          promptLine();
          return;
        }
        if (input.startsWith("/mcp connect ")) {
          const server = input.slice("/mcp connect ".length).trim();
          if (!server) {
            out.write("用法: /mcp connect <server>\n");
            promptLine();
            return;
          }
          const res = await mgr.connect(server);
          if (!res.ok) {
            out.write(`✗ ${res.error}\n`);
            promptLine();
            return;
          }
          out.write(`✓ 已连接 ${server}，注册 ${res.tools.length} 个工具\n`);
          promptLine();
          return;
        }
        const names = mgr.serverNames();
        if (names.length === 0) {
          out.write("未配置 MCP server\n");
          promptLine();
          return;
        }
        const icons: Record<string, string> = {
          connected: "✓",
          failed: "✗",
          "needs-auth": "🔑",
          disabled: "⛔",
        };
        const lines = mgr.getStatuses().map(({ name, status, error }) => {
          const icon = icons[status] ?? "?";
          return `  ${icon} ${name} (${status})${error ? ` — ${error}` : ""}`;
        });
        out.write(`MCP servers:\n${lines.join("\n")}\n`);
        promptLine();
        return;
      }

      switch (input) {
        case "/exit":
        case "/quit":
          rl.close();
          return;
        case "/clear":
          messages.length = 0;
          out.write("已清空上下文\n");
          break;
        case "/compact": {
          if (!opts.contextWindow) {
            out.write("未配置 contextWindow（--context-window <n> 或 config），无法压缩\n");
            break;
          }
          if (messages.length < COMPACT_MIN_MESSAGES) {
            out.write("历史过短，无需压缩\n");
            break;
          }
          // 手动触发主动压缩：整段摘要 → 单边界消息 → 持久化边界
          const system = opts.systemCtx ? await buildSystemPrompt(opts.systemCtx) : undefined;
          const res = await maybeAutoCompact(messages, {
            client: opts.client,
            tools: typeof opts.tools === "function" ? opts.tools() : opts.tools,
            ...(system !== undefined ? { system } : {}),
            contextWindow: opts.contextWindow,
          });
          if (!res.compacted) {
            out.write("上下文未超阈值，无需压缩\n");
            break;
          }
          messages = res.messages;
          await appendMessage(opts.sessionFile, res.messages[0]!);
          opts.onCompact?.();
          out.write("已压缩上下文（边界消息已持久化，--resume 将从摘要续起）\n");
          break;
        }
        case "/plan": {
          // V5 决策 A5：手动兜底入口——直接进 plan（不经模型判断），与 enter_plan_mode 共用状态机
          if (!opts.planMode) {
            out.write("当前会话不支持 plan 模式（仅交互 REPL）\n");
            break;
          }
          if (!opts.planMode.enterPlanManually()) {
            out.write("已在 plan 模式：用 exit_plan_mode 呈现计划，批准后自动恢复\n");
            break;
          }
          out.write(
            "已进入 plan 模式（只读）：让模型只读探索，用 exit_plan_mode 呈现计划；批准后自动恢复执行权限。\n",
          );
          break;
        }
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

    // 每轮重建 system（日期/git 动态部分刷新；git 有 3s TTL 缓存）
    const system = opts.systemCtx ? await buildSystemPrompt(opts.systemCtx) : undefined;
    const result = await runQuery(messages, {
      ...queryOpts(opts, system),
      ...(checkPermission ? { checkPermission } : {}),
      ...handlers,
    });
    out.write("\n");

    // added 契约 + 数组替换：compact 可能重建消息数组，slice 已不可靠
    messages = result.messages;
    for (const m of result.added) {
      await appendMessage(opts.sessionFile, m);
    }
    // 清晰的任务完成分隔线：明确一轮已结束，避免“任务完成后输入 y 被当成新 prompt 又跑一遍”
    out.write(
      `${GREEN}${DIVIDER}${RESET}\n${GREEN}✔ 任务完成${RESET}${DIM} — 可继续输入下一条 prompt（/exit 退出）${RESET}\n${GREEN}${DIVIDER}${RESET}\n`,
    );
    promptLine();
  });
}
