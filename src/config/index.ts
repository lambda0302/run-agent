import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ProviderName } from "../providers/types.js";

export interface RunAgentConfig {
  provider: ProviderName;
  model?: string;
  baseURL?: string;
  /** 显式 API key */
  apiKey?: string;
  /** 从哪个环境变量读 API key（覆盖默认约定） */
  apiKeyEnv?: string;
  maxTokens?: number;
  /** V2 权限模式：default | acceptEdits | bypass */
  permissionMode?: string;
  /** V3 上下文窗口（token 估算用）；缺省按 provider 映射 */
  contextWindow?: number;
}

/** CLI flag 覆盖项（优先级最高） */
export interface CliOverrides {
  provider?: ProviderName;
  model?: string;
  baseURL?: string;
  apiKey?: string;
  maxTokens?: number;
  contextWindow?: number;
}

const DEFAULTS: RunAgentConfig = { provider: "anthropic" };

/** 各 provider 默认的 API key 环境变量名 */
export const DEFAULT_API_KEY_ENV: Record<ProviderName, string | undefined> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  "openai-compatible": undefined,
  ollama: undefined,
};

/** 各 provider 默认的上下文窗口（token 估算阈值用） */
export const DEFAULT_CONTEXT_WINDOW: Record<ProviderName, number> = {
  anthropic: 200_000,
  openai: 128_000,
  "openai-compatible": 128_000,
  ollama: 8192,
};

/** 解析最终生效的上下文窗口：显式配置 > provider 默认映射。 */
export function resolveContextWindow(config: RunAgentConfig): number {
  return config.contextWindow ?? DEFAULT_CONTEXT_WINDOW[config.provider];
}

export function configFilePath(): string {
  return path.join(homedir(), ".config", "run-agent", "config.json");
}

function readConfigFile(filePath?: string): Partial<RunAgentConfig> {
  const p = filePath ?? configFilePath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Partial<RunAgentConfig>;
  } catch {
    return {};
  }
}

function envConfig(): Partial<RunAgentConfig> {
  const c: Partial<RunAgentConfig> = {};
  if (process.env.RUN_AGENT_PROVIDER) c.provider = process.env.RUN_AGENT_PROVIDER as ProviderName;
  if (process.env.RUN_AGENT_MODEL) c.model = process.env.RUN_AGENT_MODEL;
  if (process.env.RUN_AGENT_BASE_URL) c.baseURL = process.env.RUN_AGENT_BASE_URL;
  if (process.env.RUN_AGENT_API_KEY) c.apiKey = process.env.RUN_AGENT_API_KEY;
  if (process.env.RUN_AGENT_API_KEY_ENV) c.apiKeyEnv = process.env.RUN_AGENT_API_KEY_ENV;
  if (process.env.RUN_AGENT_MODE) c.permissionMode = process.env.RUN_AGENT_MODE;
  const maxTokens = Number(process.env.RUN_AGENT_MAX_TOKENS);
  if (Number.isFinite(maxTokens) && maxTokens > 0) c.maxTokens = Math.floor(maxTokens);
  const contextWindow = Number(process.env.RUN_AGENT_CONTEXT_WINDOW);
  if (Number.isFinite(contextWindow) && contextWindow > 0)
    c.contextWindow = Math.floor(contextWindow);
  return c;
}

/**
 * 合并配置：flag > env > 配置文件 > 默认值。
 * @param overrides CLI flag
 * @param opts.configPath 测试用：覆盖配置文件路径
 */
export function loadConfig(
  overrides: CliOverrides = {},
  opts: { configPath?: string } = {},
): RunAgentConfig {
  const file = readConfigFile(opts.configPath);
  const env = envConfig();
  return { ...DEFAULTS, ...file, ...env, ...overrides };
}

/** 按优先级解析出最终 API key：显式 > apiKeyEnv 指向的变量 > provider 默认约定。 */
export function resolveApiKey(config: RunAgentConfig): string | undefined {
  if (config.apiKey) return config.apiKey;
  if (config.apiKeyEnv) {
    const v = process.env[config.apiKeyEnv];
    if (v) return v;
  }
  const envName = DEFAULT_API_KEY_ENV[config.provider];
  if (envName) {
    const v = process.env[envName];
    if (v) return v;
  }
  return undefined;
}
