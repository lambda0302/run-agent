/**
 * V7 粘贴异常修复测试：REPL 多行粘贴统一收集为单条 prompt（注入 input 流驱动真实 dispatch）。
 *
 * 背景：readline 按行触发 "line" 事件，粘贴多行会一行一个 runTurn（并发污染 messages）；
 * 且无换行收尾的末行留在 readline 内部缓冲，可能在权限弹窗时被 rl.question 读成答案
 * （"y" 变 "y\0" 之类 → 误拒）。修复 = 收集器（300ms 防抖 + rl.write("\n") 冲残留）+
 * 串行队列（同一时刻只有一个 turn）+ ask 弹窗前冲掉残留。
 * 0.7.2 补漏：两行粘贴（末行无换行）只有 1 个完整 line 事件，旧门槛 `inputBuf.length>=2`
 * 不触发 → 末行滞留成下一条"待输入"。修复 = line 事件后 setImmediate 查 readline 内部
 * 残留（`_line`/`Symbol(_line_buffer)`），同 chunk 有残留则标记 `pasteTailPending`，
 * flush 时并入本 prompt。
 */
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { LLMClient, LLMMessage } from "../src/providers/types.js";
import type { Tool } from "../src/tools.js";
import type { PermissionContext } from "../src/permissions/types.js";
import { runRepl } from "../src/cli/repl.js";

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
  const d = mkdtempSync(path.join(tmpdir(), "run-agent-paste-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 只回文本、完整结束的假客户端：记录每次 stream 收到的 messages。 */
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

describe("REPL 多行粘贴统一为单条 prompt（V7 修复）", () => {
  it("无换行收尾的粘贴：末行残留被冲入 prompt，整批合并为一次模型调用", async () => {
    const streamCalls: LLMMessage[][] = [];
    const input = new PassThrough();
    const out = new PassThrough();
    out.resume(); // 丢弃输出，只关心 stream 调用
    const done = runRepl({
      client: textClient(streamCalls),
      tools: [],
      sessionFile: path.join(tempDir(), "s.jsonl"),
      input,
      out,
    });
    // 模拟粘贴：l1/l2/l3 有换行，l4 无换行收尾（留在 readline 缓冲 → drain 冲入）
    input.write("l1\nl2\nl3\nl4");
    await waitFor(() => streamCalls.length === 1, 5000, "第一轮模型调用");
    await sleep(150); // 让轮完整收尾
    input.write("/exit\n");
    await sleep(100);
    await done;
    expect(streamCalls.length).toBe(1);
    // 末行 l4 已被收集（不是被弹窗吃掉、不是单独一轮）
    expect(streamCalls[0]![0]!.content).toEqual("l1\nl2\nl3\nl4");
  });

  it("两行粘贴、末行无换行收尾：两行合并为一条 prompt，不滞留成下一条待输入", async () => {
    // 用户真实场景：2 行 prompt，第 2 行没有换行收尾。之前 `inputBuf.length >= 2` 的 drain
    // 门槛没触发（只有 1 个完整 line 事件），末行滞留在 readline 缓冲 → 出现在下一条
    // prompt 上变成"待输入"（用户没按回车也显示，甚至会被误提交）。
    const streamCalls: LLMMessage[][] = [];
    const input = new PassThrough();
    const out = new PassThrough();
    out.resume();
    const done = runRepl({
      client: textClient(streamCalls),
      tools: [],
      sessionFile: path.join(tempDir(), "s.jsonl"),
      input,
      out,
    });
    input.write("l1\nl2"); // 末行 l2 无换行收尾
    await waitFor(() => streamCalls.length >= 1, 5000, "第一轮模型调用");
    await sleep(150);
    expect(streamCalls[0]![0]!.content).toEqual("l1\nl2");
    input.end(); // EOF 关闭 readline → REPL 退出（不用 /exit，避免被滞留行污染）
    await done;
    expect(streamCalls.length).toBe(1); // 滞留行没有被当成第二条 prompt
  });

  it("带换行收尾的粘贴：整批合并为一次模型调用", async () => {
    const streamCalls: LLMMessage[][] = [];
    const input = new PassThrough();
    const out = new PassThrough();
    out.resume();
    const done = runRepl({
      client: textClient(streamCalls),
      tools: [],
      sessionFile: path.join(tempDir(), "s.jsonl"),
      input,
      out,
    });
    input.write("l1\nl2\nl3\n");
    await waitFor(() => streamCalls.length === 1, 5000, "第一轮模型调用");
    await sleep(150);
    input.write("/exit\n");
    await sleep(100);
    await done;
    expect(streamCalls.length).toBe(1);
    expect(streamCalls[0]![0]!.content).toEqual("l1\nl2\nl3");
  });

  it("单行 prompt 行为不变：一次模型调用", async () => {
    const streamCalls: LLMMessage[][] = [];
    const input = new PassThrough();
    const out = new PassThrough();
    out.resume();
    const done = runRepl({
      client: textClient(streamCalls),
      tools: [],
      sessionFile: path.join(tempDir(), "s.jsonl"),
      input,
      out,
    });
    input.write("hello\n");
    await waitFor(() => streamCalls.length === 1, 5000, "第一轮模型调用");
    await sleep(150);
    input.write("/exit\n");
    await sleep(100);
    await done;
    expect(streamCalls.length).toBe(1);
    expect(streamCalls[0]![0]!.content).toEqual("hello");
  });

  it("turn 运行中粘贴：排队不并发，合并为单条 prompt 在下一轮执行", async () => {
    const streamCalls: LLMMessage[][] = [];
    let releaseTurn1!: () => void;
    const gateP = new Promise<void>((r) => (releaseTurn1 = r));
    const client: LLMClient = {
      provider: "fake",
      async *stream(messages) {
        streamCalls.push([...messages]);
        if (streamCalls.length === 1) await gateP; // 阻塞第一个 turn，模拟长任务
        yield { type: "text", text: "完成" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const input = new PassThrough();
    const out = new PassThrough();
    out.resume();
    const done = runRepl({
      client,
      tools: [],
      sessionFile: path.join(tempDir(), "s.jsonl"),
      input,
      out,
    });
    input.write("first\n");
    await waitFor(() => streamCalls.length === 1, 5000, "第一轮启动");
    // 第一个 turn 仍在跑：粘贴多行 → 必须排队，不能并发起第二个 turn
    input.write("p1\np2\np3");
    await sleep(500); // 防抖 flush + 入队都发生在 turn1 阻塞期间
    releaseTurn1(); // turn1 结束 → 队列里的粘贴作为一条 prompt 执行
    await waitFor(() => streamCalls.length === 2, 5000, "第二轮（排队粘贴）");
    // 第二轮请求含第一轮完整历史：粘贴是最后追加的 user 消息
    const msgs2 = streamCalls[1]!;
    expect(msgs2[msgs2.length - 1]!.content).toEqual("p1\np2\np3");
    await sleep(150);
    input.write("/exit\n");
    await sleep(100);
    await done;
    expect(streamCalls.length).toBe(2); // 没有并发多出
  });

  it("权限弹窗前冲掉缓冲残留：答案干净不被污染（粘贴异常里 y 被误读成别的）", async () => {
    const cwd = tempDir();
    let toolCalled = false;
    const writeTool: Tool = {
      name: "write_file",
      description: "写入文件",
      inputSchema: z.object({ file_path: z.string(), content: z.string() }),
      async call() {
        toolCalled = true;
        return { result: "ok" };
      },
    };
    const client: LLMClient = {
      provider: "fake",
      async *stream() {
        // 模型请求写工具 → 触发权限弹窗（default 模式下 write_file → ask）
        yield {
          type: "tool_use",
          id: "t1",
          name: "write_file",
          input: { file_path: path.join(cwd, "out.txt"), content: "x" },
        };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const ctx: PermissionContext = { mode: "default", rules: [], canPrompt: true, isTrusted: true, cwd };
    const input = new PassThrough();
    const chunks: Buffer[] = [];
    const out = new PassThrough();
    out.on("data", (c: Buffer) => chunks.push(c));
    const outText = () => Buffer.concat(chunks).toString("utf8");
    const done = runRepl({
      client,
      tools: [writeTool],
      sessionFile: path.join(tempDir(), "s.jsonl"),
      ctx,
      input,
      out,
    });
    // 单行 prompt + 无换行残留 "stray"。同一 chunk 写入 → 按 0.7.2 判定为粘贴末行、并入
    // prompt；真实"提交后新输入"是独立 chunk，事件时刻残留为空 → 不并入、由 ask 弹窗丢弃。
    // 无论并入与否，弹窗 rl.question 读到的答案都必须干净（无残留污染 y/n）。
    input.write("hello\nstray");
    await waitFor(() => outText().includes("允许 write_file"), 5000, "权限弹窗出现");
    input.write("y\n");
    await waitFor(() => toolCalled, 5000, "write_file 被放行执行");
    input.write("/exit\n");
    await sleep(100);
    await done;
    expect(toolCalled).toBe(true); // 答案读到了干净的 "y"（未被 "stray" 污染成拒绝）
  });
});
