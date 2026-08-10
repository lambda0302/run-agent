import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Tool, ToolCallResult } from "../tools.js";

const MAX_RESULTS = 1000;
/** 默认忽略的目录（避免把依赖/版本库扫进结果） */
const ALWAYS_IGNORE = new Set([".git", "node_modules"]);

const schema = z.object({
  pattern: z.string().min(1).describe("Glob pattern, e.g. '**/*.ts', 'src/**/index.ts'"),
  path: z.string().optional().describe("Base directory; defaults to current working directory"),
  ignore: z.array(z.string()).optional().describe("Extra directory/file names to skip"),
});

/** 把单段 glob 转成正则：* 匹配段内任意，? 匹配单字符。 */
function segToRegex(seg: string): RegExp {
  let re = "";
  for (const ch of seg) {
    if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** 展开 {a,b} → [a, b]，支持嵌套。 */
function expandBraces(seg: string): string[] {
  const m = /^(.*?)\{([^{}]+)\}(.*)$/.exec(seg);
  if (!m) return [seg];
  return m[2]!.split(",").flatMap((alt) => expandBraces(m[1]! + alt + m[3]!));
}

function parsePattern(pattern: string): { base: string; segments: string[] } {
  const p = pattern.replace(/\\/g, "/");
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) {
    const parts = p.split("/");
    const idx = parts.findIndex((s) => /[*?{}]/.test(s));
    if (idx === -1) return { base: path.resolve(p), segments: [] };
    const base = parts.slice(0, idx).join("/");
    return { base: path.resolve(base || path.parse(p).root), segments: parts.slice(idx) };
  }
  return { base: path.resolve("."), segments: p.split("/").filter(Boolean) };
}

async function walk(
  segments: string[],
  i: number,
  current: string,
  out: Set<string>,
  ignoreSet: Set<string>,
): Promise<void> {
  if (out.size >= MAX_RESULTS) return;
  if (i === segments.length) {
    out.add(current);
    return;
  }
  const seg = segments[i]!;
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return;
  }

  if (seg === "**") {
    // ** 匹配零段：直接用剩余 pattern 在当前位置继续
    await walk(segments, i + 1, current, out, ignoreSet);
    // ** 匹配若干段：每个条目都可被 ** 消耗
    for (const e of entries) {
      if (ignoreSet.has(e.name)) continue;
      const child = path.join(current, e.name);
      await walk(segments, i + 1, child, out, ignoreSet);
      // 目录还能让 ** 继续穿透
      if (e.isDirectory()) await walk(segments, i, child, out, ignoreSet);
    }
    return;
  }

  const last = i === segments.length - 1;
  for (const name of expandBraces(seg)) {
    const re = segToRegex(name);
    for (const e of entries) {
      if (ignoreSet.has(e.name)) continue;
      if (last) {
        if (re.test(e.name))
          await walk(segments, i + 1, path.join(current, e.name), out, ignoreSet);
      } else if (e.isDirectory() && re.test(e.name)) {
        await walk(segments, i + 1, path.join(current, e.name), out, ignoreSet);
      }
    }
  }
}

export const globTool: Tool = {
  name: "glob",
  description:
    "Find files by glob pattern, e.g. '**/*.ts' or 'src/**/*.{ts,tsx}'. " +
    "Skips .git and node_modules by default. Returns up to 1000 matches.",
  inputSchema: schema,
  isConcurrencySafe: true,
  async call(input): Promise<ToolCallResult> {
    const { pattern, path: baseDir, ignore } = schema.parse(input);
    const ignoreSet = new Set([...ALWAYS_IGNORE, ...(ignore ?? [])]);

    const { base, segments } = parsePattern(pattern);
    const root = baseDir ? path.resolve(baseDir) : base;

    if (segments.length === 0) {
      try {
        await stat(root);
        return { result: root.split(path.sep).join("/") };
      } catch {
        return { result: `未找到: ${pattern}` };
      }
    }

    const out = new Set<string>();
    await walk(segments, 0, root, out, ignoreSet);
    const sorted = [...out].sort();
    const normalized = sorted.map((p) => p.split(path.sep).join("/"));
    const shown = normalized.slice(0, MAX_RESULTS);

    if (shown.length === 0) return { result: `未找到匹配: ${pattern}` };
    const truncated =
      normalized.length > shown.length
        ? `\n…（还有 ${normalized.length - shown.length} 个，已截断）`
        : "";
    return {
      result: `匹配 ${shown.length} 个文件:\n${shown.map((p) => `- ${p}`).join("\n")}${truncated}`,
    };
  },
};
