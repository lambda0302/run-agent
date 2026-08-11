/**
 * V3 上下文组装：
 * - token 估算（零依赖启发式，CJK 加权）；
 * - git 状态收集（并发 execFile + 800ms 超时 + 3s TTL 缓存）；
 * - system prompt 组装（稳定/动态边界：稳定前缀保 cache 复用，动态后缀是日期/git）；
 * - CLAUDE.md 四级记忆（managed→user→project→local，直读 fs，project/local 受 Trust 门控）。
 */
import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { LLMMessage, ToolSpec } from "../providers/types.js";

// ── token 估算 ──────────────────────────────────────────────────────────────
// CJK 区间：全角标点 + 扩展 A + 基本汉字 + 兼容表意 + 半全角形式
const CJK = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]/g;

/** 启发式估算：CJK 每字 1 token，其余按 4 字符 1 token（与主流 tokenizer 大致同量级）。 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK)?.length ?? 0;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

/** 单条消息估算：tool 消息有固定开销，块内容用 JSON.stringify 整体估。 */
export function estimateMessageTokens(m: LLMMessage): number {
  if (m.role === "tool") return estimateTokens(m.content) + 3;
  if (typeof m.content === "string") return estimateTokens(m.content);
  return estimateTokens(JSON.stringify(m.content)) + 2;
}

export function estimateMessagesTokens(msgs: LLMMessage[]): number {
  let n = 0;
  for (const m of msgs) n += estimateMessageTokens(m);
  return n;
}

const toolsTokenCache = new Map<string, number>();

/** 工具定义估算（tools 静态，估一次缓存，按工具名签名）。 */
export function estimateToolsTokens(tools: ToolSpec[]): number {
  const key = tools.map((t) => t.name).join("|");
  const hit = toolsTokenCache.get(key);
  if (hit !== undefined) return hit;
  let n = 0;
  for (const t of tools) {
    n += estimateTokens(JSON.stringify({ name: t.name, description: t.description })) + 4;
    n += estimateTokens(JSON.stringify(t.inputSchema)) + 2;
  }
  toolsTokenCache.set(key, n);
  return n;
}

/** 输入总量估算：system + 消息列表 + 工具定义。 */
export function estimateInputTokens(
  system: string | undefined,
  messages: LLMMessage[],
  tools: ToolSpec[],
): number {
  return (
    (system ? estimateTokens(system) : 0) +
    estimateMessagesTokens(messages) +
    estimateToolsTokens(tools)
  );
}

// ── git 上下文 ──────────────────────────────────────────────────────────────
export interface GitContext {
  branch?: string;
  /** 短 commit sha */
  sha?: string;
  recentCommit?: string;
  user?: string;
  /** `git status --short` 前 5 行摘要；clean 时是 "clean" */
  status?: string;
}

const GIT_TIMEOUT_MS = 800;
const GIT_TTL_MS = 3000;
const gitCache = new Map<string, { at: number; ctx: GitContext }>();

interface GitRun {
  ok: boolean;
  text?: string;
}

function runGit(cwd: string, args: string[]): Promise<GitRun> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 },
      (err, stdout) => {
        if (err) return resolve({ ok: false });
        resolve({ ok: true, text: stdout.trim() });
      },
    );
  });
}

/** 并发收集 git 上下文；非 git 目录或命令失败时对应字段留空。3s TTL 按 cwd 缓存。 */
export async function collectGitContext(cwd: string): Promise<GitContext> {
  const now = Date.now();
  const cached = gitCache.get(cwd);
  if (cached && now - cached.at < GIT_TTL_MS) return cached.ctx;

  const [branch, sha, recentCommit, user, status] = await Promise.all([
    runGit(cwd, ["branch", "--show-current"]),
    runGit(cwd, ["rev-parse", "--short", "HEAD"]),
    runGit(cwd, ["log", "-1", "--format=%s"]),
    runGit(cwd, ["config", "user.name"]),
    runGit(cwd, ["status", "--short"]),
  ]);

  const ctx: GitContext = {};
  if (branch.ok && branch.text) ctx.branch = branch.text;
  if (sha.ok && sha.text) ctx.sha = sha.text;
  if (recentCommit.ok && recentCommit.text) ctx.recentCommit = recentCommit.text;
  if (user.ok && user.text) ctx.user = user.text;
  if (status.ok)
    ctx.status = status.text ? status.text.split("\n").slice(0, 5).join("; ") : "clean";

  gitCache.set(cwd, { at: now, ctx });
  return ctx;
}

// ── CLAUDE.md 四级记忆 ──────────────────────────────────────────────────────
/** 记忆文件大小上限（超过则不注入；remember 工具同样以它为写入守卫）。 */
export const MAX_MEMORY_BYTES = 32 * 1024;

/** 内置预留层路径（本版为空，仅保留结构）。homeDir 可注入（测试沙箱用）。 */
export function managedClaudeFilePath(homeDir: string = homedir()): string {
  return path.join(homeDir, ".config", "run-agent", "CLAUDE.managed.md");
}

