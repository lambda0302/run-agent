import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Tool, ToolCallResult } from "../tools.js";
import { MAX_MEMORY_BYTES, userClaudeFilePath } from "../core/context.js";

const schema = z.object({
  content: z.string().min(1).describe("The fact, preference, or lesson to remember"),
});

/**
 * remember 工具：把一条事实追加进「用户级」长期记忆 `~/.config/run-agent/CLAUDE.md`。
 * - 走权限引擎（default 下 ask，acceptEdits 下 allow），用户可拒绝或加规则；
 * - 去重：已存在的条目跳过，不重复写入；
 * - 写入守卫：超过 MAX_MEMORY_BYTES 拒绝写入（记忆文件超限后不会被注入，宁可拒绝）。
 * `.run-agent` 目录仍对 agent 只读——本工具只写用户级，不碰本地级。
 * homeDir 可注入（测试沙箱用），默认取 os.homedir()。
 */
export function makeRememberTool(homeDir: string = homedir()): Tool {
  return {
    name: "remember",
    description:
      "Persist a fact, preference, or lesson to long-term user memory (CLAUDE.md). Use when the user explicitly asks you to remember something, or when you discover a stable fact worth keeping across sessions (e.g. preferred test command, a project convention, a decision). Deduplicates automatically; appends to the user-level memory file.",
    inputSchema: schema,
    isConcurrencySafe: false,
    async call(input): Promise<ToolCallResult> {
      const { content } = schema.parse(input);
      const trimmed = content.trim();
      const file = userClaudeFilePath(homeDir);
      try {
        let existing = "";
        try {
          existing = (await readFile(file, "utf8")).replace(/^﻿/, "");
        } catch {
          // 文件尚不存在 → 视为空
        }

        // 去重：整段 trim 后做子串匹配（条目即内容本身）
        if (existing.includes(trimmed)) {
          return { result: "该内容已在长期记忆中，跳过重复写入" };
        }

        const next =
          (existing.endsWith("\n") || existing === "" ? existing : existing + "\n") +
          `- ${trimmed}\n`;
        if (Buffer.byteLength(next, "utf8") > MAX_MEMORY_BYTES) {
          return {
            result: `记忆文件已达上限（>${MAX_MEMORY_BYTES} 字节，超出后不再被注入），拒绝写入。请手动精简 ~/.config/run-agent/CLAUDE.md 后再试。`,
          };
        }

        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, next, "utf8");
        return { result: `已记住：${trimmed}` };
      } catch (e) {
        return { result: `写入记忆失败: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  };
}

/** 默认实例（生产用）：写入真实用户目录。 */
export const rememberTool = makeRememberTool();
