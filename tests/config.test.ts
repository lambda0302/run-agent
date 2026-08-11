import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, resolveApiKey, resolveContextWindow } from "../src/config/index.js";
import { loadDotEnv } from "../src/config/load.js";

const ENV_KEYS = [
  "RUN_AGENT_PROVIDER",
  "RUN_AGENT_MODEL",
  "RUN_AGENT_BASE_URL",
  "RUN_AGENT_API_KEY",
  "RUN_AGENT_API_KEY_ENV",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "RUN_AGENT_MAX_TOKENS",
  "RUN_AGENT_CONTEXT_WINDOW",
  "MY_TEST_VAR",
  "MY_QUOTED_VAR",
];

const saved: Record<string, string | undefined> = {};
const tmpDirs: string[] = [];

function withEnv(key: string, value: string | undefined) {
  if (!(key in saved)) saved[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function makeConfigFile(data: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), "run-agent-config-"));
  tmpDirs.push(dir);
  const p = path.join(dir, "config.json");
  writeFileSync(p, JSON.stringify(data), "utf8");
  return p;
}

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (k in saved) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  }
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

describe("loadConfig 优先级", () => {
  it("无任何来源时回退默认 provider=anthropic", () => {
    // 指向不存在的配置文件，避免读到真实用户配置（保持 hermetic）
    const none = path.join(tmpdir(), "run-agent-no-config.json");
    expect(loadConfig({}, { configPath: none }).provider).toBe("anthropic");
  });

  it("配置文件优先于默认值", () => {
    const p = makeConfigFile({ provider: "openai", model: "gpt-4o-mini" });
    const cfg = loadConfig({}, { configPath: p });
    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("gpt-4o-mini");
  });

  it("环境变量优先于配置文件", () => {
    withEnv("RUN_AGENT_PROVIDER", "ollama");
    const p = makeConfigFile({ provider: "openai", model: "x" });
    expect(loadConfig({}, { configPath: p }).provider).toBe("ollama");
  });

  it("CLI flag 优先于环境变量", () => {
    withEnv("RUN_AGENT_PROVIDER", "ollama");
    expect(loadConfig({ provider: "anthropic" }).provider).toBe("anthropic");
  });

  it("RUN_AGENT_MAX_TOKENS 解析为数字", () => {
    withEnv("RUN_AGENT_MAX_TOKENS", "4096");
    expect(loadConfig().maxTokens).toBe(4096);
  });

  it("RUN_AGENT_CONTEXT_WINDOW 解析为数字", () => {
    withEnv("RUN_AGENT_CONTEXT_WINDOW", "64000");
    expect(loadConfig().contextWindow).toBe(64000);
  });

  it("CLI flag 的 contextWindow 优先于 env", () => {
    withEnv("RUN_AGENT_CONTEXT_WINDOW", "32000");
    expect(loadConfig({ contextWindow: 16000 }).contextWindow).toBe(16000);
  });
});

describe("resolveContextWindow（provider 默认映射）", () => {
  it("未显式配置时按 provider 返回默认", () => {
    expect(resolveContextWindow({ provider: "anthropic" })).toBe(200_000);
    expect(resolveContextWindow({ provider: "openai" })).toBe(128_000);
    expect(resolveContextWindow({ provider: "openai-compatible" })).toBe(128_000);
    expect(resolveContextWindow({ provider: "ollama" })).toBe(8192);
  });

  it("显式配置优先于 provider 默认", () => {
    expect(resolveContextWindow({ provider: "ollama", contextWindow: 16_384 })).toBe(16_384);
  });
});

describe("resolveApiKey 优先级", () => {
  it("显式 apiKey 优先于环境变量", () => {
    withEnv("ANTHROPIC_API_KEY", "from-env");
    expect(resolveApiKey({ provider: "anthropic", apiKey: "explicit" })).toBe("explicit");
  });

  it("apiKeyEnv 指定的变量次之", () => {
    withEnv("DEEPSEEK_API_KEY", "deepseek-key");
    expect(resolveApiKey({ provider: "openai-compatible", apiKeyEnv: "DEEPSEEK_API_KEY" })).toBe(
      "deepseek-key",
    );
  });

  it("无显式配置时回退 provider 默认环境变量", () => {
    withEnv("ANTHROPIC_API_KEY", "env-key");
    expect(resolveApiKey({ provider: "anthropic" })).toBe("env-key");
  });

  it("全部缺失时返回 undefined", () => {
    expect(resolveApiKey({ provider: "anthropic" })).toBeUndefined();
  });
});

describe("loadDotEnv", () => {
  function makeEnvFile(contents: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), "run-agent-dotenv-"));
    tmpDirs.push(dir);
    const p = path.join(dir, ".env");
    writeFileSync(p, contents, "utf8");
    return dir;
  }

  it("读取 KEY=VALUE 行,忽略注释与空行,剥离引号", () => {
    const dir = makeEnvFile(
      ["# 这是注释", "", "MY_TEST_VAR=hello", 'MY_QUOTED_VAR="带引号的值"'].join("\n"),
    );
    loadDotEnv(dir);
    expect(process.env.MY_TEST_VAR).toBe("hello");
    expect(process.env.MY_QUOTED_VAR).toBe("带引号的值");
  });

  it("不覆盖已存在的环境变量", () => {
    withEnv("MY_TEST_VAR", "already-set");
    const dir = makeEnvFile("MY_TEST_VAR=from-dotenv\n");
    loadDotEnv(dir);
    expect(process.env.MY_TEST_VAR).toBe("already-set");
  });

  it("没有 .env 文件时静默返回", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "run-agent-nodotenv-"));
    tmpDirs.push(dir);
    expect(() => loadDotEnv(dir)).not.toThrow();
  });
});
