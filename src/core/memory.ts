/**
 * V4 项目记忆模块(0.4.0,Claude Code 式):
 * - 存储布局:<cwd>/.run-agent/memory/,每条记忆一个独立 md 文件(frontmatter name/description/type + 正文);
 * - 索引页 MEMORY.md(每行 `- [Title](file.md) — hook`,上限 200 行 / 25KB),常驻 system 稳定段;
 * - 读写函数供 remember 工具与 CLI memory 子命令复用;只读豁免/写入门控在权限层与工具层,不在此。
 */
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const MEMORY_DIRNAME = "memory";
export const ENTRYPOINT_NAME = "MEMORY.md";
export const MAX_ENTRYPOINT_LINES = 200;
export const MAX_ENTRYPOINT_BYTES = 25 * 1024;
export const MAX_MEMORY_FILE_BYTES = 16 * 1024;

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** 记忆内容规范:「不存什么」(供 system 指引与 docs/memory.md 复用)。 */
export const NOT_TO_SAVE_GUIDANCE =
  "不存:①代码结构/实现细节(源码/README/git 历史已有,存了必过时);" +
  "②一次性调试过程与排查方案(已解决的 bug 记进 docs/Bug_V*.md);" +
  "③已在 CLAUDE.md / system prompt 写明的约定;④会话琐事。用户要求保存清单/摘要类内容时,先问「有什么反直觉/非显而易见的部分」再存。";

// ── 路径 ────────────────────────────────────────────────────────────────────
export function memoryDirPath(cwd: string): string {
  return path.join(cwd, ".run-agent", MEMORY_DIRNAME);
}

export function topicFilePath(cwd: string, name: string): string {
  return path.join(memoryDirPath(cwd), `${name}.md`);
}

export function entrypointPath(cwd: string): string {
  return path.join(memoryDirPath(cwd), ENTRYPOINT_NAME);
}

// ── 记忆文件 ─────────────────────────────────────────────────────────────────
export interface TopicMemory {
  name: string;
  description?: string;
  type?: MemoryType;
  /** 正文(frontmatter 之外,trim 后) */
  body: string;
  /** 原文(剥 BOM 后) */
  raw: string;
}

/** 解析 topic 文件:frontmatter(name/description/type)+ 正文,剥 BOM。无 frontmatter 时按纯正文处理。 */
export function parseTopicFile(text: string): TopicMemory | undefined {
  const clean = text.replace(/^﻿/, "");
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(clean);
  if (!m) return { name: "", body: clean.trim(), raw: clean };
  const fm: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (kv) fm[kv[1]!] = kv[2]!.trim();
  }
  const t = fm["type"];
  return {
    name: fm["name"] ?? "",
    ...(fm["description"] !== undefined ? { description: fm["description"] } : {}),
    ...(t && (MEMORY_TYPES as readonly string[]).includes(t) ? { type: t as MemoryType } : {}),
    body: m[2]!.trim(),
    raw: clean,
  };
}

/** 组装 topic 文件文本(frontmatter + 空行 + 正文)。供写入与超限判定复用。 */
export function formatTopicFile(
  name: string,
  meta: { description?: string; type?: MemoryType },
  body: string,
): string {
  const fm = ["---", `name: ${name}`];
  if (meta.description) fm.push(`description: ${meta.description}`);
  if (meta.type) fm.push(`type: ${meta.type}`);
  fm.push("---");
  return fm.join("\n") + "\n\n" + body.trim() + "\n";
}

/** 写单条记忆文件(建目录、frontmatter + 正文)。大小守卫由调用方负责。 */
export async function writeTopicFile(
  cwd: string,
  name: string,
  meta: { description?: string; type?: MemoryType },
  body: string,
): Promise<void> {
  const file = topicFilePath(cwd, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, formatTopicFile(name, meta, body), "utf8");
}

// ── 元数据推导(remember 未显式给 name/description 时)────────────────────────
/** 清洗文件名 slug:小写、保留字母数字(含 CJK,unicode 属性转义)与 -。 */
export function sanitizeName(name: string): string {
  const clean = name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}-]/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return clean || "note";
}

