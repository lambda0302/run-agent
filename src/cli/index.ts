import { Command, Option } from "commander";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { loadConfig, resolveApiKey, resolveContextWindow } from "../config/index.js";
import type { RunAgentConfig } from "../config/index.js";
import { buildSystemPrompt } from "../core/context.js";
import type { SystemContext } from "../core/context.js";
import type { RunQueryResult } from "../core/query.js";
import { loadDotEnv } from "../config/load.js";
import { askTrustProject } from "../permissions/prompt.js";
import {
  addTrustedProject,
  isProjectTrusted,
  loadRules,
  loadTrustedProjects,
  removeTrustedProject,
} from "../permissions/store.js";
import { hasPermissionsToUseTool, isBuiltinReadOnlyTool } from "../permissions/engine.js";
import type { Decision, PermissionContext, PermissionMode } from "../permissions/types.js";
import { createClient, resolveModelName } from "../providers/index.js";
import type { LLMMessage, ProviderName } from "../providers/types.js";
import { listMemories, pruneMemories, removeMemory, topicFilePath } from "../core/memory.js";
import { buildTools } from "../tools.js";
import type { Tool } from "../tools.js";
import { makePlanTools } from "../tools/plan_mode.js";
import type { PlanTools } from "../tools/plan_mode.js";
import { loadMcpConfig } from "../services/mcp/config.js";
import { makeMcpConnectTool } from "../services/mcp/mcp_connect.js";
import { McpManager } from "../services/mcp/manager.js";
import { isHooksConfigEmpty, loadHooksConfig } from "../services/hooks/config.js";
import { HookManager } from "../services/hooks/manager.js";
import { loadSkills } from "../services/skills/loader.js";
import { SkillRegistry } from "../services/skills/skill_tool.js";
import { loadCommands, CommandRegistry } from "../services/commands/loader.js";
import { ExtractMemoriesEngine } from "../services/extract/extract.js";
import { RunAgentError } from "../utils/errors.js";
import { createSessionFile, latestSessionFile, loadSession } from "../utils/sessionStorage.js";
import { runOneShot, runRepl } from "./repl.js";
import type { AgentOptions } from "./repl.js";
import type { PermissionBridge } from "../core/run_agent.js";
import { AgentRegistry, builtinAgentTypes } from "../services/agents/registry.js";
import { loadAgents } from "../services/agents/loader.js";
import { BackgroundTaskManager } from "../services/agents/team/registry.js";
import { makeAgentTool } from "../tools/agent.js";
import { makeSendMessageTool } from "../tools/send_message.js";
import { makeTaskStopTool } from "../tools/task_stop.js";

const program = new Command();

// V4.5 决策 A：bypass 已删除。非法 --mode 值由 commander choices 直接报错；env/config 里的
// 非法值在 resolveMode 回退 default 并警告（温和降级，不崩溃）。
const PERMISSION_MODES = ["default", "acceptEdits"] as const;

program
  .name("run-agent")
  .description("Run Agent — a transparent, multi-provider coding agent for your terminal.")
  .version(pkg.version, "-v, --version")
  .argument("[prompt]", "the prompt to run (omit to enter the interactive REPL)")
  .option("-p, --provider <provider>", "provider: anthropic | openai | openai-compatible | ollama")
  .option("-m, --model <model>", "model name")
  .option(
    "-b, --base-url <baseURL>",
    "base URL (required for openai-compatible, e.g. https://api.deepseek.com/v1)",
  )
  .option("-k, --api-key <apiKey>", "API key (overrides env var / config file)")
  .option("-r, --resume", "resume the latest session instead of starting a new one")
  .addOption(
    new Option(
      "-M, --mode <mode>",
      `permission mode: ${PERMISSION_MODES.join(" | ")} (default)`,
    ).choices([...PERMISSION_MODES]),
  )
  .option("-t, --trust", "trust the current project directory (skips the Trust prompt)")
  .option("--bare", "disable CLAUDE.md memory and dynamic context injection")
  .option(
    "--coordinator",
    "V7: coordinator mode — inject the coordinator system prompt (delegate to specialist sub-agents)",
  )
  .option("--context-window <n>", "context window size in tokens (defaults per provider)")
  .option(
    "--print <prompt>",
    "headless: run this prompt once and exit (mutually exclusive with positional prompt)",
  )
  .option("--json", "output structured JSON to stdout (with --print); human logs go to stderr")
  .option("--max-turns <n>", "ReAct loop iteration cap for headless runs (default 25)")
  .action(async (prompt: string | undefined, opts: Record<string, unknown>) => {
    try {
      await main(prompt, opts);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      process.stderr.write(`✗ ${message}\n`);
      process.exit(e instanceof RunAgentError ? e.exitCode : 1);
    }
  });

