/**
 * repo_map 工具（0.4.1 决策 D / 8.1）：两遍排序定位候选文件。
 * 第一遍：git ls-files（按 cwd+HEAD sha 缓存 60s）→ 段/扩展名过滤 → 按 文件名>路径段>其他 打分取 top-N；
 * 第二遍：只对 top-N 做符号正则扫描（ts/js/py/go），按 maxBytes 预算返回「候选文件 + 符号行」。
 * 非 git 仓库退化为 readdir；git 缺失/超时返回空 + 提示。只读、免确认（isConcurrencySafe: true）。
 * 零新依赖，不用 tree-sitter——符号 regex 只是「候选提示」，模型 read_file 精读为准。
 */
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Tool, ToolCallResult } from "../tools.js";

const MAX_CANDIDATES = 30; // 第二遍符号扫描的文件上限（top-N）
const MAX_BYTES_DEFAULT = 4096;
const MAX_BYTES_LIMIT = 32768;
const MAX_FILE_BYTES = 1024 * 1024; // 单文件 >1MB 跳过
const MAX_READDIR_FILES = 5000; // 非 git 降级的递归上限
const MAX_SYMBOLS_PER_FILE = 100;
const GIT_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 60_000;

/** 段黑名单：版本库 / agent 自身目录 / 依赖 / 构建产物——永不进候选。 */
const IGNORED_SEGMENTS = new Set([
  ".git",
  "node_modules",
  ".run-agent",
  ".claude",
  "dist",
  "coverage",
]);

/** 二进制/锁定文件扩展名：第一遍即排除，避免污染 top-N。 */
const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg",
  "pdf", "zip", "gz", "tgz", "tar", "rar", "7z", "woff", "woff2", "ttf", "eot", "otf",
  "mp3", "mp4", "mkv", "avi", "mov", "wav", "wasm", "dll", "exe", "so", "dylib",
  "o", "a", "obj", "class", "jar", "pyc", "pyo", "pyd", "lock", "map",
]);

/** 按语言匹配顶层声明行的轻量正则（per-extension，不用 tree-sitter）。 */
const SYMBOL_PATTERNS: Record<string, RegExp> = {
  ts: /^(export )?(async )?(function|class|interface|type|const|enum) \w+/,
  js: /^(export )?(async )?(function|class|interface|type|const|enum) \w+/,
  py: /^(class |def |async def )/,
  go: /^(func |type .* struct|type .* interface)/,
};

const EXT_LANG: Record<string, string> = {
  ".ts": "ts", ".tsx": "ts", ".mts": "ts", ".cts": "ts",
  ".js": "js", ".jsx": "js", ".mjs": "js", ".cjs": "js",
  ".py": "py",
  ".go": "go",
};

function extOf(file: string): string {
  return path.extname(file).toLowerCase();
}

/**
 * 第一遍过滤：路径段黑名单 + 二进制扩展名。只做路径层面的廉价判断
 * （>1MB 与内容二进制检查留给第二遍 scanSymbols，那里才有文件本体）。
 */
export function filterCandidates(files: string[]): string[] {
  return files.filter((f) => {
    if (f.split("/").some((s) => IGNORED_SEGMENTS.has(s))) return false;
    const ext = extOf(f).slice(1);
    if (ext && BINARY_EXTENSIONS.has(ext)) return false;
    return true;
  });
}

/** 打分：文件名（去扩展名）含查询词 > 路径段含 > 其他。大小写不敏感。 */
export function scoreByPath(file: string, query: string): number {
  const q = query.toLowerCase();
  const segs = file.toLowerCase().split("/");
  const base = segs[segs.length - 1] ?? "";
  if (base.replace(/\.[^.]+$/, "").includes(q)) return 2;
  if (segs.slice(0, -1).some((s) => s.includes(q))) return 1;
  return 0;
}

/**
 * 第二遍符号扫描：读文件（>1MB / 二进制跳过）→ 按扩展名语言匹配声明行。
 * 返回声明行数组；文件不可读/二进制/过大返回 null（该文件不列符号，可视为定位失败）；
 * 语言不支持则返回 []（只列路径，不列符号）。
 */
export async function scanSymbols(file: string): Promise<string[] | null> {
  let st;
  try {
    st = await stat(file);
  } catch {
    return null;
  }
  if (st.size > MAX_FILE_BYTES) return null;
  let buf: Buffer;
  try {
    buf = await readFile(file);
  } catch {
    return null;
  }
  if (buf.subarray(0, 8192).includes(0)) return null; // 内容二进制
  const lang = EXT_LANG[extOf(file)];
  if (!lang) return [];
  const re = SYMBOL_PATTERNS[lang]!;
  const text = buf.toString("utf8").replace(/^﻿/, "");
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    if (lines.length >= MAX_SYMBOLS_PER_FILE) break;
    if (re.test(line)) lines.push(line.trim());
  }
  return lines;
}

export type GitFilesResult =
  | { status: "ok"; files: string[] }
  | { status: "not-git" }
  | { status: "unavailable"; reason: string };

const gitFilesCache = new Map<string, { at: number; files: string[] }>();

interface GitRun {
  ok: boolean;
  code?: number | string;
  killed?: boolean;
  message?: string;
  stdout?: string;
}

function runGit(cwd: string, args: string[]): Promise<GitRun> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          resolve({
            ok: false,
            message: e.message,
            ...(e.code !== undefined ? { code: e.code } : {}),
            ...(e.killed !== undefined ? { killed: e.killed } : {}),
          });
          return;
        }
        resolve({ ok: true, stdout: stdout.toString() });
      },
    );
  });
}