/** 从内容推导文件名 slug:type 前缀 + 首行前几个有意义片段(CJK 段原样保留)。 */
export function deriveName(content: string, type: MemoryType = "project"): string {
  const firstLine = content.split("\n")[0]?.trim() ?? "";
  const segs = firstLine
    .split(/\s+/)
    .map((s) => s.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean)
    .slice(0, 3);
  const core = segs.join("-").toLowerCase() || "note";
  return sanitizeName(`${type}-${core}`).slice(0, 64);
}

/** 从内容推导一句话钩子:取首行,截断 80 字符。 */
export function deriveDescription(content: string): string {
  const firstLine = content.split("\n")[0]?.trim() ?? "";
  return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
}

// ── 索引页 MEMORY.md ────────────────────────────────────────────────────────
export interface IndexLine {
  title: string;
  name: string;
  hook: string;
}

const INDEX_RE = /^\s*-\s*\[(.*?)\]\(([^)]+\.md)\)\s*—\s*(.*)$/;

export function parseIndexLine(line: string): IndexLine | undefined {
  const m = INDEX_RE.exec(line.trim());
  if (!m) return undefined;
  return { title: m[1]!.trim(), name: m[2]!.replace(/\.md$/, "").trim(), hook: m[3]!.trim() };
}

/** 组装索引行:`- [标题](name.md) — hook`。标题 = 描述;feedback 类加类型前缀(与方案示例一致)。 */
export function formatIndexLine(name: string, description: string, type?: MemoryType): string {
  const title = type === "feedback" ? `Feedback: ${description}` : description;
  return `- [${title}](${name}.md) — ${description}`;
}

/** 读取索引原始行(trim + 去空行,不截断)。目录/文件不存在 → 空数组。 */
async function readRawIndexLines(dir: string): Promise<string[]> {
  let text = "";
  try {
    text = (await readFile(path.join(dir, ENTRYPOINT_NAME), "utf8")).replace(/^﻿/, "");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** 读取索引行:截断到 200 行 / 25KB,超限在尾部附警告行。目录/文件不存在 → 空数组。 */
export async function readIndexLines(dir: string): Promise<string[]> {
  const lines = await readRawIndexLines(dir);
  if (lines.length > MAX_ENTRYPOINT_LINES) {
    lines.length = MAX_ENTRYPOINT_LINES;
    lines.push(`<!-- 索引超 ${MAX_ENTRYPOINT_LINES} 行,已截断;用 run-agent memory prune 清理 -->`);
  }
  const out: string[] = [];
  let acc = 0;
  for (const l of lines) {
    const b = Buffer.byteLength(l + "\n", "utf8");
    if (acc + b > MAX_ENTRYPOINT_BYTES) {
      out.push(
        `<!-- 索引超 ${MAX_ENTRYPOINT_BYTES} 字节,已截断;用 run-agent memory prune 清理 -->`,
      );
      break;
    }
    out.push(l);
    acc += b;
  }
  return out;
}

/** 在索引行列表上应用「按 name 摘除旧行 + 追加新行」(更新语义)。 */
function applyIndexEdit(lines: string[], line: string, replaceName?: string): string[] {
  const without = replaceName
    ? lines.filter((l) => {
        const p = parseIndexLine(l);
        return !(p && p.name === replaceName);
      })
    : [...lines];
  without.push(line);
  return without;
}

export interface IndexWriteResult {
  ok: boolean;
  reason?: "over-limit";
}

/** 预检:在索引上追加(可先按 name 摘除旧行)是否超限;不写盘。 */
export async function peekIndexWrite(
  dir: string,
  line: string,
  opts: { replaceName?: string } = {},
): Promise<IndexWriteResult> {
  const lines = await readRawIndexLines(dir);
  const next = applyIndexEdit(lines, line, opts.replaceName);
  if (next.length > MAX_ENTRYPOINT_LINES) return { ok: false, reason: "over-limit" };
  if (Buffer.byteLength(next.join("\n") + "\n", "utf8") > MAX_ENTRYPOINT_BYTES)
    return { ok: false, reason: "over-limit" };
  return { ok: true };
}

/** 追加索引行(按 name 先更新);超限返回失败不写盘。 */
export async function appendIndexLine(
  dir: string,
  line: string,
  opts: { replaceName?: string } = {},
): Promise<IndexWriteResult> {
  const check = await peekIndexWrite(dir, line, opts);
  if (!check.ok) return check;
  const lines = await readRawIndexLines(dir);
  const next = applyIndexEdit(lines, line, opts.replaceName);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, ENTRYPOINT_NAME), next.join("\n") + "\n", "utf8");
  return { ok: true };
}

