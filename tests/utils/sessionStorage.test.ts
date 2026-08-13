import { mkdtempSync, rmSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COMPACT_MARKER } from "../../src/core/compact.js";
import type { LLMMessage } from "../../src/providers/types.js";
import {
  appendMessage,
  createSessionFile,
  latestSessionFile,
  loadSession,
} from "../../src/utils/sessionStorage.js";

let dirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "run-agent-sess-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("sessionStorage（JSONL 会话）", () => {
  it("create → append → load 往返一致", async () => {
    const dir = tempDir();
    const file = await createSessionFile(dir);
    const msgs: LLMMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "yo" }] },
    ];
    for (const m of msgs) await appendMessage(file, m);
    expect(await loadSession(file)).toEqual(msgs);
  });

  it("latestSessionFile 返回最新创建的会话", async () => {
    const dir = tempDir();
    const f1 = await createSessionFile(dir);
    await appendMessage(f1, { role: "user", content: "a" });
    await new Promise((r) => setTimeout(r, 10));
    const f2 = await createSessionFile(dir);
    await appendMessage(f2, { role: "user", content: "b" });
    expect(await latestSessionFile(dir)).toBe(f2);
    expect(f1).not.toBe(f2);
  });

  it("没有会话时 latestSessionFile 返回 undefined", async () => {
    const dir = tempDir();
    expect(await latestSessionFile(dir)).toBeUndefined();
  });

  it("latestSessionFile 排除子 agent transcript（subagent- 前缀，V7 目录混存）", async () => {
    const dir = tempDir();
    // 子 agent transcript 以字母开头，倒序字典序恒排在时间戳主会话前（bug：不排除会误选）
    const sub = path.join(dir, "subagent-task-1.jsonl");
    await appendFile(sub, "{}\n", "utf8");
    const main = await createSessionFile(dir);
    await appendMessage(main, { role: "user", content: "a" });
    expect(await latestSessionFile(dir)).toBe(main);
  });

  it("目录里只有子 agent transcript 时 latestSessionFile 返回 undefined", async () => {
    const dir = tempDir();
    const sub = path.join(dir, "subagent-task-1.jsonl");
    await appendFile(sub, "{}\n", "utf8");
    expect(await latestSessionFile(dir)).toBeUndefined();
  });

  it("损坏的行在加载时被跳过", async () => {
    const dir = tempDir();
    const file = await createSessionFile(dir);
    await appendFile(file, "{bad json}\n", "utf8");
    await appendMessage(file, { role: "user", content: "ok" });
    expect(await loadSession(file)).toEqual([{ role: "user", content: "ok" }]);
  });

  it("遇到压缩边界：只从含哨兵的边界消息续起（更早历史被忽略）", async () => {
    const dir = tempDir();
    const file = await createSessionFile(dir);
    const boundary: LLMMessage = {
      role: "user",
      content: `[上下文已压缩] ${COMPACT_MARKER}\n摘要`,
    };
    await appendMessage(file, { role: "user", content: "旧消息1" });
    await appendMessage(file, { role: "assistant", content: "旧回复" });
    await appendMessage(file, boundary);
    await appendMessage(file, { role: "user", content: "新消息" });
    expect(await loadSession(file)).toEqual([boundary, { role: "user", content: "新消息" }]);
  });

  it("多边界：取最后一个边界续起", async () => {
    const dir = tempDir();
    const file = await createSessionFile(dir);
    const b1: LLMMessage = { role: "user", content: `[上下文已压缩] ${COMPACT_MARKER}\n摘要1` };
    const b2: LLMMessage = { role: "user", content: `[上下文已压缩] ${COMPACT_MARKER}\n摘要2` };
    await appendMessage(file, { role: "user", content: "a" });
    await appendMessage(file, b1);
    await appendMessage(file, { role: "user", content: "b" });
    await appendMessage(file, b2);
    await appendMessage(file, { role: "user", content: "c" });
    expect(await loadSession(file)).toEqual([b2, { role: "user", content: "c" }]);
  });
});
