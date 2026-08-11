import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { COMPACT_MARKER } from "../../src/core/compact.js";
import type {
  LLMMessage,
  LLMClient,
  StreamEvent,
  StreamOptions,
} from "../../src/providers/types.js";
import { runQuery } from "../../src/core/query.js";
import type { Decision } from "../../src/permissions/types.js";
import type { Tool } from "../../src/tools.js";

const spillDirs: string[] = [];
afterEach(() => {
  for (const d of spillDirs) rmSync(d, { recursive: true, force: true });
  spillDirs.length = 0;
  delete process.env.RUN_AGENT_RESULT_SPILL_TOKENS;
});

/** 脚本化的 fake LLM：每次 stream() 弹出下一组事件，并记录收到的消息与 tools。 */
class FakeClient implements LLMClient {
  provider = "fake";
  calls: LLMMessage[][] = [];
  toolSpecs: StreamOptions["tools"][] = [];

  constructor(private scripted: StreamEvent[][]) {}

  async *stream(messages: LLMMessage[], opts?: StreamOptions): AsyncIterable<StreamEvent> {
    this.calls.push(messages);
    this.toolSpecs.push(opts?.tools);
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

describe("runQuery（mock LLM 的 golden 场景）", () => {
  it("单轮直接完成：收集 text 增量并返回 reply", async () => {
    const fake = new FakeClient([
      [
        { type: "text", text: "hi" },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    const r = await runQuery([{ role: "user", content: "ping" }], {
      client: fake,
      tools: [echoTool],
    });

    expect(r.reply).toBe("hi");
    expect(r.iterations).toBe(1);
    expect(r.messages).toEqual([
      { role: "user", content: "ping" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ]);
    // 传给模型的 ToolSpec 已做 JSON Schema 化
    expect(fake.toolSpecs[0]).toEqual([
      {
        name: "echo",
        description: "Echo the given text back",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
    ]);
  });

  it("工具轮→回填 tool_result→再请求→完成", async () => {
    const fake = new FakeClient([
      [
        { type: "tool_use", id: "t1", name: "echo", input: { text: "x" } },
        { type: "done", stopReason: "tool_use" },
      ],
      [
        { type: "text", text: "done" },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    const calls: string[] = [];
    const results: string[] = [];
    const r = await runQuery([{ role: "user", content: "go" }], {
      client: fake,
      tools: [echoTool],
      onToolCall: (name) => calls.push(name),
      onToolResult: (name, result) => results.push(`${name}:${result}`),
    });

    expect(r.reply).toBe("done");
    expect(r.iterations).toBe(2);

    // 第二轮请求应包含 assistant(tool_use) + tool(echo:x)
    const second = fake.calls[1]!;
    expect(second.find((m) => m.role === "tool")).toEqual({
      role: "tool",
      tool_use_id: "t1",
      content: "echo:x",
    });
    expect(second.some((m) => m.role === "assistant" && m.content !== "")).toBe(true);
    // 回调被触发
    expect(calls).toEqual(["echo"]);
    expect(results).toEqual(["echo:echo:x"]);
  });

  it("未知工具 → tool_result 回填未知工具提示", async () => {
    const fake = new FakeClient([
      [
        { type: "tool_use", id: "t9", name: "nope", input: {} },
        { type: "done", stopReason: "tool_use" },
      ],
      [
        { type: "text", text: "ok" },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    const r = await runQuery([{ role: "user", content: "go" }], {
      client: fake,
      tools: [echoTool],
    });

    const toolMsg = r.messages.find((m) => m.role === "tool");
    expect(toolMsg).toEqual({ role: "tool", tool_use_id: "t9", content: "未知工具: nope" });
  });

  it("max_tokens 截断 → 追加提示继续 → 正常完成", async () => {
    const fake = new FakeClient([
      [{ type: "done", stopReason: "max_tokens" }],
      [
        { type: "text", text: "fin" },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    const r = await runQuery([{ role: "user", content: "go" }], {
      client: fake,
      tools: [echoTool],
    });

    expect(r.reply).toBe("fin");
    expect(r.iterations).toBe(2);
    expect(
      r.messages.some(
        (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("截断"),
      ),
    ).toBe(true);
  });

  it("超过 maxIterations 兜底返回", async () => {
    const fake = new FakeClient([
      [
        { type: "tool_use", id: "t1", name: "echo", input: { text: "x" } },
        { type: "done", stopReason: "tool_use" },
      ],
    ]);
    const r = await runQuery([{ role: "user", content: "go" }], {
      client: fake,
      tools: [echoTool],
      maxIterations: 1,
    });
    expect(r.iterations).toBe(1);
  });
});

/**
 * 0.3.1 反应式压缩 mock：
 * - 摘要请求（首条是压缩系统提示）总给一段摘要；
 * - 主请求前 N 次抛 prompt_too_long，之后按成功脚本发射。
 */
class ReactiveClient implements LLMClient {
  provider = "fake";
  mainCalls = 0;
  summaryCalls = 0;

  constructor(
    private tooLongMain: number,
    private success: StreamEvent[],
  ) {}

  async *stream(messages: LLMMessage[]): AsyncIterable<StreamEvent> {
    const first = messages[0];
    const isSummary =
      first?.role === "system" &&
      typeof first.content === "string" &&
      first.content.includes("上下文压缩器");
    if (isSummary) {
      this.summaryCalls++;
      yield { type: "text", text: "摘要" };
      yield { type: "done", stopReason: "end_turn" };
      return;
    }
    this.mainCalls++;
    if (this.mainCalls <= this.tooLongMain) {
      throw Object.assign(new Error("messages: prompt is too long"), {
        status: 400,
        error: { type: "prompt_too_long" },
      });
    }
    for (const ev of this.success) yield ev;
  }
}

/** 流式失败 N 次后恢复的 fake：用于验证 transient 错误重试。 */
class FlakyClient implements LLMClient {
  provider = "fake";
  calls = 0;
  constructor(
    private failTimes: number,
    private events: StreamEvent[],
    private failError: { message: string; status?: number } = {
      message: "socket hang up",
      status: 503,
    },
  ) {}
  async *stream(): AsyncIterable<StreamEvent> {
    this.calls++;
    if (this.calls <= this.failTimes) {
      throw Object.assign(new Error(this.failError.message), { status: this.failError.status });
    }
    for (const ev of this.events) yield ev;
  }
}

describe("runQuery 流式错误重试", () => {
  it("transient 错误重试后成功（丢弃已收集增量、整轮重来）", async () => {
    const flaky = new FlakyClient(1, [
      { type: "text", text: "retried-ok" },
      { type: "done", stopReason: "end_turn" },
    ]);
    const r = await runQuery([{ role: "user", content: "go" }], {
      client: flaky,
      tools: [echoTool],
      maxRetries: 2,
    });
    expect(flaky.calls).toBe(2); // 第 1 次失败，第 2 次成功
    expect(r.reply).toBe("retried-ok");
  });

  it("非 transient 错误（4xx）不重试，直接抛给上层", async () => {
    const flaky = new FlakyClient(1, [{ type: "done", stopReason: "end_turn" }], {
      message: "bad request",
      status: 400,
    });
    await expect(
      runQuery([{ role: "user", content: "go" }], {
        client: flaky,
        tools: [echoTool],
        maxRetries: 2,
      }),
    ).rejects.toThrow("bad request");
    expect(flaky.calls).toBe(1);
  });

  it("重试次数耗尽后抛错（不无限重试）", async () => {
    const flaky = new FlakyClient(5, [{ type: "done", stopReason: "end_turn" }]);
    await expect(
      runQuery([{ role: "user", content: "go" }], {
        client: flaky,
        tools: [echoTool],
        maxRetries: 1,
      }),
    ).rejects.toThrow();
    expect(flaky.calls).toBe(2); // 1 次初始 + 1 次重试，共 2 次
  });
});

describe("runQuery V3 system 注入 + added 契约", () => {
  it("system 进请求首条、不进返回/持久化（result.messages/added）", async () => {
    const fake = new FakeClient([
      [
        { type: "text", text: "hi" },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    const r = await runQuery([{ role: "user", content: "ping" }], {
      client: fake,
      tools: [echoTool],
      system: "你是助手",
    });

    // 请求首条是 system
    const first = fake.calls[0]!;
    expect(first[0]).toEqual({ role: "system", content: "你是助手" });
    // 返回/持久化消息不含 system
    expect(r.messages.some((m) => m.role === "system")).toBe(false);
    expect(r.added.some((m) => m.role === "system")).toBe(false);
  });

  it("initial 里的 system 消息被过滤（防御）", async () => {
    const fake = new FakeClient([
      [
        { type: "text", text: "ok" },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    const r = await runQuery(
      [
        { role: "system", content: "应被过滤" },
        { role: "user", content: "hi" },
      ],
      { client: fake, tools: [echoTool] },
    );
    expect(r.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ]);
    expect(r.messages.some((m) => m.role === "system")).toBe(false);
    expect(fake.calls[0]!.some((m) => m.role === "system")).toBe(false);
  });

  it("added 等于本轮回调新增消息（REPL 用它逐条持久化）", async () => {
    const fake = new FakeClient([
      [
        { type: "tool_use", id: "t1", name: "echo", input: { text: "x" } },
        { type: "done", stopReason: "tool_use" },
      ],
      [
        { type: "text", text: "fin" },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    const r = await runQuery([{ role: "user", content: "go" }], {
      client: fake,
      tools: [echoTool],
    });
    expect(r.messages.slice(0, r.messages.length - r.added.length)).toEqual([
      { role: "user", content: "go" },
    ]);
    expect(r.added[r.added.length - 1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "fin" }],
    });
  });
});

describe("runQuery 权限集成", () => {
  it("checkPermission 返回 deny → tool_result 回填拒绝原因", async () => {
    const fake = new FakeClient([
      [
        { type: "tool_use", id: "t1", name: "echo", input: { text: "x" } },
        { type: "done", stopReason: "tool_use" },
      ],
      [
        { type: "text", text: "ok" },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    const r = await runQuery([{ role: "user", content: "go" }], {
      client: fake,
      tools: [echoTool],
      checkPermission: async () => "deny" as Decision,
    });

    const toolMsg = r.messages.find((m) => m.role === "tool");
    expect(toolMsg).toEqual({
      role: "tool",
      tool_use_id: "t1",
      content: "权限被拒绝: 未授权执行 echo",
    });
    expect(r.reply).toBe("ok");
  });
});

describe("runQuery V3 主动压缩 + 决策 8 指针化", () => {
  function longInitial(): LLMMessage[] {
    const out: LLMMessage[] = [];
    for (let i = 0; i < 6; i++) {
      out.push({ role: "user", content: "字".repeat(500) });
      out.push({ role: "assistant", content: "字".repeat(500) });
    }
    return out; // 12×500 = 6000 token
  }

  it("长历史超阈值 → 主动压缩 → 边界消息续跑，added 含边界、onCompact 触发", async () => {
    const fake = new FakeClient([
      // 摘要请求（summarizeHistory 内部直接调 client.stream）
      [
        { type: "text", text: "压缩摘要" },
        { type: "done", stopReason: "end_turn" },
      ],
      // 压缩后的主请求
      [
        { type: "text", text: "继续干" },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    let compactFired = 0;
    const r = await runQuery(longInitial(), {
      client: fake,
      tools: [echoTool],
      contextWindow: 5000, // threshold = floor(0.6*5000) = 3000；6000 > 3000
      onCompact: () => {
        compactFired++;
      },
    });

    expect(r.compacts).toBe(1);
    expect(compactFired).toBe(1);
    // 压缩后 messages 以边界消息开头
    expect(r.messages[0]!.role).toBe("user");
    expect(r.messages[0]!.content as string).toContain(COMPACT_MARKER);
    expect(r.messages[0]!.content as string).toContain("压缩摘要");
    // 边界走 added 契约（REPL 持久化它，resume 才能续起）
    expect(
      r.added.some((m) => typeof m.content === "string" && m.content.includes(COMPACT_MARKER)),
    ).toBe(true);
    // 续跑回复正确
    expect(r.reply).toBe("继续干");
  });

  it("querySource='compact' 跳过主动压缩（防递归）：不调摘要、无边界", async () => {
    const fake = new FakeClient([
      [
        { type: "text", text: "ok" },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    const r = await runQuery(longInitial(), {
      client: fake,
      tools: [echoTool],
      contextWindow: 5000,
      querySource: "compact",
    });
    expect(r.compacts).toBe(0);
    expect(fake.calls.length).toBe(1); // 只有主请求，无摘要子请求
    expect(
      r.messages.some((m) => typeof m.content === "string" && m.content.includes(COMPACT_MARKER)),
    ).toBe(false);
  });

  it("resultsDir 提供时超大工具结果落盘换指针，全文可从文件读回", async () => {
    process.env.RUN_AGENT_RESULT_SPILL_TOKENS = "10";
    const dir = mkdtempSync(path.join(tmpdir(), "run-agent-spill-"));
    spillDirs.push(dir);

    const fake = new FakeClient([
      [
        { type: "tool_use", id: "t1", name: "echo", input: { text: "x".repeat(200) } },
        { type: "done", stopReason: "tool_use" },
      ],
      [
        { type: "text", text: "done" },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    const r = await runQuery([{ role: "user", content: "go" }], {
      client: fake,
      tools: [echoTool],
      resultsDir: dir,
    });

    const toolMsg = r.messages.find((m) => m.role === "tool")!;
    expect(toolMsg.content).toContain("结果已写入");
    expect(toolMsg.content).toContain(path.join(dir, "r0.txt"));
    expect(readFileSync(path.join(dir, "r0.txt"), "utf8")).toBe("echo:" + "x".repeat(200));
  });

  it("无 resultsDir → 结果原样进消息列表（不落盘）", async () => {
    const fake = new FakeClient([
      [
        { type: "tool_use", id: "t1", name: "echo", input: { text: "small" } },
        { type: "done", stopReason: "tool_use" },
      ],
      [
        { type: "text", text: "done" },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    const r = await runQuery([{ role: "user", content: "go" }], {
      client: fake,
      tools: [echoTool],
    });
    const toolMsg = r.messages.find((m) => m.role === "tool")!;
    expect(toolMsg.content).toBe("echo:small");
  });
});

describe("runQuery 0.3.1 反应式压缩 + 硬截断兜底", () => {
  it("主请求抛 prompt_too_long → 强制压缩 → 重试成功（边界进 added、onCompact 触发）", async () => {
    const rc = new ReactiveClient(1, [
      { type: "text", text: "恢复了" },
      { type: "done", stopReason: "end_turn" },
    ]);
    let fired = 0;
    const r = await runQuery(
      [
        { role: "user", content: "ping" },
        { role: "assistant", content: "hi" },
      ],
      {
        client: rc,
        tools: [echoTool],
        contextWindow: 5000,
        onCompact: () => {
          fired++;
        },
      },
    );

    expect(rc.mainCalls).toBe(2); // 第 1 次超长 → 强制压缩；第 2 次成功
    expect(rc.summaryCalls).toBe(1); // 摘要请求被正确识别
    expect(r.compacts).toBe(1);
    expect(fired).toBe(1);
    expect(r.reply).toBe("恢复了");
    // 边界走 added 契约（REPL 持久化后 resume 才能续起）
    expect(
      r.added.some((m) => typeof m.content === "string" && m.content.includes(COMPACT_MARKER)),
    ).toBe(true);
    // 消息列表以边界开头
    expect(r.messages[0]!.content as string).toContain(COMPACT_MARKER);
  });

  it("压缩后仍超长且裁不动 → 有界抛原错误（不无限循环）", async () => {
    const rc = new ReactiveClient(99, [
      { type: "text", text: "x" },
      { type: "done", stopReason: "end_turn" },
    ]);
    await expect(
      runQuery([{ role: "user", content: "字".repeat(200) }], {
        client: rc,
        tools: [echoTool],
        contextWindow: 5000,
      }),
    ).rejects.toThrow("prompt is too long");
    // 主请求：第 1 次超长 → 强制压缩 → 第 2 次（边界仍超长）→ 硬截断裁不动 → 抛
    expect(rc.mainCalls).toBe(2);
    expect(rc.summaryCalls).toBe(1);
  });

  it("未配 contextWindow → 不做反应式压缩，直接抛", async () => {
    const rc = new ReactiveClient(1, [
      { type: "text", text: "x" },
      { type: "done", stopReason: "end_turn" },
    ]);
    await expect(
      runQuery([{ role: "user", content: "hi" }], {
        client: rc,
        tools: [echoTool],
      }),
    ).rejects.toThrow("prompt is too long");
    expect(rc.mainCalls).toBe(1);
    expect(rc.summaryCalls).toBe(0);
  });
});
