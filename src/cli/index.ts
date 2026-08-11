import { Command } from "commander";
import path from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { loadConfig, resolveApiKey } from "../config/index.js";
import { loadDotEnv } from "../config/load.js";
import { askTrustProject } from "../permissions/prompt.js";
import {
  addTrustedProject,
  isProjectTrusted,
  loadRules,
  loadTrustedProjects,
  removeTrustedProject,
} from "../permissions/store.js";
import type { PermissionContext, PermissionMode } from "../permissions/types.js";
import { createClient } from "../providers/index.js";
import type { LLMMessage, ProviderName } from "../providers/types.js";
import { TOOLS } from "../tools.js";
import { RunAgentError } from "../utils/errors.js";
import { createSessionFile, latestSessionFile, loadSession } from "../utils/sessionStorage.js";
import { runOneShot, runRepl } from "./repl.js";

const program = new Command();

const PERMISSION_MODES = ["default", "acceptEdits", "bypass"] as const;

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
  .option("-M, --mode <mode>", `permission mode: ${PERMISSION_MODES.join(" | ")} (default)`)
  .option("--dangerously-skip-permissions", "bypass all permission checks (mode=bypass)")
  .option("-t, --trust", "trust the current project directory (skips the Trust prompt)")
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

interface CliOpts {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  resume?: boolean;
  mode?: string;
  dangerouslySkipPermissions?: boolean;
  trust?: boolean;
}

/** 解析权限模式：--dangerously-skip-permissions > --mode > RUN_AGENT_MODE > config > default */
function resolveMode(opts: CliOpts, configMode: string | undefined): PermissionMode {
  if (opts.dangerouslySkipPermissions) return "bypass";
  const raw = opts.mode ?? process.env.RUN_AGENT_MODE ?? configMode;
  if (raw && (PERMISSION_MODES as readonly string[]).includes(raw)) return raw as PermissionMode;
  return "default";
}

async function main(prompt: string | undefined, opts: CliOpts): Promise<void> {
  loadDotEnv(); // 项目根 .env（已存在的环境变量优先，不覆盖）
  const cfg = loadConfig({
    ...(opts.provider ? { provider: opts.provider as ProviderName } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
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

  const ctx: PermissionContext = { mode, rules, canPrompt, isTrusted };

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

  const agentOpts = {
    client,
    tools: TOOLS,
    ...(cfg.maxTokens ? { maxTokens: cfg.maxTokens } : {}),
    sessionFile,
    initialMessages,
    ctx,
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
