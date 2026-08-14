/**
 * V8 ⑥：REPL /sessions 交互切换集成测试——方向键菜单选择会话 → 切入 =
 * 加载目标会话替换当前 messages + 更新 sessionFile 指针（后续追加写新会话）。
 *
 * 沙箱 HOME：sessionsDir(cwd) 基于 homedir()，本文件整体把 USERPROFILE/HOME 指向临时目录，
 * 防读到真实 `~/.local/share/run-agent/sessions/`。独立文件避免污染其它 REPL 测试。
 */
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LLMClient, LLMMessage } from "../../src/providers/types.js";
import type { PermissionContext } from "../../src/permissions/types.js";
import { runRepl } from "../../src/cli/repl.js";
import {
  appendMessage,
  createSessionFile,
  sessionsDir,
} from "../../src/utils/sessionStorage.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor 超时: ${what}`);
    await sleep(10);
  }
}

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "run-agent-repl-sessions-"));
  dirs.push(d);
  return d;
}

/** 记录每次 stream 收到的 messages，只回文本。 */
function textClient(streamCalls: LLMMessage[][]): LLMClient {
  return {
    provider: "fake",
    async *stream(messages) {
      streamCalls.push([...messages]);
      yield { type: "text", text: "完成" };
      yield { type: "done", stopReason: "end_turn" };
    },
  };
}

describe("REPL /sessions（V8 会话切换）", () => {
  let home = "";
  let origHome = "";
  let origUserProfile = "";

  beforeEach(() => {
    home = tempDir();
    origHome = process.env.HOME ?? "";
    origUserProfile = process.env.USERPROFILE ?? "";
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    process.env.USERPROFILE = origUserProfile;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("切入选中的历史会话：messages 被替换、后续写入切到新会话文件", async () => {
    const proj = path.join(home, "proj");
    const sdir = sessionsDir(proj);
    // 会话 1：旧（两轮）；会话 2：新（一轮）——倒序列表里 f2 在前、f1 在后
    const f1 = await createSessionFile(sdir, { cwd: proj, model: "m1", provider: "fake" });
    await appendMessage(f1, { role: "user", content: "s1 first" });
    await appendMessage(f1, { role: "assistant", content: "s1 reply" });
    const f2 = await createSessionFile(sdir, { cwd: proj, model: "m2", provider: "fake" });
    await appendMessage(f2, { role: "user", content: "s2 first" });

    const streamCalls: LLMMessage[][] = [];
    const input = new PassThrough();
    const chunks: Buffer[] = [];
    const out = new PassThrough();
    out.on("data", (c: Buffer) => chunks.push(c));
    const outText = () => Buffer.concat(chunks).toString("utf8");
    const ctx: PermissionContext = {
      mode: "default",
      rules: [],
      canPrompt: true,
      isTrusted: true,
      cwd: proj,
    };
    const done = runRepl({
      client: textClient(streamCalls),
      tools: [],
      sessionFile: f2, // 初始写目标 = 会话 2
      ctx,
      input,
      out,
    });

    // 触发 /sessions → 菜单渲染出两个会话的预览（焦点初始在最新 = 会话 2）
    input.write("/sessions\n");
    await waitFor(() => outText().includes("s2 first"), 5000, "菜单出现（会话 2 预览）");
    expect(outText()).toContain("s1 first");

    // ↓ 移到会话 1，Enter 切入
    input.write("\x1b[B\r");
    await waitFor(() => outText().includes("已切入会话"), 5000, "切入提示");

    // 下一轮 prompt：模型收到的历史应含会话 1 的消息（替换生效）
    input.write("next\n");
    await waitFor(() => streamCalls.length >= 1, 5000, "切入后第一轮模型调用");
    await sleep(150);
    const msgs = streamCalls[0]!;
    const contents = msgs.map((m) => (typeof m.content === "string" ? m.content : ""));
    expect(contents).toContain("s1 first"); // 会话 1 历史在
    expect(contents).toContain("s1 reply");
    expect(contents).toContain("next");
    expect(contents).not.toContain("s2 first"); // 会话 2 历史被替换掉

    // 写入目标切换：本轮追加写进会话 1 文件
    await sleep(100);
    const f1Text = await import("node:fs/promises").then((fs) => fs.readFile(f1, "utf8"));
    expect(f1Text).toContain("next");

    input.write("/exit\n");
    await sleep(100);
    await done;
  });
});
