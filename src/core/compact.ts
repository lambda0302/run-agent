/**
 * V3 compact（上下文压缩）：
 * - 主动压缩：输入估算超阈值 → 整段摘要 → 单边界消息（哨兵 + 摘要 + 已读文件重挂）；
 * - 决策 8：超大工具结果指针化（结果落盘、消息里只留指针，模型需要时自己 read_file）。
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LLMClient, LLMMessage, ToolSpec } from "../providers/types.js";
import { toToolSpecs } from "../tools.js";
import type { Tool } from "../tools.js";
import { estimateInputTokens, estimateMessagesTokens, estimateTokens } from "./context.js";

/** 触发阈值 = contextWindow − 13000（钳制到窗口 60%，小窗口不溢出） */
export const COMPACT_BUFFER = 13000;
/** 边界哨兵：loadSession 从最后一个含哨兵的 user 消息之后续起 */
export const COMPACT_MARKER = "\u0000RUN_AGENT_COMPACT_BOUNDARY\u0000";
/** 摘要请求的最大输出 token */
export const COMPACT_MAX_SUMMARY_TOKENS = 1000;
/** 主动压缩的最小消息数（防过度压缩，单轮/边界不回压） */
export const COMPACT_MIN_MESSAGES = 4;
/** 重挂文件上限与单文件约束 */
export const MAX_REATTACH_FILES = 5;
export const REATTACH_MAX_LINES = 2000;
export const REATTACH_MAX_BYTES = 4 * 1024 * 1024;
/** 决策 8：超大工具结果落盘阈值（token，RUN_AGENT_RESULT_SPILL_TOKENS 可覆盖） */
export const TOOL_RESULT_SPILL_TOKENS = 8192;

const COMPACT_SYSTEM_PROMPT = `你是上下文压缩器。把用户提供的整段对话压缩成一份精炼摘要，供新上下文的起点使用。
要求：
- 保留：任务目标、已完成的步骤与结论、待办/未完成项、关键文件路径、命令与工具的关键输出、用户的偏好与约束。
- 丢弃：寒暄、重复过程、过时中间态。
- 用简洁的中文分点输出，保留关键英文术语与路径原文。`;

export function computeCompactThreshold(contextWindow: number): number {
  return Math.max(contextWindow - COMPACT_BUFFER, Math.floor(contextWindow * 0.6));
}

function resultSpillTokens(): number {
  const n = Number(process.env.RUN_AGENT_RESULT_SPILL_TOKENS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : TOOL_RESULT_SPILL_TOKENS;
}

/**
 * 决策 8：超阈值工具结果落盘，返回指针文本；未超阈值原样返回。
 * 落盘文件与 session 同目录（resultsDir），resume 后路径仍有效。
 */
export async function spillOversizedResult(
  content: string,
  index: number,
  resultsDir: string,
): Promise<string> {
  if (estimateTokens(content) <= resultSpillTokens()) return content;
  const file = path.join(resultsDir, `r${index}.txt`);
  await mkdir(resultsDir, { recursive: true });
  await writeFile(file, content, "utf8");
  const lines = content.split("\n").length;
  return `[结果已写入 ${file}(共 ${lines} 行)。需要全文时用 read_file 读取该路径]`;
}

/** 从历史里捞最近读过的 read_file 路径（去重、最多 5 个、保最近顺序）。 */
export function collectReadFiles(messages: LLMMessage[]): string[] {
  const found: string[] = [];
  for (let i = messages.length - 1; i >= 0 && found.length < MAX_REATTACH_FILES; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type !== "tool_use" || b.name !== "read_file") continue;
      const p = (b.input as { file_path?: unknown } | undefined)?.file_path;
      if (typeof p === "string" && p && !found.includes(p)) {
        found.push(p);
        if (found.length >= MAX_REATTACH_FILES) break; // 单条消息多 read_file 时也守上限
      }
    }
  }
  return found.reverse();
}

/** 本地重挂已读文件：读回内容（约束对齐 read 工具：≤4MB、非二进制、前 2000 行）。 */
async function readReattachedFiles(
  files: string[],
): Promise<Array<{ path: string; content: string }>> {
  const out: Array<{ path: string; content: string }> = [];
  for (const f of files) {
    const abs = path.resolve(f);
    try {
      const st = await stat(abs);
      if (st.isDirectory() || st.size > REATTACH_MAX_BYTES) continue;
      const buf = await readFile(abs);
      if (buf.subarray(0, 8192).includes(0)) continue; // 二进制
      const text = buf.toString("utf8").replace(/^﻿/, "");
      const lines = text.split("\n");
      out.push({ path: abs, content: lines.slice(0, REATTACH_MAX_LINES).join("\n") });
    } catch {
      continue; // 文件已不存在等：静默跳过
    }
  }
  return out;
}

