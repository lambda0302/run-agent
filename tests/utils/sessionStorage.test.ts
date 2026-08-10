import { mkdtempSync, rmSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

  it("损坏的行在加载时被跳过", async () => {
    const dir = tempDir();
    const file = await createSessionFile(dir);
    await appendFile(file, "{bad json}\n", "utf8");
    await appendMessage(file, { role: "user", content: "ok" });
    expect(await loadSession(file)).toEqual([{ role: "user", content: "ok" }]);
  });
});
