import * as readline from "node:readline";
import { COMPACT_MIN_MESSAGES, maybeAutoCompact } from "../core/compact.js";
import {
  DYNAMIC_CONTEXT_MARKER,
  buildDynamicContext,
  buildSystemPrompt,
} from "../core/context.js";
import type { SystemContext } from "../core/context.js";
import { decisionOf } from "../core/execute.js";
import type { PermissionCheckResult } from "../core/execute.js";
import { runQuery } from "../core/query.js";
import type { RunQueryResult } from "../core/query.js";
import type { PermissionBridge } from "../core/run_agent.js";
import type { BackgroundTaskManager } from "../services/agents/team/registry.js";
import type { ExtractMemoriesEngine } from "../services/extract/extract.js";
import {
  hasPermissionsToUseTool,
  inputPath,
  isBuiltinReadOnlyTool,
} from "../permissions/engine.js";
import { ANSWER_OPTIONS, resolveAsk } from "../permissions/prompt.js";
import type { PermissionContext } from "../permissions/types.js";
import type { LLMMessage, LLMClient } from "../providers/types.js";
import type { Tool } from "../tools.js";
import type { PlanTools } from "../tools/plan_mode.js";
import type { McpManager } from "../services/mcp/manager.js";
import type { HookManager, PreToolUseDecision } from "../services/hooks/manager.js";
import { readSkillBody } from "../services/skills/loader.js";
import type { SkillRegistry } from "../services/skills/skill_tool.js";
import type { CommandRegistry } from "../services/commands/loader.js";
import { expandPromptTemplate, execLocalCommand } from "../services/commands/exec.js";
import {
  appendMessage,
  listSessions,
  loadSession,
  sessionIdTime,
  sessionsDir,
} from "../utils/sessionStorage.js";
import { promptSelect } from "../ui/select.js";
import type { SelectOption } from "../ui/select.js";
import { openSystemEditor } from "../utils/editor.js";

