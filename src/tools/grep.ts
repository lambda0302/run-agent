import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Tool, ToolCallResult } from "../tools.js";

const MAX_RESULTS = 200;
const MAX_FILE_BYTES = 512 * 1024; // 单文件超过 512KB 跳过
const ALWAYS_IGNORE = new Set([".git", "node_modules", ".run-agent"]);

const schema = z.object({
  pattern: z.string().min(1).describe("Regular expression to search for"),
  path: z
    .string()
    .optional()
    .describe("Directory to search; defaults to current working directory"),
  glob: z
    .string()
    .optional()
    .describe("Only search files whose path matches this glob, e.g. '**/*.ts'"),
  ignore: z.array(z.string()).optional().describe("Extra directory names to skip"),
});

/** 把 glob 转成正则（单遍扫描，避免链式 replace 互相污染）。 */
function globToRegExp(pattern: string): RegExp {
  let re = "";
  const chars = pattern.replace(/\\/g, "/").split("");
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (c === "*") {
      if (chars[i + 1] === "*") {
        if (chars[i + 2] === "/") {
          re += "(?:[^/]+/)*"; // **/ 匹配任意层目录（含零层）
          i += 2;
        } else {
          re += ".*"; // 裸 ** 匹配任意
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

async function collectFiles(dir: string, ignoreSet: Set<string>, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (ignoreSet.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await collectFiles(p, ignoreSet, out);
    else out.push(p);
  }
}

export const grepTool: Tool = {
  name: "grep",
  description:
    "Recursively search a directory for lines matching a regular expression. " +
    "Returns file:line matches, skipping .git, node_modules, and .run-agent (pass an explicit " +
    "path to search inside them). Optionally filter files by glob.",
  inputSchema: schema,
  isConcurrencySafe: true,
  async call(input): Promise<ToolCallResult> {
    const { pattern, path: dir, glob, ignore } = schema.parse(input);
    const root = path.resolve(dir ?? ".");
    const ignoreSet = new Set([...ALWAYS_IGNORE, ...(ignore ?? [])]);

    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (e) {
      return {
        result: `grep 失败: 正则无效 "${pattern}": ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    const globRe = glob ? globToRegExp(glob) : undefined;

    // path 可指向单个文件（模型常按文件 grep）：直接搜该文件；否则按目录递归收集。
    // 旧实现对文件路径 readdir 抛错被静默吞掉 → 永远「未找到匹配」（explore 子 agent
    // 证据链断裂 / 空结论的根因之一）。
    const st = await stat(root).catch(() => undefined);
    const isSingleFile = st?.isFile() === true;
    const files: string[] = [];
    if (isSingleFile) {
      files.push(root);
    } else {
      await collectFiles(root, ignoreSet, files);
    }

    const hits: string[] = [];
    for (const file of files) {
      if (hits.length >= MAX_RESULTS) break;
      // 显示用相对路径：单文件 = 用户传入的 path（模型按传入路径定位，如 src/cli/repl.ts:141）；
      // 目录 = 相对搜索根。glob 过滤与命中输出用同一 rel。
      const rel = isSingleFile
        ? (dir ?? path.basename(root)).replace(/\\/g, "/")
        : path.relative(root, file).split(path.sep).join("/");
      if (globRe && !globRe.test(rel)) continue;
      let content: string;
      try {
        const buf = await readFile(file);
        if (buf.length > MAX_FILE_BYTES) continue;
        if (buf.subarray(0, 8192).includes(0)) continue; // 二进制跳过
        content = buf.toString("utf8").replace(/^﻿/, "");
      } catch {
        continue;
      }
      const lines = content.split("\n");
      for (let i = 0; i < lines.length && hits.length < MAX_RESULTS; i++) {
        if (re.test(lines[i]!)) hits.push(`${rel}:${i + 1}: ${lines[i]}`);
      }
    }

    if (hits.length === 0) return { result: `未找到匹配: /${pattern}/` };
    const truncated = hits.length >= MAX_RESULTS ? "\n…（已达结果上限，已截断）" : "";
    return { result: `匹配 ${hits.length} 处:\n${hits.join("\n")}${truncated}` };
  },
};