/** 管理受信任项目：run-agent trust [path]（默认当前目录）/ --list / --remove。 */
program
  .command("trust")
  .description("manage trusted projects (Trust boundary against prompt injection)")
  .argument("[path]", "project path (defaults to current directory)")
  .option("--list", "list all trusted projects")
  .option("--remove", "remove trust for the given path")
  .action((p: string | undefined, opts: { list?: boolean; remove?: boolean }) => {
    const target = p ? p : process.cwd();
    if (opts.list) {
      const list = loadTrustedProjects();
      if (list.length === 0) process.stdout.write("（空）\n");
      for (const t of list) process.stdout.write(`${t}\n`);
    } else if (opts.remove) {
      removeTrustedProject(target);
      process.stdout.write(`已移除信任: ${path.resolve(target)}\n`);
    } else {
      addTrustedProject(target);
      process.stdout.write(`已信任: ${path.resolve(target)}\n`);
    }
  });

/**
 * 管理项目记忆：run-agent memory list/show/rm/prune（决策 C）。
 * 用户发起的维护操作，CLI 直读直写 .run-agent/memory/，不走工具权限管线。
 */
const memoryCmd = program
  .command("memory")
  .description("manage project memory (.run-agent/memory/)");

memoryCmd
  .command("list")
  .description("list memory index entries (optionally filter by keyword)")
  .argument("[query]", "filter: matches title / hook / name")
  .action(async (query?: string) => {
    const entries = await listMemories(process.cwd(), query);
    if (entries.length === 0) {
      process.stdout.write("（无记忆条目）\n");
      return;
    }
    for (const e of entries) process.stdout.write(`- [${e.title}](${e.name}.md) — ${e.hook}\n`);
  });

memoryCmd
  .command("show")
  .description("print a single memory file (frontmatter + body)")
  .argument("<name>", "memory name (filename slug, no .md)")
  .action(async (name: string) => {
    try {
      const raw = await readFile(topicFilePath(process.cwd(), name), "utf8");
      process.stdout.write(raw.replace(/^﻿/, ""));
    } catch {
      process.stderr.write(`✗ 未找到记忆: ${name}\n`);
      process.exit(1);
    }
  });

memoryCmd
  .command("rm")
  .description("delete a memory (topic file + index line)")
  .argument("<name>", "memory name (filename slug, no .md)")
  .action(async (name: string) => {
    await removeMemory(process.cwd(), name);
    process.stdout.write(`已删除记忆: ${name}\n`);
  });

memoryCmd
  .command("prune")
  .description("delete memories older than N days (default 30)")
  .option("--days <n>", "age threshold in days", "30")
  .action(async (opts: { days: string }) => {
    const days = Number.parseInt(opts.days, 10);
    const n = await pruneMemories(process.cwd(), Number.isFinite(days) && days > 0 ? days : 30);
    process.stdout.write(`已清理 ${n} 条过期记忆\n`);
  });

interface CliOpts {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  resume?: boolean;
  mode?: string;
  trust?: boolean;
  bare?: boolean;
  coordinator?: boolean;
  contextWindow?: number;
  print?: string;
  json?: boolean;
  maxTurns?: string;
}

/** 解析权限模式：--mode > RUN_AGENT_MODE > config > default。
 *  --mode 非法值已被 commander choices 拦截；env/config 的非法值（如旧配置里的 "bypass"）
 *  回退 default 并打印警告（V4.5 决策 A 兼容处理，温和降级不崩溃）。 */
