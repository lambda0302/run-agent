import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Tool, ToolCallResult } from "../tools.js";
import { MAX_MEMORY_BYTES, userClaudeFilePath } from "../core/context.js";
import {
  MAX_MEMORY_FILE_BYTES,
  MEMORY_TYPES,
  appendIndexLine,
  deriveDescription,
  deriveName,
  formatIndexLine,
  formatTopicFile,
  memoryDirPath,
  parseTopicFile,
  peekIndexWrite,
  sanitizeName,
  topicFilePath,
  writeTopicFile,
} from "../core/memory.js";
import type { MemoryType } from "../core/memory.js";

const schema = z.object({
  content: z.string().min(1).describe("The fact, preference, or lesson to remember"),
  scope: z
    .enum(["project", "user"])
    .optional()
    .describe(
      "Where to persist. Default 'project': the current project's memory " +
        "(.run-agent/memory/, one file per memory + MEMORY.md index) — use this for your " +
        "own cross-session learning. 'user': ~/.config/run-agent/CLAUDE.md — ONLY when the " +
        "user explicitly asks you to update their user-level memory; never proactively.",
    ),
  type: z
    .enum([...MEMORY_TYPES])
    .optional()
    .describe("Memory type for frontmatter: user | feedback | project | reference"),
  name: z
    .string()
    .optional()
    .describe(
      "Filename slug (kebab-case, e.g. 'feedback-testing'). Auto-derived from content if omitted",
    ),
  description: z
    .string()
    .optional()
    .describe(
      "One-line relevance description for frontmatter + index hook. Auto-derived if omitted",
    ),
});

export interface RememberToolOptions {
  /** scope="user" 时写用户级 CLAUDE.md 需要；默认 os.homedir()（测试沙箱注入）。 */
  homeDir?: string;
  /** scope="project" 时写入的基准目录（= 当前项目根）。 */
  cwd?: string;
  /** scope="project" 的 Trust 门控；未信任项目拒绝写项目记忆。 */
  isTrusted?: boolean;
}

/** 写用户级长期记忆（0.3.2 行为保留：单文件 CLAUDE.md，去重 + 32KB 守卫）。 */
async function writeUserMemory(content: string, home: string): Promise<ToolCallResult> {
  const file = userClaudeFilePath(home);
  try {
    let existing = "";
    try {
      existing = (await readFile(file, "utf8")).replace(/^﻿/, "");
    } catch {
      // 文件尚不存在 → 视为空
    }
    if (existing.includes(content)) {
      return { result: "该内容已在用户级长期记忆中，跳过重复写入" };
    }
    const next =
      (existing.endsWith("\n") || existing === "" ? existing : existing + "\n") + `- ${content}\n`;
    if (Buffer.byteLength(next, "utf8") > MAX_MEMORY_BYTES) {
      return {
        result: `用户级记忆文件已达上限（>${MAX_MEMORY_BYTES} 字节，超出后不再被注入），拒绝写入。请手动精简 ${file} 后再试。`,
      };
    }
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, next, "utf8");
    return { result: `已记住（用户级）：${content}` };
  } catch (e) {
    return { result: `写入用户级记忆失败: ${e instanceof Error ? e.message : String(e)}` };
  }
}

interface ProjectMemoryInput {
  content: string;
  type?: MemoryType;
  name?: string;
  description?: string;
  cwd?: string;
  isTrusted?: boolean;
}

/**
 * 写项目级记忆：一条记忆一个 `name.md`（frontmatter + 正文）+ MEMORY.md 索引更新。
 * - Trust 门控：未信任拒绝；
 * - 去重：同 name 已存在且正文一致 → 跳过；不同 → 更新原文件与索引行，不重复建文件；
 * - 守卫：正文文件 >16KB 拒写；索引将超 200 行/25KB 拒写（先预检后写，写完超限则回滚）。
 */
