import { Command } from "commander";
import pkg from "../../package.json" with { type: "json" };
import { loadConfig, resolveApiKey } from "../config/index.js";
import { loadDotEnv } from "../config/load.js";
import { createClient } from "../providers/index.js";
import type { LLMMessage, ProviderName } from "../providers/types.js";
import { TOOLS } from "../tools.js";
import { RunAgentError } from "../utils/errors.js";
import { createSessionFile, latestSessionFile, loadSession } from "../utils/sessionStorage.js";
import { runOneShot, runRepl } from "./repl.js";

const program = new Command();

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
  .action(async (prompt: string | undefined, opts: Record<string, unknown>) => {
    try {
      await main(prompt, opts);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      process.stderr.write(`✗ ${message}\n`);
      process.exit(e instanceof RunAgentError ? e.exitCode : 1);
    }
  });

interface CliOpts {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  resume?: boolean;
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

  // 会话：--resume 读最新会话，否则新建
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
