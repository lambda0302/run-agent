import { Command, Option } from "commander";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { loadConfig, resolveApiKey, resolveContextWindow } from "../config/index.js";
import { buildSystemPrompt } from "../core/context.js";
import type { SystemContext } from "../core/context.js";
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
import { createClient } from "../providers/index.js";
import type { LLMMessage, ProviderName } from "../providers/types.js";
import { listMemories, pruneMemories, removeMemory, topicFilePath } from "../core/memory.js";
import { buildTools } from "../tools.js";
import type { Tool } from "../tools.js";
import { makePlanTools } from "../tools/plan_mode.js";
import type { PlanTools } from "../tools/plan_mode.js";
import { loadMcpConfig } from "../services/mcp/config.js";
import { makeMcpConnectTool } from "../services/mcp/mcp_connect.js";
import { McpManager } from "../services/mcp/manager.js";
import { RunAgentError } from "../utils/errors.js";
import { createSessionFile, latestSessionFile, loadSession } from "../utils/sessionStorage.js";
import { runOneShot, runRepl } from "./repl.js";

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
  .option("--context-window <n>", "context window size in tokens (defaults per provider)")
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
  contextWindow?: number;
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

  // ── V3 上下文：system 组装所需 + 生效的上下文窗口 ────────────────
  const systemCtx: SystemContext = {
    cwd,
    isTrusted,
    bare: Boolean(opts.bare),
    ...(planCtrl ? { hasPlanMode: true } : {}),
    ...(mcpManager
      ? {
          mcpServers: mcpManager
            .serverNames()
            .map((n) => `${n}(${mcpConfig.servers[n]!.type})`)
            .join(", "),
        }
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

  // V5 决策 B4：只读判定闭包 = 内置只读 ∪ explore ∪ MCP readOnlyHint（权限管线并入）
  const readOnlyNames = (name: string): boolean =>
    isBuiltinReadOnlyTool(name) || name === "explore" || (mcpManager?.isReadOnly(name) ?? false);

  // 静态工具一次装配（含 mcp_connect）；MCP 已连接工具每轮动态追加（函数池，决策 B3）
  const baseTools = buildTools({
    cwd,
    isTrusted,
    client,
    ...(system !== undefined ? { system } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    checkPermission: exploreCheckPermission,
    ...(planCtrl ? { planMode: planCtrl } : {}),
    ...(mcpManager ? { mcpConnect: makeMcpConnectTool(mcpManager) } : {}),
  });
  const agentTools = (): Tool[] => [...baseTools, ...(mcpManager?.getConnectedTools() ?? [])];

  const agentOpts = {
    client,
    tools: agentTools,
    ...(cfg.maxTokens ? { maxTokens: cfg.maxTokens } : {}),
    sessionFile,
    initialMessages,
    ctx,
    contextWindow,
    systemCtx,
    ...(planCtrl ? { planMode: planCtrl } : {}),
    ...(mcpManager ? { mcpManager } : {}),
    ...(mcpManager ? { readOnlyNames } : {}),
    // 决策 8：超大工具结果落盘到 session 同目录（r0.txt/r1.txt…），消息里只留指针
    resultsDir: path.dirname(sessionFile),
  };

  if (prompt) {
    await runOneShot(agentOpts, prompt);
  } else {
    if (!process.stdin.isTTY) {
      program.help();
      return;
    }
    await runRepl(agentOpts);
  }
}

program.parse();
