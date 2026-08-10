import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Tool, ToolCallResult } from "../tools.js";

const schema = z.object({
  file_path: z.string().describe("Absolute or cwd-relative path of the file to edit"),
  old_string: z.string().min(1).describe("The exact text to find — must appear in the file"),
  new_string: z.string().describe("Replacement text"),
  replace_all: z.boolean().optional().describe("Replace every occurrence instead of the first"),
});

export const editTool: Tool = {
  name: "edit_file",
  description:
    "Make a targeted edit by replacing an exact old_string with new_string in a file. " +
    "If old_string matches multiple times, fails unless replace_all=true. Use write_file for new/whole files.",
  inputSchema: schema,
  async call(input): Promise<ToolCallResult> {
    const { file_path, old_string, new_string, replace_all } = schema.parse(input);
    const abs = path.resolve(file_path);

    let original: string;
    try {
      original = await readFile(abs, "utf8");
    } catch (e) {
      return { result: `编辑失败: 无法读取 ${abs}: ${e instanceof Error ? e.message : String(e)}` };
    }

    const count = original.split(old_string).length - 1;
    if (count === 0) {
      return {
        result: `编辑失败: 在 ${abs} 中没有找到 old_string（注意精确匹配，含空白与大小写）`,
      };
    }
    if (count > 1 && !replace_all) {
      return {
        result: `编辑失败: old_string 在 ${abs} 中出现 ${count} 次，请给出更多上下文或设置 replace_all=true`,
      };
    }

    const updated = replace_all
      ? original.split(old_string).join(new_string)
      : original.replace(old_string, new_string);
    await writeFile(abs, updated, "utf8");
    return { result: `已编辑 ${abs}：替换了 ${replace_all ? count : 1} 处` };
  },
};
