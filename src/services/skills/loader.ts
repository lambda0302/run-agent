/**
 * V6 决策 B1：技能扫描 + frontmatter 解析 + Trust 门控。
 *
 * 路径（自有路径，与 CLAUDE.md 记忆同约定，无 `.claude/`）：
 *   - 用户级 ~/.config/run-agent/skills/<name>/SKILL.md（用户自写，始终加载）
 *   - 项目级 <cwd>/.run-agent/skills/<name>/SKILL.md（仅 Trust 会话加载）
 * `.run-agent` 是内置 deny 段：loader 直接 fs 直读（与 CLAUDE.md 同机制），
 * 模型没有任何工具能偷看技能文件，提示注入面比 `.claude/` 更低。
 *
 * SKILL.md 格式对齐 Claude Code：frontmatter（YAML 子集，只认 name/description/allowed-tools）
 * + body（技能指令文本）。非法 frontmatter → 跳过并记入 skipped（不阻断启动）。
 *
 * body 惰性加载（V6 修复，对齐 Claude Code 渐进式披露）：registry 只持有 frontmatter +
 * 文件路径，**不持有 body**——启动只做一次性 frontmatter 扫描；SkillTool.call / REPL
 * `/技能名` 时经 `readSkillBody` 从磁盘现读 → 内存不膨胀 + 文件改动即热更新。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

/** registry 条目（含 frontmatter 元数据 + 文件路径；body 调用时现读）。 */
export interface Skill {
  name: string;
  description: string;
  /** 限制技能可用工具（工具名数组，支持 mcp__* 通配）；缺省 = 全部工具。 */
  allowedTools?: string[];
  /** SKILL.md 绝对路径（name→path 只经 registry 解析，绝不从入参拼接）。 */
  path: string;
  source: "user" | "project";
}

/** `parseSkillFile` 的完整解析结果（含 body；仅 loader 内部与 readSkillBody 使用）。 */
export interface ParsedSkill {
  name: string;
  description: string;
  allowedTools?: string[];
  body: string;
  source: "user" | "project";
}

/** 单文件上限（防恶意巨型技能灌爆）。 */
export const MAX_SKILL_BYTES = 100 * 1024;

const frontmatterSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9_-]*$/),
  description: z.string().min(1),
  "allowed-tools": z.array(z.string().min(1)).optional(),
});

/** YAML 标量：剥首尾空格 + 引号。 */
function parseScalar(v: string): string {
  const s = v.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/** YAML 子集解析：`key: value` 标量 + `key:` 下的 `- item` 列表（只认这两形态）。 */
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

/** 从 SKILL.md 全文解析出技能；frontmatter 缺失/非法 → undefined（调用方告警）。 */
export function parseSkillFile(text: string, source: "user" | "project"): ParsedSkill | undefined {
  const t = text.replace(/^﻿/, ""); // 剥 BOM
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(t);
  if (!m) return undefined;
  const [, fm, body] = m;
  const parsed = frontmatterSchema.safeParse(parseFrontmatter(fm!));
  if (!parsed.success) return undefined;
  return {
    name: parsed.data.name,
    description: parsed.data.description,
    ...(parsed.data["allowed-tools"] !== undefined
      ? { allowedTools: parsed.data["allowed-tools"] }
      : {}),
    body: body!.trim(),
    source,
  };
}

export function userSkillsDir(homeDir: string = homedir()): string {
  return path.join(homeDir, ".config", "run-agent", "skills");
}

export function projectSkillsDir(cwd: string): string {
  return path.join(cwd, ".run-agent", "skills");
}

/** 扫描单目录下的 <name>/SKILL.md；大小超限/解析失败 → 记入 skipped。 */
function scanDir(dir: string, source: "user" | "project", skipped: string[]): Skill[] {
  const out: Skill[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // 目录不存在 → 空
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const md = path.join(dir, ent.name, "SKILL.md");
    let text: string;
    try {
      if (statSync(md).size > MAX_SKILL_BYTES) {
        skipped.push(ent.name);
        continue;
      }
      text = readFileSync(md, "utf8");
    } catch {
      continue; // 无 SKILL.md / 不可读 → 跳过
    }
    const parsed = parseSkillFile(text, source);
    if (!parsed) {
      skipped.push(ent.name);
      continue;
    }
    // registry 条目只持 frontmatter + path，不持有 body（惰性加载，见 readSkillBody）
    out.push({
      name: parsed.name,
      description: parsed.description,
      ...(parsed.allowedTools !== undefined ? { allowedTools: parsed.allowedTools } : {}),
      path: md,
      source,
    });
  }
  return out;
}

/**
 * 惰性读取技能 body（V6 修复）：SkillTool.call / REPL `/技能名` 时从磁盘现读 SKILL.md，
 * 内存不持有 body——启动只做 frontmatter 扫描（渐进式披露，对齐 Claude Code），
 * 且文件改动无需重启即热更新。调用时重新 stat 大小上限 + 重新解析 frontmatter；
 * 失败 → 返回错误文本（tool_result 兜底，不抛、不阻断主流程）。
 */
export function readSkillBody(skill: Skill): string {
  try {
    if (statSync(skill.path).size > MAX_SKILL_BYTES) {
      return `[技能文件超过 ${MAX_SKILL_BYTES / 1024}KB 上限，读取失败]`;
    }
    const parsed = parseSkillFile(readFileSync(skill.path, "utf8"), skill.source);
    return parsed ? parsed.body : "[技能文件 frontmatter 解析失败]";
  } catch {
    return "[技能文件读取失败（可能已被移除）]";
  }
}

/**
 * 合读用户级 + 项目级技能。项目级仅 Trust 加载。
 * 返回 skills + skipped（解析失败/超限的技能名，供告警展示）。
 * 同名去重：用户级优先（与 CLAUDE.md 记忆优先级一致），后出现的项目级同名技能丢弃。
 */
export function loadSkills(
  cwd: string,
  isTrusted: boolean,
  homeDir: string = homedir(),
): { skills: Skill[]; skipped: string[] } {
  const skipped: string[] = [];
  const seen = new Set<string>();
  const skills: Skill[] = [];
  for (const skill of [
    ...scanDir(userSkillsDir(homeDir), "user", skipped),
    ...(isTrusted ? scanDir(projectSkillsDir(cwd), "project", skipped) : []),
  ]) {
    if (seen.has(skill.name)) continue; // 用户级优先，项目级同名丢弃
    seen.add(skill.name);
    skills.push(skill);
  }
  return { skills, skipped };
}
