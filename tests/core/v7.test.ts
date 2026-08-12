import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { runQuery } from "../../src/core/query.js";
import { runAgent } from "../../src/core/run_agent.js";
import type { LLMClient, LLMMessage, StreamEvent, StreamOptions } from "../../src/providers/types.js";
import type { Tool } from "../../src/tools.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

/** 脚本化 fake LLM：每次 stream() 弹出下一组事件；failNext 可让本次调用抛错（AbortError 等）。 */
class FakeClient implements LLMClient {
  provider = "fake";
  calls: LLMMessage[][] = [];
  toolSpecs: StreamOptions["tools"][] = [];
  signals: (AbortSignal | undefined)[] = [];
  failNext: Error | null = null;

  constructor(private scripted: StreamEvent[][]) {}

  async *stream(messages: LLMMessage[], opts?: StreamOptions): AsyncIterable<StreamEvent> {
    // 浅拷贝：runQuery 的 requestMessages 与内部 messages 是同一引用，后续注入会改动原数组
    this.calls.push([...messages]);
    this.toolSpecs.push(opts?.tools);
    this.signals.push(opts?.signal);
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    const next = this.scripted.shift();
    for (const ev of next ?? [{ type: "done", stopReason: "end_turn" }]) yield ev;
  }
}

const echoTool: Tool = {
  name: "echo",
  description: "Echo the given text back",
  inputSchema: z.object({ text: z.string() }),
  async call(input) {
    const { text } = input as { text: string };
    return { result: `echo:${text}` };
  },
};

describe("runQuery V7 挂点", () => {
  it("pollExternal：迭代边界注入外部消息（SendMessage 送达）", async () => {
    const fake = new FakeClient([
      [
        { type: "text", text: "done" },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    let injected = true;
    const r = await runQuery([{ role: "user", content: "go" }], {
      client: fake,
      tools: [echoTool],
      pollExternal: () =>
        injected
          ? (injected = false, [{ role: "user", content: "injected-msg" }])
          : undefined,
    });

    // 第一次迭代顶部注入，continue → 第二次迭代才真正发请求；请求应含注入消息
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.map((m) => m.content)).toContain("injected-msg");
    expect(r.reply).toBe("done");
    // 注入消息进 added/返回对话（子 transcript 契约）
    expect(r.messages.some((m) => m.role === "user" && m.content === "injected-msg")).toBe(true);
  });

  it("signal pre-aborted：不发起请求，直接返回 aborted", async () => {
    const fake = new FakeClient([]);
    const ac = new AbortController();
    ac.abort();
    const r = await runQuery([{ role: "user", content: "go" }], {
      client: fake,
      tools: [echoTool],
      signal: ac.signal,
    });

    expect(r.aborted).toBe(true);
    expect(fake.calls).toHaveLength(0); // 未发任何请求
  });

  it("stream 抛 AbortError：直接结束（不重试、不进反应式压缩），reply 保留部分文本", async () => {
    const fake = new FakeClient([
      [
        { type: "text", text: "partial" },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    fake.failNext = Object.assign(new Error("aborted"), { name: "AbortError" });
    const r = await runQuery([{ role: "user", content: "go" }], {
      client: fake,
      tools: [echoTool],
    });

    expect(r.aborted).toBe(true);
    expect(r.reply).toBe(""); // 首轮抛错，无已产出文本
    // 不重试：failNext 已清，但 AbortError 不应再走 stream
    expect(fake.calls).toHaveLength(1);
  });

  it("onBackgroundDone：end_turn 时有结果 → 注入新 user 轮让模型收尾；无结果正常返回", async () => {
    const fake = new FakeClient([
      [
        { type: "text", text: "start" },
        { type: "done", stopReason: "end_turn" },
      ],
      [
        { type: "text", text: "final" },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    let called = 0;
    const r = await runQuery([{ role: "user", content: "go" }], {
      client: fake,
      tools: [echoTool],
      onBackgroundDone: async () => (called++ === 0 ? ["- task-1(general-purpose): 结论"] : []),
    });

    expect(called).toBe(2); // 第一轮注入后继续，第二轮无结果返回
    expect(r.reply).toBe("final");
    // 第二轮请求应含注入的后台汇总 user 轮
    expect(
      fake.calls[1]!.some(
        (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("后台子 agent 结果"),
      ),
    ).toBe(true);
    // 空结果返回不注入
    expect(
      fake.calls[0]!.some(
        (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("后台子 agent 结果"),
      ),
    ).toBe(false);
  });

  it("signal 透传：opts.signal 传给底层 stream（TaskStop 中断 in-flight 请求）", async () => {
    const fake = new FakeClient([
      [
        { type: "text", text: "done" },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    const ac = new AbortController();
    const r = await runQuery([{ role: "user", content: "go" }], {
      client: fake,
      tools: [echoTool],
      signal: ac.signal,
    });
    expect(fake.signals[0]).toBe(ac.signal);
    expect(r.aborted).toBeUndefined(); // 未 abort，正常结束
  });
});

describe("runAgent（V7 决策 A1 封装）", () => {
  it("透传 reply/iterations，transcript 逐条落盘（user + assistant）", async () => {
    const fake = new FakeClient([
      [
        { type: "text", text: "hi" },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    const dir = mkdtempSync(path.join(tmpdir(), "ra-v7-"));
    tmpDirs.push(dir);
    const tf = path.join(dir, "sub.jsonl");

    const r = await runAgent({
      prompt: "ping",
      client: fake,
      tools: [echoTool],
      transcriptFile: tf,
    });

    expect(r.reply).toBe("hi");
    expect(r.iterations).toBe(1);
    expect(r.aborted).toBe(false);
    const lines = readFileSync(tf, "utf8").trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(2); // user(ping) + assistant(hi)
  });

  it("AbortError 传播为 aborted:true", async () => {
    const fake = new FakeClient([]);
    fake.failNext = Object.assign(new Error("aborted"), { name: "AbortError" });
    const r = await runAgent({ prompt: "ping", client: fake, tools: [echoTool] });
    expect(r.aborted).toBe(true);
  });
});