/** 测试用：清空 git 文件列表缓存。 */
export function clearRepoMapCache(): void {
  gitFilesCache.clear();
}

/**
 * git ls-files（按 cwd+HEAD sha 缓存 60s）。三态：
 * ok / not-git（调用方退化为 readdir）/ unavailable（git 缺失或超时 → 调用方返回空+提示）。
 */
export async function listGitFiles(cwd: string): Promise<GitFilesResult> {
  const head = await runGit(cwd, ["rev-parse", "--short", "HEAD"]);
  const key = head.ok ? `${cwd}\0${head.stdout?.trim()}` : `${cwd}\0<no-head>`;
  const cached = gitFilesCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { status: "ok", files: cached.files };
  }

  const res = await runGit(cwd, ["ls-files"]);
  if (!res.ok) {
    if (res.code === "ENOENT") return { status: "unavailable", reason: "git 不在 PATH" };
    if (res.killed) return { status: "unavailable", reason: `git ls-files 超时（${GIT_TIMEOUT_MS}ms）` };
    if (res.code === 128 || /not a git repository/i.test(res.message ?? "")) {
      return { status: "not-git" };
    }
    return { status: "unavailable", reason: `git ls-files 失败（${res.code ?? "unknown"}）` };
  }
  const files = (res.stdout ?? "")
    .split("\n")
    .filter(Boolean)
    .map((f) => f.replace(/\\/g, "/"));
  gitFilesCache.set(key, { at: Date.now(), files });
  return { status: "ok", files };
}

/** 非 git 降级：readdir 递归列文件（上限 MAX_READDIR_FILES，跳过错黑名单段）。 */
async function listFilesReaddir(cwd: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (out.length >= MAX_READDIR_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_READDIR_FILES) return;
      if (IGNORED_SEGMENTS.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push(path.relative(cwd, p).split(path.sep).join("/"));
    }
  }
  await walk(cwd);
  return out;
}

interface Candidate {
  file: string;
  score: number;
  symbols: string[] | null;
}

/** 输出排序：符号命中 > 文件名命中 > 路径段命中 > 其他（符号命中 = 某声明行包含查询词）。 */
function finalRank(c: Candidate, query: string): number {
  if (c.symbols && c.symbols.some((s) => s.includes(query))) return 0;
  return 4 - c.score; // score 2→2、1→3、0→4
}

/**
 * 组装 repo_map 结果文本：候选文件 + 符号行，按 maxBytes 截断。
 * @param maxBytes 缺省 4096；调用方传 maxBytes 时已由 schema 限制 ≤32768。
 */
export async function buildRepoMap(query: string, maxBytes?: number): Promise<string> {
  const budget = maxBytes ?? MAX_BYTES_DEFAULT;
  const cwd = process.cwd();
  const git = await listGitFiles(cwd);

  let raw: string[] | null;
  let source: string;
  if (git.status === "ok") {
    raw = git.files;
    source = "git";
  } else if (git.status === "not-git") {
    raw = await listFilesReaddir(cwd);
    source = "readdir";
  } else {
    return `repo_map 不可用：${git.reason}。可以改用 read_file / glob / grep 直接搜索。`;
  }

  const filtered = filterCandidates(raw);
  // 打分 + top-N：分数降序，同分按路径长度升序（确定性；符号查询时多数组件分数为 0，靠路径长度选代表性文件）
  const ranked = filtered
    .map((file) => ({ file, score: scoreByPath(file, query) }))
    .sort((a, b) => b.score - a.score || a.file.length - b.file.length)
    .slice(0, MAX_CANDIDATES);

  // 第二遍：只对 top-N 扫描符号
  const scanned: Candidate[] = [];
  for (const c of ranked) {
    const symbols = await scanSymbols(c.file);
    scanned.push({ ...c, symbols });
  }
  const ordered = [...scanned]
    .sort((a, b) => finalRank(a, query) - finalRank(b, query))
    // 跳过不可读/二进制/过大文件（symbols === null）：它不是候选，别占输出
    .filter((c) => c.symbols !== null);

  if (ordered.length === 0) {
    return `repo_map: 未找到与「${query}」匹配的候选文件。`;
  }

  const blocks = ordered.map((c) => {
    const header = `--- ${c.file} ---`;
    if (!c.symbols || c.symbols.length === 0) return `${header}\n（无可扫描符号）`;
    return `${header}\n${c.symbols.join("\n")}`;
  });
  let text = `repo_map · query=${query} · 候选 ${ordered.length} 个（${source}）:\n${blocks.join("\n")}`;
  if (text.length > budget) {
    text = `${text.slice(0, budget)}\n…（输出超长，已截断到 ${budget} 字符）`;
  }
  return text;
}

const schema = z.object({
  query: z
    .string()
    .min(1)
    .describe("Symbol or filename keyword to locate in the repository"),
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(MAX_BYTES_LIMIT)
    .optional()
    .describe("Result cap in bytes (default 4096)"),
});

export const repoMapTool: Tool = {
  name: "repo_map",
  description:
    "Locate where a symbol or filename lives in the repository. Cheap two-pass scan: rank files " +
    "by path match, then scan only the top candidates for top-level declarations (functions/classes/consts " +
    "for ts/js, defs for py, funcs for go). Returns candidate paths with matching symbol lines, truncated to " +
    "maxBytes. Falls back to a directory walk for non-git repos. Read-only, safe to run in parallel.",
  inputSchema: schema,
  isConcurrencySafe: true,
  async call(input): Promise<ToolCallResult> {
    const { query, maxBytes } = schema.parse(input);
    return { result: await buildRepoMap(query, maxBytes) };
  },
};
