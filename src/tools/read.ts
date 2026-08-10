import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Tool, ToolCallResult } from "../tools.js";

const MAX_DEFAULT_LINES = 2000;
const MAX_BYTES = 4 * 1024 * 1024; // 4MB，更大的文件提示用 offset/limit

const schema = z.object({
  file_path: z.string().describe("Absolute or cwd-relative path of the file to read"),
  offset: z.number().int().positive().optional().describe("1-based line to start from"),
  limit: z.number().int().positive().optional().describe("Max lines to return (default 2000)"),
});

function isProbablyBinary(buf: Buffer): boolean {
  // 空字节通常是二进制；采样前 8KB 即可
  const sample = buf.subarray(0, 8192);
  return sample.includes(0);
}

export const readTool: Tool = {
  name: "read_file",
  description:
    "Read a text file, optionally a 1-based line range (offset/limit). Returns file content or a short error. " +
    "For large files read in chunks via offset/limit.",
  inputSchema: schema,
  isConcurrencySafe: true,
  async call(input): Promise<ToolCallResult> {
    const { file_path, offset, limit } = schema.parse(input);
    const abs = path.resolve(file_path);

    let st;
    try {
      st = await stat(abs);
    } catch {
      return { result: `读取失败: 文件不存在 ${abs}` };
    }
    if (st.isDirectory()) {
      return { result: `读取失败: ${abs} 是目录` };
    }
    if (st.size > MAX_BYTES) {
      return {
        result: `读取失败: 文件超过 ${MAX_BYTES / 1024 / 1024}MB（${st.size} 字节），请用 offset/limit 分段读取`,
      };
    }

    let buf: Buffer;
    try {
      buf = await readFile(abs);
    } catch (e) {
      return { result: `读取失败: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (isProbablyBinary(buf)) {
      return { result: `读取失败: ${abs} 是二进制文件（${st.size} 字节）` };
    }

    // 去掉 UTF-8 BOM，避免首行出现零宽字符
    const text = buf.toString("utf8").replace(/^﻿/, "");
    const lines = text.split("\n");
    const start = offset ? offset - 1 : 0;
    const count = limit ?? MAX_DEFAULT_LINES;
    const slice = lines.slice(start, start + count);

    const total = lines.length;
    const head = `——— ${abs} · ${total} 行 ${start + 1}-${start + slice.length} ———\n`;
    const tail =
      start + count < total
        ? `\n…（还有 ${total - (start + count)} 行，用 offset=${start + count + 1} 继续读）`
        : "";
    return { result: head + slice.join("\n") + tail };
  },
};
