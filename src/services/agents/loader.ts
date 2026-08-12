/**
 * V7 决策 B2：agent 类型扫描 + frontmatter 解析 + Trust 门控（团队状态持久化载体）。
 *
 * 路径（自有路径，与 skills/commands 同约定，无 `.claude/`）：
 *   - 用户级 ~/.config/run-agent/agents/<name>.md（用户自写，始终加载）
 *   - 项目级 <cwd>/.run-agent/agents/<name>.md（仅 Trust 会话加载）
 * `.run-agent` 是内置 deny 段：loader 直接 fs 直读，模型没有任何工具能碰 agent 定义文件。
 *
 * 格式：frontmatter（YAML 子集，name 必填 slug；description/model/tools/system/maxIterations 可选）
 * + body（类型专属指令，并入子 system）。非法 frontmatter → 跳过并记入 skipped（不阻断启动）。
 * 与 skills 不同：agent 类型定义小、agent 工具每次调用都要拼子 system，故启动时读 body 进内存，
 * 不做惰性加载。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { CORE_TEAM_TOOLS } from "./registry.js";
import type { AgentTypeDef } from "./registry.js";

/** 单文件上限（防恶意巨型定义灌爆）。 */
export const MAX_AGENT_BYTES = 100 * 1024;

const frontmatterSchema = z.object({
  name: z.string().min(1).regex(/^[a-z0-9][a-z0-9_-]*$/),
  description: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  tools: z.array(z.string().min(1)).optional(),
  system: z.string().min(1).optional(),
  maxIterations: z.coerce.number().int().min(1).optional(),
});

/** YAML 标量：剥首尾空格 + 引号。 */
function parseScalar(v: string): string {
  const s = v.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/** YAML 子集解析：`key: value` 标量 + `key:` 下的 `- item` 列表（与 skills loader 同构）。 */
function parseFrontmatter(fm: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let key: string | undefined;
  for (const line of fm.split(/\r?\n/)) {
    if (/^\s*$/.test(line)) continue;
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1]!;
      out[key] = parseScalar(kv[2]!);
      continue;
    }
    const item = /^\s*-\s*(.*)$/.exec(line);
    if (item && key) {
      const arr = Array.isArray(out[key]) ? (out[key] as string[]) : [];
      arr.push(parseScalar(item[1]!));
      out[key] = arr;
    }
  }
  return out;
}

/** 从 agent 定义文件全文解析出类型；frontmatter 缺失/非法 → undefined（调用方告警）。 */
export function parseAgentFile(text: string): AgentTypeDef | undefined {
  const t = text.replace(/^﻿/, ""); // 剥 BOM
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(t);
  if (!m) return undefined;
  const [, fm, body] = m;
  const parsed = frontmatterSchema.safeParse(parseFrontmatter(fm!));
  if (!parsed.success) return undefined;
  const { name, description, model, tools, system, maxIterations } = parsed.data;
  const allowed = tools ? new Set(tools) : undefined;
  return {
    name,
    description: description ?? name,
    ...(model !== undefined ? { model } : {}),
    ...(maxIterations !== undefined ? { maxIterations } : {}),
    // tools 显式声明 → 只给声明的工具（显式含 agent/send_message/task_stop 即开协调权）；
    // tools 缺省 → 父级全部工具、默认不含三件套（worker 无协调权，防递归失控）
    resolveTools: (parent) => {
      const pool = allowed ? parent().filter((t) => allowed.has(t.name)) : parent();
      return allowed ? pool : pool.filter((t) => !CORE_TEAM_TOOLS.has(t.name));
    },
    // 子 system = frontmatter system 片段 + body（类型专属指令），并入父级 system 快照
    ...(system || (body && body.trim())
      ? { system: [system, body?.trim()].filter(Boolean).join("\n\n") }
      : {}),
  };
}

export function userAgentsDir(homeDir: string = homedir()): string {
  return path.join(homeDir, ".config", "run-agent", "agents");
}

export function projectAgentsDir(cwd: string): string {
  return path.join(cwd, ".run-agent", "agents");
}

/** 扫描单目录下的 <name>.md；大小超限/解析失败 → 记入 skipped。 */
function scanDir(dir: string, skipped: string[]): AgentTypeDef[] {
  const out: AgentTypeDef[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out; // 目录不存在 → 空
  }
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const file = path.join(dir, name);
    let text: string;
    try {
      if (statSync(file).size > MAX_AGENT_BYTES) {
        skipped.push(name);
        continue;
      }
      text = readFileSync(file, "utf8");
    } catch {
      continue; // 不可读 → 跳过
    }
    const def = parseAgentFile(text);
    if (!def) {
      skipped.push(name);
      continue;
    }
    out.push(def);
  }
  return out;
}

/**
 * 合读用户级 + 项目级 agent 类型。项目级仅 Trust 加载。
 * 返回 agents + skipped（解析失败/超限的文件名，供告警展示）。
 * 同名去重：用户级优先（与 CLAUDE.md 记忆优先级一致），后出现的项目级同名丢弃。
 * 内置名冲突由 AgentRegistry.register 决定（内置优先），此处只去重自定义内部。
 */
export function loadAgents(
  cwd: string,
  isTrusted: boolean,
  homeDir: string = homedir(),
): { agents: AgentTypeDef[]; skipped: string[] } {
  const skipped: string[] = [];
  const seen = new Set<string>();
  const agents: AgentTypeDef[] = [];
  for (const def of [
    ...scanDir(userAgentsDir(homeDir), skipped),
    ...(isTrusted ? scanDir(projectAgentsDir(cwd), skipped) : []),
  ]) {
    if (seen.has(def.name)) continue;
    seen.add(def.name);
    agents.push(def);
  }
  return { agents, skipped };
}