/** 摘除某条记忆的索引行;返回是否真的移除了一行。 */
export async function removeIndexLine(dir: string, name: string): Promise<boolean> {
  const lines = await readRawIndexLines(dir);
  const next = lines.filter((l) => {
    const p = parseIndexLine(l);
    return !(p && p.name === name);
  });
  if (next.length === lines.length) return false;
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, ENTRYPOINT_NAME), next.join("\n") + "\n", "utf8");
  return true;
}

// ── system 注入块 ───────────────────────────────────────────────────────────
/**
 * 组装 system 稳定段的 MEMORY.md 注入块:仅 Trust 会话注入,无可解析索引 → undefined。
 * 只收录可解析的索引行(警告注释是给 CLI 看的,不进模型上下文)。
 */
export async function buildMemoryIndexBlock(
  dir: string,
  isTrusted: boolean,
): Promise<string | undefined> {
  if (!isTrusted) return undefined;
  const lines = (await readIndexLines(dir)).filter((l) => parseIndexLine(l));
  if (lines.length === 0) return undefined;
  const header =
    "## MEMORY.md(项目记忆索引)\n" +
    "以下 = 跨会话记忆的索引(每行 = 标题 + 文件 + 一句钩子)。与当前任务相关时,用 read_file 读对应文件全文再采信。" +
    "记忆是快照,可能过时——先对照当前代码/用户最新指示验证,冲突以现状为准,过时就更新或删除。";
  return header + "\n" + lines.join("\n");
}

// ── CLI 维护操作 ────────────────────────────────────────────────────────────
export interface MemorySummary {
  name: string;
  title: string;
  hook: string;
}

/** 列出索引条目(CLI list);query 命中 title / hook / name(大小写不敏感)。 */
export async function listMemories(cwd: string, query?: string): Promise<MemorySummary[]> {
  const lines = await readIndexLines(memoryDirPath(cwd));
  const q = query?.trim().toLowerCase();
  return lines
    .map(parseIndexLine)
    .filter((l): l is IndexLine => Boolean(l))
    .filter((l) => !q || `${l.title} ${l.hook} ${l.name}`.toLowerCase().includes(q))
    .map((l) => ({ name: l.name, title: l.title, hook: l.hook }));
}

/** 删除 topic 文件 + 摘除索引行(幂等:文件不存在也算成功)。 */
export async function removeMemory(cwd: string, name: string): Promise<boolean> {
  await rm(topicFilePath(cwd, name), { force: true });
  return removeIndexLine(memoryDirPath(cwd), name);
}

/** 删除早于 N 天(默认 30)的 topic 文件 + 摘除索引行;返回删除数。 */
export async function pruneMemories(cwd: string, days = 30): Promise<number> {
  const dir = memoryDirPath(cwd);
  let names: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    names = entries
      .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== ENTRYPOINT_NAME)
      .map((e) => e.name.slice(0, -3));
  } catch {
    return 0;
  }
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of names) {
    const file = topicFilePath(cwd, name);
    try {
      const s = await stat(file);
      if (s.mtimeMs < cutoff) {
        await rm(file, { force: true });
        await removeIndexLine(dir, name);
        removed++;
      }
    } catch {
      // 文件并发被删 → 跳过
    }
  }
  return removed;
}