export function userClaudeFilePath(homeDir: string = homedir()): string {
  return path.join(homeDir, ".config", "run-agent", "CLAUDE.md");
}

/** 读取单个记忆文件：直读 fs、剥 BOM、超 32KB 放弃。文件不存在/不可读 → undefined。 */
function readMemoryFile(file: string): string | undefined {
  try {
    if (statSync(file).size > MAX_MEMORY_BYTES) return undefined;
    const text = readFileSync(file, "utf8").replace(/^﻿/, "");
    return text.trim() ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 收集四级 CLAUDE.md 记忆，返回带来源标注的文本块；全空返回 undefined。
 * project/local 级仅当项目受信任才读（防提示注入）。直读 fs、不走工具，
 * 因此与内置 deny 对 `.run-agent` 路径的*工具*限制不冲突（路径类工具硬 deny +
 * `run_bash` 命令里引用 `.run-agent` 段同样收口，见 engine.ts AGENT_DIR_BASH_RE）。
 */
export function collectClaudeFiles(
  cwd: string,
  isTrusted: boolean,
  homeDir: string = homedir(),
): string | undefined {
  const entries: Array<{ level: string; path: string; content: string }> = [];

  const managedPath = managedClaudeFilePath(homeDir);
  const managed = readMemoryFile(managedPath);
  if (managed) entries.push({ level: "managed", path: managedPath, content: managed });

  const userPath = userClaudeFilePath(homeDir);
  const userC = readMemoryFile(userPath);
  if (userC) entries.push({ level: "user", path: userPath, content: userC });

  if (isTrusted) {
    const projectPath = path.join(cwd, "CLAUDE.md");
    const projectC = readMemoryFile(projectPath);
    if (projectC) entries.push({ level: "project", path: projectPath, content: projectC });

    const localPath = path.join(cwd, ".run-agent", "CLAUDE.md");
    const localC = readMemoryFile(localPath);
    if (localC) entries.push({ level: "local", path: localPath, content: localC });
  }

  if (entries.length === 0) return undefined;
  return entries.map((e) => `--- [${e.level}] ${e.path} ---\n${e.content}`).join("\n\n");
}

// ── system prompt 组装 ──────────────────────────────────────────────────────
export interface SystemContext {
  cwd: string;
  isTrusted: boolean;
  /** --bare：禁用全部记忆与动态上下文注入 */
  bare: boolean;
}

const STABLE_SYSTEM = `你是 run-agent，一个运行在终端里的编码 agent。
- 通过工具读写文件、搜索代码、运行命令来完成任务；一切事实以工具返回为准，不要臆造文件内容、命令输出或搜索结果。
- 动手前先规划：小任务直接做，大任务拆成步骤逐步完成并说明进展。
- 使用用户的语言回复，保持简洁，聚焦结论与关键改动。
- 有长期记忆（system 里注入了 CLAUDE.md）：用户明确要求「记住」或发现值得跨会话保留的稳定结论时，用 remember 工具写入（自动去重）；不要自行猜测记忆里有什么。`;

const DYNAMIC_DIVIDER = "\n\n──────────────────────── 动态上下文 ────────────────────────\n";

function formatDynamic(ctx: SystemContext, git: GitContext, date: string): string {
  const bits: string[] = [`当前时间: ${date}`, `工作目录: ${ctx.cwd}`];
  const gitBits: string[] = [];
  if (git.branch) gitBits.push(`分支 ${git.branch}`);
  if (git.sha) gitBits.push(`commit ${git.sha}`);
  if (git.recentCommit) gitBits.push(`最近提交: ${git.recentCommit}`);
  if (git.user) gitBits.push(`git user: ${git.user}`);
  if (gitBits.length > 0) bits.push(`git: ${gitBits.join(" · ")}`);
  if (git.status) bits.push(`git status: ${git.status}`);
  return bits.join("\n");
}

/**
 * 组装 system prompt：稳定部分（角色准则 + CLAUDE.md 记忆）+ 动态部分（日期/git/目录）。
 * 动态在后、稳定在前，保住稳定前缀的 prompt cache 复用。
 * @param opts.git 注入 git 上下文（测试用）；缺省时内部收集。
 */
export async function buildSystemPrompt(
  ctx: SystemContext,
  opts: { git?: GitContext; date?: string; homeDir?: string } = {},
): Promise<string | undefined> {
  if (ctx.bare) return undefined;
  const git = opts.git ?? (await collectGitContext(ctx.cwd));
  const date = opts.date ?? new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";

  const stableParts = [STABLE_SYSTEM];
  const memory = collectClaudeFiles(ctx.cwd, ctx.isTrusted, opts.homeDir);
  if (memory) stableParts.push(memory);

  return stableParts.join("\n\n") + DYNAMIC_DIVIDER + formatDynamic(ctx, git, date);
}