async function writeProjectMemory(args: ProjectMemoryInput): Promise<ToolCallResult> {
  const { content } = args;
  if (!args.cwd) {
    return { result: "缺少工作目录（cwd），无法写入项目记忆（工厂装配时应注入）" };
  }
  if (!args.isTrusted) {
    return {
      result:
        "项目未受信任，无法写入项目记忆。先运行 run-agent trust 信任当前目录，或改用 scope='user'（仅用户明确要求时）。",
    };
  }
  const type = args.type ?? "project";
  const name = sanitizeName(args.name ?? deriveName(content, type));
  const description = (args.description ?? deriveDescription(content)).trim();
  const dir = memoryDirPath(args.cwd);
  const file = topicFilePath(args.cwd, name);

  // 去重：同 name 已存在且正文一致 → 跳过（更新语义：正文不同才重写）
  try {
    const existing = parseTopicFile(await readFile(file, "utf8"));
    if (existing && existing.body === content) {
      return { result: `记忆 ${name} 已存在且内容一致，跳过重复写入` };
    }
  } catch {
    // 文件不存在 → 新建
  }

  // 正文文件大小守卫
  const topic = formatTopicFile(name, { description, type }, content);
  if (Buffer.byteLength(topic, "utf8") > MAX_MEMORY_FILE_BYTES) {
    return {
      result: `记忆文件超上限（>${MAX_MEMORY_FILE_BYTES} 字节，超出后不会注入），拒绝写入。请精简内容后重试。`,
    };
  }

  // 索引守卫：先预检（避免写完 topic 文件才发现索引超限），后写
  const line = formatIndexLine(name, description, type);
  const peek = await peekIndexWrite(dir, line, { replaceName: name });
  if (!peek.ok) {
    return {
      result:
        "MEMORY.md 索引已达上限（200 行/25KB），拒绝写入。请先运行 run-agent memory prune 清理过期记忆。",
    };
  }

  await writeTopicFile(args.cwd, name, { description, type }, content);
  const append = await appendIndexLine(dir, line, { replaceName: name });
  if (!append.ok) {
    // 罕见竞态：索引超限 → 回滚刚写的 topic 文件
    await rm(file, { force: true });
    return {
      result:
        "MEMORY.md 索引已达上限，本次写入已回滚。请先运行 run-agent memory prune 清理过期记忆。",
    };
  }
  return { result: `已记住（项目级 · ${type}）：${content}` };
}

/**
 * remember 工具：主动沉淀跨会话记忆。
 * - scope 默认 "project"：写 `.run-agent/memory/<name>.md` + 更新 MEMORY.md 索引（写目标内部计算，不接受入参路径）；
 * - scope="user"：写用户级 CLAUDE.md（仅用户明确要求时用，system 指引 + 工具描述约束）；
 * - 权限引擎门控（V8）：default/acceptEdits/plan 全模式 allow（engine 第 4.6 步记忆写豁免，
 *   仅 Trust；未 Trust 走兜底 ask/plan deny）——写目标硬编码 + Trust 门，引擎无路径可防；
 *   用户 deny 规则仍最高；
 * - homeDir/cwd/isTrusted 由 CLI 装配时注入（测试沙箱注入 homeDir）。
 */
export function makeRememberTool(opts: RememberToolOptions = {}): Tool {
  const home = opts.homeDir ?? homedir();
  return {
    name: "remember",
    description:
      "Persist a fact, preference, or lesson to long-term memory. Default scope 'project': " +
      "writes one file per memory under the current project's .run-agent/memory/ and updates " +
      "the MEMORY.md index — use for your own cross-session learning. scope='user' writes to " +
      "~/.config/run-agent/CLAUDE.md — ONLY use when the user explicitly asks you to update " +
      "their user-level memory, never proactively.",
    inputSchema: schema,
    isConcurrencySafe: false,
    async call(input): Promise<ToolCallResult> {
      const { content, scope, type, name, description } = schema.parse(input);
      const trimmed = content.trim();
      if ((scope ?? "project") === "user") return writeUserMemory(trimmed, home);
      return writeProjectMemory({
        content: trimmed,
        ...(type ? { type } : {}),
        ...(name ? { name } : {}),
        ...(description ? { description } : {}),
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.isTrusted !== undefined ? { isTrusted: opts.isTrusted } : {}),
      });
    },
  };
}