/** 边界消息：哨兵 + 摘要 + 重挂文件块（role=user，作为压缩后的新起点）。 */
export function buildBoundaryMessage(
  summary: string,
  reattached: Array<{ path: string; content: string }>,
): LLMMessage {
  const parts = [`[上下文已压缩] ${COMPACT_MARKER}`, `## 对话摘要`, summary];
  if (reattached.length > 0) {
    parts.push(`## 已重新挂载的文件内容`);
    for (const f of reattached) parts.push(`--- ${f.path} ---\n${f.content}`);
  }
  return { role: "user", content: parts.join("\n\n") };
}

/**
 * 摘要历史：直接调 client.stream（无 tools、走 system 首条），流式累积文本。
 * 摘要输入先裁到 contextWindow−3000，防摘要请求自身爆窗。
 */
export async function summarizeHistory(
  client: LLMClient,
  messages: LLMMessage[],
  opts: { maxTokens?: number; contextWindow: number },
): Promise<string> {
  const budget = opts.contextWindow - 3000;
  let input = messages;
  while (estimateMessagesTokens(input) > budget && input.length > 1) {
    input = input.slice(1);
  }
  const request: LLMMessage[] = [{ role: "system", content: COMPACT_SYSTEM_PROMPT }, ...input];
  const parts: string[] = [];
  for await (const ev of client.stream(request, {
    maxTokens: opts.maxTokens ?? COMPACT_MAX_SUMMARY_TOKENS,
  })) {
    if (ev.type === "text") parts.push(ev.text);
  }
  return parts.join("").trim();
}

export interface CompactContext {
  client: LLMClient;
  tools: Tool[];
  maxTokens?: number;
  /** system prompt（估算时计入） */
  system?: string;
  contextWindow: number;
  onCompact?: () => void;
  /** 0.3.1 反应式压缩：跳过阈值与最小消息数检查，模型已经说不下了，强制压缩 */
  force?: boolean;
}

export interface CompactResult {
  /** 压缩后的新消息数组（单边界消息）；未压缩时原样返回 */
  messages: LLMMessage[];
  compacted: boolean;
}

/**
 * 主动压缩：输入估算 > 阈值且消息数达标 → 整段摘要 → 单边界消息。
 * 由 runQuery 在每轮循环顶调用（querySource==='compact' 时上层已跳过）。
 */
export async function maybeAutoCompact(
  messages: LLMMessage[],
  ctx: CompactContext,
): Promise<CompactResult> {
  if (!ctx.force) {
    const threshold = computeCompactThreshold(ctx.contextWindow);
    const toolSpecs: ToolSpec[] = toToolSpecs(ctx.tools);
    const est = estimateInputTokens(ctx.system, messages, toolSpecs);
    if (messages.length < COMPACT_MIN_MESSAGES || est <= threshold) {
      return { messages, compacted: false };
    }
  }

  const summary = await summarizeHistory(ctx.client, messages, {
    ...(ctx.maxTokens !== undefined ? { maxTokens: ctx.maxTokens } : {}),
    contextWindow: ctx.contextWindow,
  });
  const files = collectReadFiles(messages);
  const reattached = await readReattachedFiles(files);
  const boundary = buildBoundaryMessage(summary, reattached);
  ctx.onCompact?.();
  return { messages: [boundary], compacted: true };
}

/**
 * 0.3.1 硬截断兜底：反复丢最老消息直到估算 fit（至少保留 1 条）。
 * 非破坏：返回新数组。
 */
export function hardTruncateToFit(messages: LLMMessage[], maxTokens: number): LLMMessage[] {
  const out = [...messages];
  while (estimateMessagesTokens(out) > maxTokens && out.length > 1) {
    out.shift();
  }
  return out;
}

/**
 * 0.3.1 修复 tool 配对（硬截断丢消息后会出现孤儿）：
 * - 无对应 assistant `tool_use` 的 tool 结果消息 → 丢弃；
 * - 无后续 tool 结果的 `tool_use` 块 → 从 assistant 消息里清掉（全清空则整条丢弃）。
 */
export function normalizeToolPairing(messages: LLMMessage[]): LLMMessage[] {
  const useIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const m of messages) {
    if (m.role === "tool") {
      resultIds.add(m.tool_use_id);
    } else if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const b of m.content) if (b.type === "tool_use") useIds.add(b.id);
    }
  }
  const out: LLMMessage[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      if (!useIds.has(m.tool_use_id)) continue; // 孤儿结果
      out.push(m);
      continue;
    }
    if (m.role === "assistant" && Array.isArray(m.content)) {
      const blocks = m.content.filter((b) => b.type !== "tool_use" || resultIds.has(b.id));
      if (blocks.length > 0) out.push({ ...m, content: blocks });
      continue; // 块全被清空 → 整条丢弃
    }
    out.push(m);
  }
  return out;
}