function resolveMode(opts: CliOpts, configMode: string | undefined): PermissionMode {
  const raw = opts.mode ?? process.env.RUN_AGENT_MODE ?? configMode;
  if (raw && (PERMISSION_MODES as readonly string[]).includes(raw)) return raw as PermissionMode;
  if (raw) process.stderr.write(`⚠ 未知权限模式 "${raw}"，已回退到 default\n`);
  return "default";
}

async function main(prompt: string | undefined, opts: CliOpts): Promise<void> {
  // V6 决策 D1：--print 与位置参数互斥
  if (opts.print && prompt) {
    throw new RunAgentError("--print <prompt> 与位置参数 prompt 互斥，请二选一");
  }
  loadDotEnv(); // 项目根 .env（已存在的环境变量优先，不覆盖）
  const cfg = loadConfig({
    ...(opts.provider ? { provider: opts.provider as ProviderName } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    ...(opts.contextWindow ? { contextWindow: opts.contextWindow } : {}),
  });

  if (cfg.provider === "openai-compatible" && !cfg.baseURL) {
    throw new RunAgentError(
      "provider=openai-compatible 需要 --base-url（如 https://api.deepseek.com/v1）或配置文件里的 baseURL",
    );
  }
  const apiKey = resolveApiKey(cfg);
  if (cfg.provider !== "ollama" && !apiKey) {
    throw new RunAgentError(
      `未找到 API key：provider=${cfg.provider} 需要 key（用 --api-key、环境变量或 config.json 提供）`,
    );
  }
  const client = createClient(cfg.provider, {
    ...(apiKey ? { apiKey } : {}),
    ...(cfg.model ? { model: cfg.model } : {}),
    ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
  });

  // ── V2 权限上下文 ──────────────────────────────────────────────
  const mode = resolveMode(opts, cfg.permissionMode);
  const isTTY = Boolean(process.stdin.isTTY);
  const canPrompt = isTTY && !prompt; // 仅交互 REPL 才弹确认；one-shot 一律降级 deny
  const cwd = process.cwd();

  let isTrusted = isProjectTrusted(cwd, loadTrustedProjects());
  if (opts.trust) {
    addTrustedProject(cwd);
    isTrusted = true;
  } else if (!isTrusted && canPrompt) {
    isTrusted = await askTrustProject(cwd);
    if (isTrusted) addTrustedProject(cwd);
  }

  const rules = [...loadRules()];
  if (isTrusted) {
    // 受信任项目才加载项目级规则（防提示注入：恶意项目的规则不生效）
    rules.push(...loadRules(path.join(cwd, ".run-agent", "permissions.json")));
  }

  const ctx: PermissionContext = { mode, rules, canPrompt, isTrusted, cwd };

  // ── V5 决策 A：plan 模式导航工具（仅 REPL 装配；one-shot 无审批弹窗，防死锁）────
  let planCtrl: PlanTools | undefined;
  if (!prompt) {
    planCtrl = makePlanTools({
      getMode: () => ctx.mode,
      setMode: (m) => {
        ctx.mode = m;
      },
      canPrompt,
    });
  }

  // ── V5 决策 B：MCP 连接管理器（配置了 server 才创建；默认不预连省 token/资源）────
  const mcpConfig = loadMcpConfig(cwd, isTrusted);
  let mcpManager: McpManager | undefined;
  if (Object.keys(mcpConfig.servers).length > 0) {
    mcpManager = new McpManager(mcpConfig.servers);
    if (mcpConfig.preconnect) {
      // 高级选项：启动即全量连接（默认 false）。连接失败各自进 failed 态，不阻断启动。
      await Promise.all(mcpManager.serverNames().map((name) => mcpManager!.connect(name)));
    }
    // 进程退出清理所有子进程/连接（fire-and-forget；stdio transport 内部有 SIGINT→SIGTERM→SIGKILL 升级）
    process.on("exit", () => {
      void mcpManager?.closeAll();
    });
  }

  // ── V6 决策 B：技能注册表（用户级 + 项目级 Trust；有技能才创建，零配置零开销）────
  let skillRegistry: SkillRegistry | undefined;
  {
    const { skills, skipped } = loadSkills(cwd, isTrusted);
    if (skills.length > 0) {
      skillRegistry = new SkillRegistry(skills);
      for (const s of skipped) {
        process.stderr.write(`⚠ 技能 ${s} 解析失败/超限，已跳过\n`);
      }
    }
  }

  // ── V6 决策 C：自定义命令注册表（用户级 + 项目级 Trust；有命令才创建）────
  let commands: CommandRegistry | undefined;
  {
    const loaded = loadCommands(cwd, isTrusted);
    if (loaded.commands.length > 0) {
      commands = new CommandRegistry(loaded.commands);
    }
  }

  // ── V3 上下文：system 组装所需 + 生效的上下文窗口 ────────────────
  const systemCtx: SystemContext = {
    cwd,
    isTrusted,
    bare: Boolean(opts.bare),
    // V7 决策 C1：--coordinator 注入协调者段落（动态段；--bare 已整体跳过）
    ...(opts.coordinator ? { coordinator: true } : {}),
    ...(planCtrl ? { hasPlanMode: true } : {}),
    ...(mcpManager
      ? {
          mcpServers: mcpManager
            .serverNames()
            .map((n) => `${n}(${mcpConfig.servers[n]!.type})`)
            .join(", "),
        }
      : {}),
    ...(skillRegistry && skillRegistry.all.length > 0
      ? { skills: skillRegistry.all.map((s) => `- ${s.name}: ${s.description}`).join("\n") }
      : {}),
  };
  const contextWindow = resolveContextWindow(cfg);

  // ── 0.4.1 explore 子 agent：复用主 system 快照 + 继承父级权限 ────────
  // 子查询只读工具 default 免确认；即便出现 ask（如用户规则）也降级 deny，
  // 绝不另建 readline（stdin 只能有一个读者）。--bare 时 buildSystemPrompt 返回 undefined。
  const system = await buildSystemPrompt(systemCtx);
  const exploreCheckPermission = async (tool: Tool, input: unknown): Promise<Decision> => {
    const d = hasPermissionsToUseTool(
      tool.name,
      input,
      ctx.mode,
      ctx.rules,
      ctx.isTrusted,
      ctx.cwd,
    );
    return d === "ask" ? "deny" : d;
  };

  // ── 会话：--resume 读最新会话，否则新建 ─────────────────────────
  let sessionFile: string;
  let initialMessages: LLMMessage[] = [];
  if (opts.resume) {
    const f = await latestSessionFile();
    if (!f) throw new RunAgentError("没有可续接的会话");
    sessionFile = f;
    initialMessages = await loadSession(f);
    process.stderr.write(`✓ 已续接会话 ${sessionFile}\n`);
  } else {
    sessionFile = await createSessionFile();
    process.stderr.write(`✓ 会话 ${sessionFile}\n`);
  }

  // ── V6 决策 A3：HookManager（配置了 hooks 才创建，零配置零开销）────
  const hooksConfig = loadHooksConfig(cwd, isTrusted);
  let hookManager: HookManager | undefined;
  if (!isHooksConfigEmpty(hooksConfig)) {
    hookManager = new HookManager(hooksConfig, { cwd, sessionFile });
  }

  // V5 决策 B4：只读判定闭包 = 内置只读 ∪ explore ∪ 协调者三件套 ∪ MCP readOnlyHint（权限管线并入）
  // agent/send_message/task_stop 无文件/外部副作用（只改内存状态），归只读 → default 免确认
  const readOnlyNames = (name: string): boolean =>
    isBuiltinReadOnlyTool(name) ||
    name === "explore" ||
    name === "agent" ||
    name === "send_message" ||
    name === "task_stop" ||
    (mcpManager?.isReadOnly(name) ?? false);

  // ── V7 决策 A/B：agent 注册表 + 后台任务注册表 + 权限桥 + agent 工具 ──────
  const agentRegistry = new AgentRegistry(builtinAgentTypes());
  // V7 决策 B2：自定义 frontmatter 类型合并（项目级仅 Trust 加载；内置优先同名忽略）
  const { agents: customAgents, skipped: skippedAgents } = loadAgents(cwd, isTrusted);
  for (const def of customAgents) {
    if (!agentRegistry.register(def)) {
      process.stderr.write(`⚠ 自定义 agent 类型 "${def.name}" 与内置重名，已忽略\n`);
    }
  }
  if (skippedAgents.length > 0) {
    process.stderr.write(
      `⚠ 跳过 ${skippedAgents.length} 个非法 agent 定义: ${skippedAgents.join(", ")}\n`,
    );
  }
  const backgroundTasks = new BackgroundTaskManager();
  const permissionBridge: PermissionBridge = { checkPermission: undefined };
  // 父级工具池延迟绑定：agent 工具创建时 baseTools 尚未存在；agentTools() 每轮刷新 poolRef
  let poolRef: () => Tool[] = () => [];
  const agentTool = makeAgentTool({
    client,
    ...(system !== undefined ? { system } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    // 子查询权限：主循环 checkPermission（bridge 写入，前台可弹窗）> exploreCheckPermission（ask→deny 兜底）。
    // bridge 由 repl.ts/runOneShot 构造完 checkPermission 后写入（见 repl.ts）；headless 不弹窗。
    checkPermission: (tool, input) =>
      permissionBridge.checkPermission
        ? permissionBridge.checkPermission(tool, input)
        : exploreCheckPermission(tool, input),
    makeModelClient: (m) =>
      createClient(cfg.provider, {
        ...(apiKey ? { apiKey } : {}),
        model: m,
        ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
      }),
    registry: agentRegistry,
    backgroundTasks,
    resultsDir: path.dirname(sessionFile),
    transcriptDir: path.dirname(sessionFile),
    parentTools: () => poolRef(),
  });

  // ── V7 决策 E：后台记忆提取引擎（双轨之二）——仅 Trust 且非 bare 装配；触发点只在 REPL，
  // headless one-shot 天然不触发（CI 每次跑成本不可接受）。RUN_AGENT_DISABLE_MEMORY_EXTRACT 可关。────
  let extractMemories: ExtractMemoriesEngine | undefined;
  if (isTrusted && !opts.bare) {
    extractMemories = new ExtractMemoriesEngine({
      cwd,
      isTrusted,
      bare: Boolean(opts.bare),
      client,
      // 父级池懒取：触发在轮末，届时 agentTools() 已刷新 poolRef（含 MCP 已连接工具 + remember）
      parentTools: () => poolRef(),
      ...(contextWindow ? { contextWindow } : {}),
      resultsDir: path.dirname(sessionFile),
      makeModelClient: (m) =>
        createClient(cfg.provider, {
          ...(apiKey ? { apiKey } : {}),
          model: m,
          ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
        }),
      disabled: Boolean(process.env.RUN_AGENT_DISABLE_MEMORY_EXTRACT),
    });
  }

  // 静态工具一次装配（含 mcp_connect + agent 委派原语）；MCP 已连接工具每轮动态追加（函数池，决策 B3）
  const baseTools = buildTools({
    cwd,
    isTrusted,
    client,
    ...(system !== undefined ? { system } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    checkPermission: exploreCheckPermission,
    ...(planCtrl ? { planMode: planCtrl } : {}),
    ...(mcpManager ? { mcpConnect: makeMcpConnectTool(mcpManager) } : {}),
    ...(skillRegistry ? { skills: skillRegistry } : {}),
    agentTool,
    sendMessageTool: makeSendMessageTool(backgroundTasks),
    taskStopTool: makeTaskStopTool(backgroundTasks),
  });
  // V6 决策 B2：活跃技能 allowed-tools 过滤（本 turn 剩余工具 = allowed-tools ∩ 池 ∪ 内置只读）；
  // V7 决策 B：每轮刷新 poolRef（agent 工具子查询解析父级池，含 MCP 已连接工具）
  const agentTools = (): Tool[] => {
    const pool = [...baseTools, ...(mcpManager?.getConnectedTools() ?? [])];
    const filtered = skillRegistry ? skillRegistry.filterToolsForActiveSkill(pool) : pool;
    poolRef = () => filtered;
    return filtered;
  };

  // V6 决策 D：--max-turns <n> → ReAct 循环轮数上限（解析失败警告并忽略）
  let maxTurns = opts.maxTurns !== undefined ? Number(opts.maxTurns) : undefined;
  if (maxTurns !== undefined && (!Number.isInteger(maxTurns) || maxTurns <= 0)) {
    process.stderr.write(`⚠ --max-turns "${opts.maxTurns}" 非法，已忽略\n`);
    maxTurns = undefined;
  }

  const agentOpts = {
    client,
    tools: agentTools,
    ...(cfg.maxTokens ? { maxTokens: cfg.maxTokens } : {}),
    sessionFile,
    initialMessages,
    ctx,
    contextWindow,
    systemCtx,
    ...(maxTurns !== undefined ? { maxIterations: maxTurns } : {}),
    ...(planCtrl ? { planMode: planCtrl } : {}),
    ...(mcpManager ? { mcpManager } : {}),
    ...(mcpManager ? { readOnlyNames } : {}),
    ...(hookManager ? { hookManager } : {}),
    ...(skillRegistry ? { skillRegistry } : {}),
    ...(commands ? { commands } : {}),
    // V7 决策 A6：后台任务注册表（/tasks 查看）——交互 REPL 才装配；headless one-shot 无任务列表
    ...(backgroundTasks ? { backgroundTasks } : {}),
    // V7 决策 E：后台记忆提取引擎（仅 Trust 且非 bare 装配）；REPL 轮末 fire-and-forget 触发
    ...(extractMemories ? { extractMemories } : {}),
    // V7 决策 A4：权限桥——REPL/one-shot 构造完 checkPermission 后写入，agent 工具子查询读取
    permissionBridge,
    // 决策 8：超大工具结果落盘到 session 同目录（r0.txt/r1.txt…），消息里只留指针
    resultsDir: path.dirname(sessionFile),
  };

  // V6 决策 D：--print / 位置参数 = one-shot（headless）；否则交互 REPL
  const effectivePrompt = opts.print ?? prompt;
  if (effectivePrompt) {
    if (opts.json) {
      await runHeadless(agentOpts, effectivePrompt, cfg, sessionFile);
    } else {
      await runOneShot(agentOpts, effectivePrompt);
    }
  } else {
    if (opts.json) {
      throw new RunAgentError("--json 需要 --print <prompt> 或位置参数 prompt");
    }
    if (!process.stdin.isTTY) {
      program.help();
      return;
    }
    await runRepl(agentOpts);
  }
}

/** V6 决策 D：headless + JSON 契约——stdout 只输出合法 JSON，人类可读日志去 stderr。
 * 退出码：成功 0；捕获到错误 → errors 数组 + exit 1。 */
async function runHeadless(
  agentOpts: AgentOptions,
  prompt: string,
  cfg: RunAgentConfig,
  sessionFile: string,
): Promise<void> {
  const errors: string[] = [];
  let result: RunQueryResult | null = null;
  // JSON 模式下流式文本也去 stderr，保证 stdout 只有 JSON
  try {
    result = await runOneShot({ ...agentOpts, out: process.stderr }, prompt);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }
  const payload = {
    version: pkg.version,
    provider: cfg.provider,
    model: resolveModelName(cfg.provider, cfg.model),
    session: path.basename(sessionFile),
    reply: result?.reply ?? "",
    messages: result?.messages.length ?? 0,
    turns: result?.iterations ?? 0,
    tools: (result?.toolCalls ?? []).map((t) => ({
      name: t.name,
      input: t.input,
      result: t.result,
      permission: t.permission,
    })),
    errors,
  };
  // 先回收 MCP 子进程（否则其 stdio 句柄卡住事件循环），再写 JSON 并设退出码。
  // 不调用 process.exit()：Windows libuv 在句柄关闭中途强退会触发 UV_HANDLE_CLOSING 断言崩溃；
  // 写完成回调里设 process.exitCode，随后事件循环自然退出（确定性退出码 0/1）。
  await agentOpts.mcpManager?.closeAll();
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`, () => {
    process.exitCode = errors.length > 0 ? 1 : 0;
  });
}

program.parse();
