import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Tool, ToolCallResult } from "../tools.js";

const schema = z.object({
  file_path: z.string().describe("Absolute or cwd-relative path of the file to write"),
  content: z.string().describe("Full file content to write"),
});

export const writeTool: Tool = {
  name: "write_file",
  description:
    "Write full content to a file, creating parent directories as needed. Overwrites existing files.",
  inputSchema: schema,
  async call(input): Promise<ToolCallResult> {
    const { file_path, content } = schema.parse(input);
    const abs = path.resolve(file_path);
    try {
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
      return { result: `已写入 ${abs}（${Buffer.byteLength(content, "utf8")} 字节）` };
    } catch (e) {
      return { result: `写入失败: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
};