// 定位 readline 内部"已从流里读出、还没触发行事件"的残留（无换行收尾的末行）。
// Node 20/22 是 `_line` 字符串字段；Node 24 起改 `Symbol(_line_buffer)`。公共 getter
// `rl.line` 在事件触发瞬间已被置空、不可用，只能直接摸内部字段。找不到字段 → 返回 ""
// （该版本退化为旧的 inputBuf.length>=2 行为，无回归）。
function readlineTail(rl: readline.Interface): string {
  const anyRl = rl as unknown as Record<PropertyKey, unknown>;
  const direct = anyRl["_line"];
  if (typeof direct === "string" && direct.length > 0) return direct;
  const sym = Object.getOwnPropertySymbols(rl).find((s) => s.description === "_line_buffer");
  if (sym) {
    const v = anyRl[sym];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "";
}

export interface AgentOptions {
  client: LLMClient;
  /** V5 决策 B3：工具池可为函数（每轮重建，MCP 工具预连后动态注入）。 */
  tools: Tool[] | (() => Tool[]);
  maxTokens?: number;
  /** V6 决策 D：ReAct 循环轮数上限（--max-turns），防 CI 失控；缺省 = 25。 */
  maxIterations?: number;
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
  /** V6 决策 A：HookManager（配置了 hooks 才存在；零配置不创建）。 */
  hookManager?: HookManager;
  /** V6 决策 B：技能注册表（有技能才存在）。装配 SkillTool + /skills、/<技能名> 斜杠命令。 */
  skillRegistry?: SkillRegistry;
  /** V6 决策 C：自定义命令注册表（有命令才存在）。装配 /commands、/<命令名> 斜杠命令。 */
  commands?: CommandRegistry;
  /** 测试注入：readline 输入流（缺省 process.stdin）。生产不传。 */
  input?: NodeJS.ReadableStream;
  /** V7 决策 A6：后台任务注册表（agent 工具 run_in_background + /tasks 查看）。交互 REPL 才装配。 */
  backgroundTasks?: BackgroundTaskManager;
  /** V7 决策 A4：权限桥——本文件构造完 checkPermission 后写入，agent 工具的子查询读取。 */
  permissionBridge?: PermissionBridge;
  /** V7 决策 E：后台记忆提取引擎（仅 Trust 且非 bare 装配）；每完整 query loop 结束 fire-and-forget 触发。 */
  extractMemories?: ExtractMemoriesEngine;
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
 * 组装 checkPermission：engine 判定 → PreToolUse hook 覆盖 → 对 "ask" 弹交互确认。
 * @param ask 可注入的提问函数——REPL 传 rl.question 复用同一 readline（杜绝双回显）。
 *            不传则用 resolveAsk 的缺省路径（one-shot 时 canPrompt=false 直接 deny，不弹）。
 * @param readOnlyNames 只读判定闭包（V5 决策 B4）。缺省 = 内置只读 ∪ explore ∪ agent；
 *            CLI 装配时并入 MCP readOnlyHint 名（manager.isReadOnly）。plan 下 explore/agent 也放行
 *            （explore 内部只用只读工具；agent 的 ask 会由内部子查询引擎降级 deny，绝不弹窗）。
 * @param preToolUse V6 决策 A4：PreToolUse hook 回调（HookManager.onPreToolUse）。
 *            engine 判定后执行；hook 决策可覆盖（ask→allow / allow→deny / ask→deny），
 *            但 engine deny 是硬底线不可被 hook 放行。hook deny 的 reason 并入拒绝回填。
 * @param openEditor V8 决策 I（#3）：系统编辑器注入——resolveAsk 的「编辑后批准」（exit_plan_mode
 *            弹窗多一项 e）用它打开 ctx.planFilePath 让用户改计划。headless/测试不注入。
 */
export function makeCheckPermission(
  ctx: PermissionContext,
  out: NodeJS.WritableStream,
  ask?: (question: string, options?: SelectOption<string>[]) => Promise<string>,
  readOnlyNames?: (name: string) => boolean,
  preToolUse?: (name: string, input: unknown) => Promise<PreToolUseDecision | undefined>,
  openEditor?: (filePath: string) => Promise<string | undefined>,
): (tool: Tool, input: unknown, source?: string) => Promise<PermissionCheckResult> {
  const isReadOnlyName =
    readOnlyNames ??
    ((name: string) =>
      isBuiltinReadOnlyTool(name) ||
      name === "explore" ||
      name === "agent" ||
      name === "send_message" ||
      name === "task_stop");
  return async (tool, input, source) => {
    // V8 决策 G（#1）：引擎第 8 参 = 当前 plan 会话的计划文件路径（读 ctx 实时值——
    // 模型经 enter_plan_mode 在轮内进入 plan 也立即生效；子 agent 经桥继承同样放行）
    const d = hasPermissionsToUseTool(
      tool.name,
      input,
      ctx.mode,
      ctx.rules,
      ctx.isTrusted,
      ctx.cwd,
      isReadOnlyName,
      ctx.planFilePath,
    );
    const hook = preToolUse ? await preToolUse(tool.name, input) : undefined;
    if (hook?.permissionDecision === "deny") {
      // hook 拒绝：写入 out（展示）+ reason 进拒绝回填（模型可见）
      const target = inputPath(input);
      const reason = hook.permissionDecisionReason ?? "PreToolUse hook 拒绝";
      out.write(`✗ 已拒绝执行 ${tool.name}${target ? ` ${target}` : ""}（hook: ${reason}）\n`);
      return { decision: "deny", reason: `hook 拒绝: ${reason}` };
    }
    // hook 放行：engine 未 deny 时生效（engine deny 是硬底线，不可被 hook 解除）
    if (hook?.permissionDecision === "allow" && d !== "deny") return "allow";
    if (d !== "ask") return d;
    const resolved = await resolveAsk(tool, input, ctx, ask, source, openEditor);
    if (decisionOf(resolved) === "deny") {
      const target = inputPath(input);
      const reason =
        tool.name === "exit_plan_mode"
          ? "用户拒绝了计划"
          : ctx.mode === "plan"
            ? "plan 模式下只读：先调用 exit_plan_mode 呈现计划"
            : "未获授权";
      out.write(`✗ 已拒绝执行 ${tool.name}${target ? ` ${target}` : ""}（${reason}）\n`);
    }
    return resolved;
  };
}

/** V6 决策 A4：由 hookManager 构造 PreToolUse 回调；无 manager → undefined。 */
function preToolUseHook(
  hm: HookManager | undefined,
): ((name: string, input: unknown) => Promise<PreToolUseDecision | undefined>) | undefined {
  return hm ? (name, input) => hm.onPreToolUse(name, input) : undefined;
}

/** V6 决策 A1：PostToolUse 回调——触发 hook，合并输出展示（经 emit）。 */
function postToolUseHook(
  hm: HookManager | undefined,
  emit: (s: string) => void,
): ((name: string, input: unknown, result: string) => Promise<void>) | undefined {
  if (!hm) return undefined;
  return async (name, input, result) => {
    const hookOut = await hm.onPostToolUse(name, input, result);
    if (hookOut) emit(`${DIM}└ [hook] ${preview(hookOut)}${RESET}\n`);
  };
}

/** V6 决策 A1：SessionStart/SessionEnd——触发 hook，合并输出展示（经 emit）。 */
async function runSessionHook(
  hm: HookManager | undefined,
  kind: "start" | "end",
  emit: (s: string) => void,
): Promise<void> {
  if (!hm) return;
  const hookOut = kind === "start" ? await hm.onSessionStart() : await hm.onSessionEnd();
  if (hookOut) emit(`${DIM}[session hook ${kind}] ${preview(hookOut)}${RESET}\n`);
}

/** 组装 runQuery 的公共选项（system/contextWindow/onCompact/...）。 */
function queryOpts(opts: AgentOptions, system: string | undefined) {
  return {
    client: opts.client,
    tools: opts.tools,
    ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
    ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
    ...(opts.maxIterations !== undefined ? { maxIterations: opts.maxIterations } : {}),
    ...(system ? { system } : {}),
    ...(opts.contextWindow ? { contextWindow: opts.contextWindow } : {}),
    ...(opts.onCompact ? { onCompact: opts.onCompact } : {}),
    ...(opts.resultsDir ? { resultsDir: opts.resultsDir } : {}),
    // V7 决策 A7 接线：轮末等后台子 agent 全部完成并汇总注入，协调者委派后能收尾汇总。
    // 之前 onBackgroundDone 从未传给 runQuery——后台任务完成也没人收集，协调者只说完
    // 「等待它们返回后我会汇总结果」就 end_turn，结果被丢弃（实测复现）。awaitAll 已
    // 去重（!reported）防跨 end_turn 重复注入死循环。
    ...(opts.backgroundTasks
      ? { onBackgroundDone: () => opts.backgroundTasks!.awaitAll() }
      : {}),
  };
}

/** 单次执行：读 prompt → 工具循环 → 返回完整结果（reply + toolCalls 轨迹，headless JSON 用）。 */
export async function runOneShot(opts: AgentOptions, prompt: string): Promise<RunQueryResult> {
  const out = opts.out ?? process.stdout;
  const emit = (s: string) => out.write(s);
  await runSessionHook(opts.hookManager, "start", emit);

  const messages: LLMMessage[] = [...(opts.initialMessages ?? [])];
  // V8.3 决策：时间戳等全部动态上下文移入 messages——system 保持字节稳定（DeepSeek 前缀缓存
  // 从 token 0 命中），动态块作为独立 user 消息插在用户 query 前。one-shot 单轮，无需清理历史。
  if (opts.systemCtx) {
    const dynamic = await buildDynamicContext(opts.systemCtx);
    if (dynamic) {
      const block: LLMMessage = {
        role: "user",
        content: `${DYNAMIC_CONTEXT_MARKER}（系统注入，非用户输入）\n\n${dynamic}`,
      };
      messages.push(block);
      await appendMessage(opts.sessionFile, block);
    }
  }
  messages.push({ role: "user", content: prompt });
  await appendMessage(opts.sessionFile, messages[messages.length - 1]!);

  const system = opts.systemCtx ? await buildSystemPrompt(opts.systemCtx) : undefined;
  const checkPermission = opts.ctx
    ? makeCheckPermission(
        opts.ctx,
        out,
        undefined,
        opts.readOnlyNames,
        preToolUseHook(opts.hookManager),
      )
    : undefined;
  const postToolUse = postToolUseHook(opts.hookManager, emit);
  // V7 决策 A4：子 agent 前台复用父级权限（桥写入；后台由 manager 包装 ask→deny 永不弹窗）。
  // headless 下 ctx 存在但 ask 未注入 → resolveAsk 走 canPrompt=false 直接 deny，行为不变。
  if (opts.permissionBridge) opts.permissionBridge.checkPermission = checkPermission;
  opts.skillRegistry?.resetActive(); // V6 决策 B2：one-shot 也是完整 turn，先重置活跃技能
  const result = await runQuery(messages, {
    ...queryOpts(opts, system),
    ...(checkPermission ? { checkPermission } : {}),
    ...(postToolUse ? { onPostToolUse: postToolUse } : {}),
    ...createHandlers(emit),
  });
  out.write("\n");

  // added 契约：只持久化本轮回调新增的消息
  for (const m of result.added) {
    await appendMessage(opts.sessionFile, m);
  }
  // Stop + SessionEnd：one-shot 无下一轮，Stop 输出不注入（只触发）
  await opts.hookManager?.onStop(result.reply);
  await runSessionHook(opts.hookManager, "end", emit);
  return result;
}

const HELP = [
  "run-agent REPL — 直接输入 prompt 开始，agent 会读/写/改/搜/执行并汇报。",
  "  命令: /clear 清空上下文 · /compact 压缩上下文 · /plan 进入/退出只读计划模式 · /mcp 查看/连接/断开 MCP server · /skills 列出技能 · /commands 列出自定义命令 · /tasks 查看后台子 agent · /sessions 查看/切入历史会话 · /help 帮助 · /exit 退出",
].join("\n");

/** V6 决策 B3/C2：内置斜杠命令集合——技能/自定义命令与内置冲突时内置优先。 */
const BUILTIN_SLASH = new Set([
  "exit",
  "quit",
  "clear",
  "compact",
  "plan",
  "help",
  "mcp",
  "skills",
  "commands",
  "sessions",
  "tasks",
]);

/** 交互式 REPL 主循环。 */
export async function runRepl(opts: AgentOptions): Promise<void> {
  const out = opts.out ?? process.stdout;
  let messages: LLMMessage[] = [...(opts.initialMessages ?? [])];
  // V6 决策 A1：Stop hook 输出注入下一轮动态上下文块（V8.3 起在 messages、随用户 query 前插入）
  let stopOutput: string | undefined;
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
  // ── 输入收集状态：多行粘贴统一为单条 prompt（粘贴异常修复，见 line handler 注释）──
  const PASTE_WAIT_MS = 300;
  let inputBuf: string[] = [];
  let submitTimer: NodeJS.Timeout | null = null;
  let busy = false;
  const promptQueue: string[] = [];
  let drainingTail = false; // flush 时 rl.write("\n") 冲出的无换行残留并入本 prompt
  let pasteTailPending = false; // 本 prompt 同 chunk 里有无换行残留末行（粘贴末行，见 line handler）
  let discardNextLine = false; // ask 弹窗前冲掉的残留直接丢弃
  let asking = false; // 弹窗进行中：flush 的冲残留不得写入，防污染菜单输入
  const ask = async (q: string, options?: SelectOption<string>[]): Promise<string> => {
    gate.begin();
    asking = true;
    // 冲掉 readline 缓冲里无换行残留（用户输入过但未提交的部分），防止它被菜单读走——
    // 粘贴异常复现时权限弹窗答案被污染成非 y 的根因
    discardNextLine = true;
    rl.write("\n");
    out.write(`${q}\n`); // 问题行（工具/路径/来源），菜单从新行渲染
    // V8 决策 I（#3）：exit_plan_mode 的弹窗由 resolveAsk 传 EXIT_OPTIONS（多「编辑后批准」）；
    // 其余走缺省三选项。rl 注入：菜单期间 pause + line 静音，stdin 唯一所有权铁律。
    const choice = await promptSelect<string>(options ?? ANSWER_OPTIONS, { out, rl });
    asking = false;
    discardNextLine = false; // rl.write 未触发 line 事件时兜底复位，防泄漏到下一行
    gate.end();
    return choice ?? "n"; // Escape 取消 → 拒绝
  };
  const checkPermission = opts.ctx
    ? makeCheckPermission(
        opts.ctx,
        out,
        ask,
        opts.readOnlyNames,
        preToolUseHook(opts.hookManager),
        openSystemEditor, // V8 决策 I2：编辑器缺省 = 系统编辑器（$EDITOR/$VISUAL/notepad）
      )
    : undefined;
  // V7 决策 A4：子 agent 前台复用父级权限（桥写入；后台由 manager 包装 ask→deny，绝不弹窗）
  if (opts.permissionBridge) opts.permissionBridge.checkPermission = checkPermission;
  const postToolUse = postToolUseHook(opts.hookManager, gate.emit);

  rl.on("SIGINT", () => {
    out.write("\n");
    rl.close();
  });
  rl.on("close", () => {
    // 防悬挂：关闭时清掉未触发的粘贴收集定时器（stdin EOF / /exit 后无残留定时器）
    if (submitTimer) {
      clearTimeout(submitTimer);
      submitTimer = null;
    }
    // V6 决策 A1：SessionEnd 钩子（fire-and-forget；hook 的挂起子进程保持事件循环存活）
    void runSessionHook(opts.hookManager, "end", gate.emit);
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

  // 统一查询路径——普通 prompt 与 /技能命令都走这里（技能 body 作为 user 消息）。
  // 处理单元从「每个 line 事件」提升为「每条收集完的 prompt」：多行粘贴先收集再一次性
  // 处理——readline 按行触发 line 事件，逐行 runTurn 会并发、且无换行收尾的末行留在
  // 内部缓冲可能污染权限弹窗答案（粘贴异常根因）。
  const processPrompt = async (text: string): Promise<void> => {
    const input = text.trim();
    if (!input) {
      promptLine();
      return;
    }
    // V6：统一查询路径——普通 prompt 与 /技能命令都走这里（技能 body 作为 user 消息）
    const runTurn = async (promptText: string): Promise<void> => {
      opts.skillRegistry?.resetActive(); // V6 决策 B2：turn 边界重置活跃技能
      // V8 决策 J（#4）：plan 专用提示词段按当前权限模式注入——模型可经 enter_plan_mode 在
      // 轮内进入 plan，systemCtx 是启动时快照，须每轮从 ctx 同步 mode/planFilePath。
      // V8.3 起该信息进动态块（messages），不再进 system。
      if (opts.systemCtx && opts.ctx) {
        opts.systemCtx.mode = opts.ctx.mode;
        // exactOptionalPropertyTypes：可选属性不能直接赋 undefined——有则写、无则删（回到未注入态）
        if (opts.ctx.planFilePath !== undefined) {
          opts.systemCtx.planFilePath = opts.ctx.planFilePath;
        } else {
          delete opts.systemCtx.planFilePath;
        }
      }
      // system 只保留字节稳定部分（角色准则 + 记忆索引）——每轮重建但字节不变。DeepSeek 自动
      // 前缀缓存从 token 0 命中，system 前缀一字节变化都会让整段（含 messages 历史）以全价 miss。
      const system = opts.systemCtx ? await buildSystemPrompt(opts.systemCtx) : undefined;
      // V8.3 决策：时间戳等全部动态上下文移入 messages——每轮用户 query 前插入独立 user 消息。
      // V6 决策 A1：上一轮 Stop hook 输出经 hookOutput 进动态块（每轮可变）。
      const dynamic = opts.systemCtx
        ? await buildDynamicContext(
            opts.systemCtx,
            stopOutput !== undefined ? { hookOutput: stopOutput } : {},
          )
        : undefined;
      if (dynamic) {
        // 清理历史里上一轮注入的动态消息（含 resume 加载的旧快照），不累积多条"当前时间"。
        // 动态块始终紧跟用户 query 前，过滤掉后历史回到干净状态再插新的。
        messages = messages.filter(
          (m) =>
            !(
              m.role === "user" &&
              typeof m.content === "string" &&
              m.content.startsWith(DYNAMIC_CONTEXT_MARKER)
            ),
        );
        const block: LLMMessage = {
          role: "user",
          content: `${DYNAMIC_CONTEXT_MARKER}（系统注入，非用户输入）\n\n${dynamic}`,
        };
        messages.push(block);
        await appendMessage(opts.sessionFile, block);
      }
      messages.push({ role: "user", content: promptText });
      await appendMessage(opts.sessionFile, messages[messages.length - 1]!);
      const result = await runQuery(messages, {
        ...queryOpts(opts, system),
        ...(checkPermission ? { checkPermission } : {}),
        ...(postToolUse ? { onPostToolUse: postToolUse } : {}),
        ...handlers,
      });
      out.write("\n");

      // V6 决策 A1：Stop hook——每轮结束触发，输出注入下一轮动态上下文块
      if (opts.hookManager) {
        const hookOut = await opts.hookManager.onStop(result.reply);
        stopOutput = hookOut ?? undefined;
      }

      // added 契约 + 数组替换：compact 可能重建消息数组，slice 已不可靠
      messages = result.messages;
      for (const m of result.added) {
        await appendMessage(opts.sessionFile, m);
      }
      // V7 决策 E：后台记忆提取（fire-and-forget，不 await、不阻断下一轮；游标增量 + 互斥 + 失败静默）
      if (opts.extractMemories) void opts.extractMemories.trigger(result.messages);
      // 清晰的任务完成分隔线：明确一轮已结束，避免“任务完成后输入 y 被当成新 prompt 又跑一遍”
      out.write(
        `${GREEN}${DIVIDER}${RESET}\n${GREEN}✔ 任务完成${RESET}${DIM} — 可继续输入下一条 prompt（/exit 退出）${RESET}\n${GREEN}${DIVIDER}${RESET}\n`,
      );
      promptLine();
    };

    if (input.startsWith("/")) {
      // V6 决策 B3：技能斜杠命令——/skills 列清单；/<name> [args] 加载技能后执行。
      // 内置命令优先（技能名与内置冲突时内置赢，与 MCP「内置优先」同语义）。
      const skillName = input.slice(1).split(/\s+/, 1)[0] ?? "";
      if (opts.skillRegistry && (input === "/skills" || input.startsWith("/skills "))) {
        const lines = opts.skillRegistry.all.map(
          (s) => `  /${s.name} — ${s.description}（${s.source === "user" ? "用户级" : "项目级"}）`,
        );
        const block =
          lines.length > 0
            ? lines.join("\n")
            : "  （无可用技能：放 .run-agent/skills/<name>/SKILL.md（Trust）或 ~/.config/run-agent/skills/）";
        out.write(`可用技能:\n${block}\n`);
        promptLine();
        return;
      }
      const skill =
        opts.skillRegistry && !BUILTIN_SLASH.has(skillName)
          ? opts.skillRegistry.find(skillName)
          : undefined;
      if (skill) {
        const rest = input.slice(skillName.length + 1).trim();
        out.write(`✓ 已加载技能 ${skill.name}，执行中…\n`);
        await runTurn(
          `[技能 ${skill.name}（${skill.description}）已加载]\n\n${readSkillBody(skill)}${rest ? `\n\n参数: ${rest}` : ""}`,
        );
        return;
      }
      // V6 决策 C2：自定义命令——/commands 列清单；/<name> [args] 展开模板或跑脚本。
      // 与技能同语义：内置优先，自定义命令名与内置冲突时内置赢。
      const cmdName = input.slice(1).split(/\s+/, 1)[0] ?? "";
      if (opts.commands && (input === "/commands" || input.startsWith("/commands "))) {
        const lines = opts.commands.all.map(
          (c) =>
            `  /${c.name} — ${c.type === "prompt" ? "prompt 模板" : `${c.ext} 脚本`}（${c.source === "user" ? "用户级" : "项目级"}）`,
        );
        const block =
          lines.length > 0
            ? lines.join("\n")
            : "  （无自定义命令：放 .run-agent/commands/<name>.md|.py|.js|.ts（Trust）或 ~/.config/run-agent/commands/）";
        out.write(`自定义命令:\n${block}\n`);
        promptLine();
        return;
      }
      const cmd =
        opts.commands && !BUILTIN_SLASH.has(cmdName) ? opts.commands.find(cmdName) : undefined;
      if (cmd) {
        const rest = input.slice(cmdName.length + 1).trim();
        const cwd = opts.systemCtx?.cwd ?? process.cwd();
        if (cmd.type === "prompt") {
          const { text } = expandPromptTemplate(cmd.template, rest, cwd);
          out.write(`✓ 已加载命令 ${cmd.name}，执行中…\n`);
          await runTurn(text);
        } else {
          out.write(`✓ 正在执行命令 ${cmd.name}…\n`);
          const res = await execLocalCommand(cmd, rest, cwd, input);
          out.write(`\n${res.output}\n`);
          if (!res.ok) out.write(`✗ 命令 ${cmd.name} 失败（退出码 ${res.exitCode ?? "—"}）\n`);
        }
        promptLine();
        return;
      }
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
        if (input.startsWith("/mcp disconnect ")) {
          const server = input.slice("/mcp disconnect ".length).trim();
          if (!server) {
            out.write("用法: /mcp disconnect <server>\n");
            promptLine();
            return;
          }
          const res = await mgr.disconnect(server);
          if (!res.ok) {
            out.write(`✗ ${res.error}\n`);
            promptLine();
            return;
          }
          out.write(`已断开 ${server}\n`);
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
          pending: "⏳",
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
        case "/tasks": {
          // V7 决策 A6：后台子 agent 任务列表（agent 工具 run_in_background 产生）
          if (!opts.backgroundTasks) {
            out.write("当前会话未装配后台任务管理器（仅交互 REPL）\n");
            break;
          }
          const tasks = opts.backgroundTasks.list();
          if (tasks.length === 0) {
            out.write("无后台任务（用 agent 工具 run_in_background=true 委派）\n");
            break;
          }
          for (const t of tasks) {
            const head = t.reply ? preview(t.reply) : "";
            out.write(`  ${t.id}(${t.type}) ${t.status}${head ? ` — ${head}` : ""}\n`);
          }
          break;
        }
        case "/sessions": {
          // V8 ⑥：列出当前项目会话 → 方向键菜单选择 → 切入。
          // 切入 = 加载目标会话替换当前 messages + 更新 sessionFile 指针（后续 appendMessage 写新会话）。
          const cwd = opts.ctx?.cwd ?? process.cwd();
          const sessions = await listSessions(sessionsDir(cwd));
          if (sessions.length === 0) {
            out.write("（当前项目还没有会话）\n");
            break;
          }
          const chosen = await promptSelect<string>(
            sessions.map((s) => ({
              label: s.preview || "(无预览)",
              value: s.file,
              description: `${s.meta?.model ?? "-"} · ${sessionIdTime(s.id)}`, // UTC 存储 → 本地时区显示
            })),
            { out, rl },
          );
          if (chosen === undefined) {
            out.write("已取消\n");
            break;
          }
          const msgs = await loadSession(chosen);
          messages = msgs;
          opts.sessionFile = chosen;
          const sid = sessions.find((s) => s.file === chosen)?.id ?? chosen;
          out.write(`✓ 已切入会话 ${sid}（${msgs.length} 条消息，后续记录写入该会话）\n`);
          break;
        }
        case "/plan": {
          // V5 决策 A5：手动兜底入口——直接进 plan（不经模型判断），与 enter_plan_mode 共用状态机
          if (!opts.planMode) {
            out.write("当前会话不支持 plan 模式（仅交互 REPL）\n");
            break;
          }
          // V8：/plan 是 toggle——plan 下再敲 = 手动退出，直接恢复进入前的模式。
          // 退出是用户主动操作（进是自愿降权、退是自主提权），不再走 exit_plan_mode 审批弹窗。
          if (opts.planMode.exitPlanManually()) {
            out.write("已退出 plan 模式，恢复进入前的权限模式\n");
            break;
          }
          // 进入路径（上面退出 no-op 时 mode != plan，正常必然成功；守卫兜底）
          if (!opts.planMode.enterPlanManually()) {
            out.write("已在 plan 模式：用 exit_plan_mode 呈现计划，批准后自动恢复\n");
            break;
          }
          // V8 决策 G（#1）：/plan 手动入口同样确定计划文件路径（与 enter_plan_mode 共用状态机）
          const pf = opts.planMode.getPlanFilePath();
          out.write(
            "已进入 plan 模式（只读）：让模型只读探索，用 exit_plan_mode 呈现计划；批准后自动恢复执行权限。\n" +
              (pf ? `计划文件路径: ${pf}（模型可用 write_file/edit_file 增量打磨）\n` : ""),
          );
          break;
        }
        case "/help": {
          // V6 决策 C2：/help 汇总内置 + 自定义命令
          const extra =
            opts.commands && opts.commands.all.length > 0
              ? `\n自定义命令:\n${opts.commands.all
                  .map(
                    (c) =>
                      `  /${c.name} — ${c.type === "prompt" ? "prompt 模板" : `${c.ext} 脚本`}`,
                  )
                  .join("\n")}`
              : "";
          out.write(`${HELP}${extra}\n`);
          break;
        }
        default:
          out.write(`未知命令: ${input}（/help 查看）\n`);
      }
      promptLine();
      return;
    }

    await runTurn(input);
  };

  // ── 输入收集 + 串行队列：多行粘贴合并为单条 prompt，同一时刻只有一个 turn ────────
  const dequeue = async (): Promise<void> => {
    if (busy) return;
    const text = promptQueue.shift();
    if (text === undefined) return;
    busy = true;
    try {
      await processPrompt(text);
    } finally {
      busy = false;
      void dequeue();
    }
  };
  const submit = (text: string): void => {
    const t = text.trim();
    if (!t) {
      promptLine();
      return;
    }
    promptQueue.push(t);
    void dequeue();
  };
  // 把 readline 内部缓冲里无换行收尾的残留冲成 line 事件（同步触发），并入本 prompt。
  // 多行粘贴（≥2 行）才冲：单行提示符下用户可能正在输入下一条未完成行，冲掉会误收——
  // 那种残留由 ask 弹窗的丢弃路径清理。
  const drainTail = (): void => {
    if (drainingTail) return;
    drainingTail = true;
    rl.write("\n");
    drainingTail = false;
  };
  const flushInput = (): void => {
    if (submitTimer) {
      clearTimeout(submitTimer);
      submitTimer = null;
    }
    // 弹窗进行中不冲：rl.write("\n") 会被 rl.question 读成答案，污染 y/n
    // 门槛 = 已有 ≥2 完整行（旧行为）或 检测到同 chunk 无换行残留末行（0.7.2 补漏：
    // 两行粘贴只有 1 个完整 line 事件，inputBuf.length 到不了 2，靠 pasteTailPending 冲）
    if ((inputBuf.length >= 2 || pasteTailPending) && !asking) drainTail();
    const text = inputBuf.join("\n");
    inputBuf = [];
    pasteTailPending = false;
    submit(text);
  };
  const scheduleFlush = (): void => {
    if (submitTimer) clearTimeout(submitTimer);
    submitTimer = setTimeout(() => {
      submitTimer = null;
      flushInput();
    }, PASTE_WAIT_MS);
  };

  // 收集器：行先进缓冲；空行 / 单行斜杠命令立即提交；否则空闲 300ms 后整批提交
  rl.on("line", (line) => {
    if (discardNextLine) {
      discardNextLine = false;
      return;
    }
    if (drainingTail) {
      drainingTail = false;
      inputBuf.push(line);
      return;
    }
    if (!line.trim()) {
      flushInput();
      return;
    }
    inputBuf.push(line);
    // 0.7.2 补漏：粘贴末行无换行收尾时，readline 内部缓冲在该行事件之后仍有无换行残留
    // （与行事件同 chunk 到达 = 粘贴的一部分）。用 setImmediate 查——它在 `_onData` 同步
    // 执行完、所有完整行事件都发射之后才跑，此时残留字段一定是"纯残留"；而「用户提交后
    // 新输入」的下一行是独立 chunk，此刻还没到 → 不标记。标记后 flush 时把残留冲进本
    // prompt，防它滞留成下一条的"待输入"（用户没按回车也显示，甚至被误提交）。
    setImmediate(() => {
      if (readlineTail(rl).length > 0) pasteTailPending = true;
    });
    if (inputBuf.length === 1 && line.trim().startsWith("/")) {
      flushInput();
      return;
    }
    scheduleFlush();
  });

  // SessionStart 钩子必须放在 line handler 注册之后 await：注册前的 await 会让 test 同步
  // 注入的早期输入在无 "line" 监听时被 readline 消费后丢弃（见 repl_mcp.test.ts 时序）。
  await runSessionHook(opts.hookManager, "start", gate.emit);
}
