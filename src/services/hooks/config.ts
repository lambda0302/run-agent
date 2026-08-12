/**
 * V6 决策 A3：hooks 配置读取。
 *
 * 配置位置（与既有配置约定一致，全部自有路径、无 `.claude/`）：
 *   - 用户级 ~/.config/run-agent/settings.json（始终加载，用户自写）
 *   - 项目级 <cwd>/.run-agent/settings.json（仅 Trust 会话加载——hook 会执行任意命令，
 *     恶意项目的 hooks 绝不自动生效，防提示注入）
 *
 * settings.json 目前只读取 `.hooks` 键（未来可扩展其它键）。同事件下用户级规则在前、
 * 项目级规则在后合并——两处 hooks 都是独立自动化，都应执行。
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

/** 五类事件（roadmap 点名；Notification/SubagentStop 等留后续）。 */
export type HookEvent = "PreToolUse" | "PostToolUse" | "SessionStart" | "SessionEnd" | "Stop";

export const HOOK_EVENTS: readonly HookEvent[] = [
  "PreToolUse",
  "PostToolUse",
  "SessionStart",
  "SessionEnd",
  "Stop",
];

/** 单条 hook 执行方式。 */
export interface HookExecution {
  type: "command" | "http";
  /** type=command：要执行的 shell 命令（经 resolveShell 运行） */
  command?: string;
  /** type=http：POST 目标 URL */
  url?: string;
  /** type=http：附加请求头 */
  headers?: Record<string, string>;
  /** 超时毫秒；缺省 30s */
  timeout?: number;
}

/** 一条 matcher 规则：匹配工具名的正则；缺省 = 匹配全部工具（Session* 事件无 matcher 概念）。 */
export interface HookRule {
  matcher?: string;
  hooks: HookExecution[];
}

/** 五类事件 → 规则列表。 */
export type HooksConfig = Partial<Record<HookEvent, HookRule[]>>;

const executionSchema = z.object({
  type: z.enum(["command", "http"]),
  command: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  timeout: z.number().int().positive().optional(),
});

const ruleSchema = z.object({
  matcher: z.string().optional(),
  hooks: z.array(executionSchema).min(1),
});

const hooksSchema = z.object({
  PreToolUse: z.array(ruleSchema).optional(),
  PostToolUse: z.array(ruleSchema).optional(),
  SessionStart: z.array(ruleSchema).optional(),
  SessionEnd: z.array(ruleSchema).optional(),
  Stop: z.array(ruleSchema).optional(),
});

/** settings.json 骨架：目前只认 hooks 键，其余忽略（为后续扩展留位）。 */
const settingsSchema = z.object({
  hooks: hooksSchema.optional(),
});

/** zod 输出带 `| undefined` 的 optional 键 → 转成 HookRule（剥 undefined，exactOptionalPropertyTypes）。 */
function toHookRule(rule: z.output<typeof ruleSchema>): HookRule {
  return {
    hooks: rule.hooks.map((h) => ({
      type: h.type,
      ...(h.command !== undefined ? { command: h.command } : {}),
      ...(h.url !== undefined ? { url: h.url } : {}),
      ...(h.headers !== undefined ? { headers: h.headers } : {}),
      ...(h.timeout !== undefined ? { timeout: h.timeout } : {}),
    })),
    ...(rule.matcher !== undefined ? { matcher: rule.matcher } : {}),
  };
}

export function userSettingsPath(homeDir: string = homedir()): string {
  return path.join(homeDir, ".config", "run-agent", "settings.json");
}

export function projectSettingsPath(cwd: string): string {
  return path.join(cwd, ".run-agent", "settings.json");
}

/** 读取单个 settings.json：不存在/不可读/超过 1MB/JSON 非法 → undefined。 */
function readSettings(file: string): HooksConfig | undefined {
  try {
    if (statSync(file).size > 1024 * 1024) return undefined;
    const parsed = settingsSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (!parsed.success) return undefined;
    // zod optional 键可能是 undefined；剥掉再回填（exactOptionalPropertyTypes）
    const out: HooksConfig = {};
    for (const ev of HOOK_EVENTS) {
      const rules = parsed.data.hooks?.[ev];
      if (rules && rules.length > 0) out[ev] = rules.map(toHookRule);
    }
    return out;
  } catch {
    return undefined;
  }
}

/**
 * 合读用户级 + 项目级 hooks 配置。项目级仅 Trust 加载。
 * 同事件合并：用户规则在前、项目规则在后（都执行）。
 */
export function loadHooksConfig(
  cwd: string,
  isTrusted: boolean,
  homeDir: string = homedir(),
): HooksConfig {
  const merged: HooksConfig = {};
  for (const cfg of [
    readSettings(userSettingsPath(homeDir)),
    isTrusted ? readSettings(projectSettingsPath(cwd)) : undefined,
  ]) {
    if (!cfg) continue;
    for (const ev of HOOK_EVENTS) {
      const rules = cfg[ev];
      if (!rules || rules.length === 0) continue;
      merged[ev] = [...(merged[ev] ?? []), ...rules];
    }
  }
  return merged;
}

/** 无任何规则 → 不创建 HookManager（零配置零开销）。 */
export function isHooksConfigEmpty(config: HooksConfig): boolean {
  return HOOK_EVENTS.every((ev) => !config[ev] || config[ev]!.length === 0);
}
