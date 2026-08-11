import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { estimateMessagesTokens } from "../../src/core/context.js";
import type { LLMClient, LLMMessage, StreamEvent } from "../../src/providers/types.js";
import {
  COMPACT_MARKER,
  buildBoundaryMessage,
  collectReadFiles,
  computeCompactThreshold,
  hardTruncateToFit,
  maybeAutoCompact,
  normalizeToolPairing,
  spillOversizedResult,
  summarizeHistory,
} from "../../src/core/compact.js";
import type { Tool } from "../../src/tools.js";

let dirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "run-agent-compact-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  delete process.env.RUN_AGENT_RESULT_SPILL_TOKENS;
});

/** 脚本化 fake：每次 stream() 弹出下一组事件，并记录收到的消息。 */
class FakeClient implements LLMClient {
  provider = "fake";
  calls: LLMMessage[][] = [];

  constructor(private scripted: StreamEvent[][]) {}

  async *stream(messages: LLMMessage[]): AsyncIterable<StreamEvent> {
    this.calls.push(messages);
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

const cjk = (n: number) => "字".repeat(n);

/** 交替 user/assistant 的长历史（CJK 每字 1 token）。 */
function longHistory(n: number, per = 500): LLMMessage[] {
  const out: LLMMessage[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ role: "user", content: cjk(per) });
    out.push({ role: "assistant", content: cjk(per) });
  }
  return out;
}

describe("computeCompactThreshold", () => {
  it("大窗口走 contextWindow − 13000，小窗口钳制到 60%", () => {
    expect(computeCompactThreshold(200_000)).toBe(187_000);
    expect(computeCompactThreshold(8192)).toBe(4915); // floor(0.6*8192)
  });
});

describe("buildBoundaryMessage", () => {
  it("含哨兵 + 摘要 + 重挂文件块，role=user", () => {
    const m = buildBoundaryMessage("摘要文本", [{ path: "/abs/f.ts", content: "line1\nline2" }]);
    expect(m.role).toBe("user");
    const c = m.content as string;
    expect(c).toContain(COMPACT_MARKER);
    expect(c).toContain("摘要文本");
    expect(c).toContain("/abs/f.ts");
    expect(c).toContain("line1\nline2");
  });
});

describe("collectReadFiles", () => {
  const read = (p: string) => ({
    type: "tool_use" as const,
    id: p,
    name: "read_file",
    input: { file_path: p },
  });

  it("去重、保最近顺序、上限 5（单条消息多 read_file 也守上限）", () => {
    const messages: LLMMessage[] = [
      { role: "assistant", content: [read("a.ts")] },
      // b.ts 后再读 a.ts：最近的 a.ts 应胜出，b.ts 在去重后仍保留
      { role: "assistant", content: [read("b.ts"), read("a.ts")] },
      { role: "assistant", content: [{ type: "tool_use", id: "x", name: "glob", input: {} }] },
      { role: "assistant", content: [read("c.ts")] },
      { role: "assistant", content: [read("d.ts")] },
      { role: "assistant", content: [read("e.ts")] },
      { role: "assistant", content: [read("f.ts")] },
    ];
    expect(collectReadFiles(messages)).toEqual(["b.ts", "c.ts", "d.ts", "e.ts", "f.ts"]);
  });

  it("没有 read_file 时返回空数组", () => {
    expect(collectReadFiles([{ role: "user", content: "hi" }])).toEqual([]);
  });
});

describe("spillOversizedResult（决策 8 指针化）", () => {
  it("超阈值 → 落盘并返回指针；未超阈值原样返回", async () => {
    process.env.RUN_AGENT_RESULT_SPILL_TOKENS = "10";
    const dir = tempDir();

    const small = "ok";
    expect(await spillOversizedResult(small, 0, dir)).toBe(small);

    const big = "x".repeat(200); // ~50 token > 10
    const ptr = await spillOversizedResult(big, 1, dir);
    expect(ptr).toContain("结果已写入");
    expect(ptr).toContain("r1.txt");
    expect(readFileSync(path.join(dir, "r1.txt"), "utf8")).toBe(big);
  });

  it("默认阈值（无 env 覆盖）下大结果落盘", async () => {
    const dir = tempDir();
    const big = "x".repeat(40_000); // 远超 8192 token
    const ptr = await spillOversizedResult(big, 0, dir);
    expect(ptr).toContain("结果已写入");
    expect(readFileSync(path.join(dir, "r0.txt"), "utf8")).toBe(big);
  });
});

describe("summarizeHistory", () => {
  it("流式累积 text、首条为压缩系统提示、返回拼接文本", async () => {
    const fake = new FakeClient([
      [
        { type: "text", text: "第一段" },
        { type: "text", text: "第二段" },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    const out = await summarizeHistory(fake, [{ role: "user", content: "hi" }], {
      contextWindow: 10_000,
    });
    expect(out).toBe("第一段第二段");
    expect(fake.calls[0]![0]!.role).toBe("system");
  });

  it("摘要输入超 budget 时先裁最老消息（防摘要自身爆窗）", async () => {
    const fake = new FakeClient([
      [
        { type: "text", text: "s" },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    await summarizeHistory(fake, longHistory(20, 500), { contextWindow: 10_000 });
    // budget = 10000−3000 = 7000 token；20×500=10000 需裁掉最老若干条
    expect(fake.calls[0]!.length).toBeLessThan(20 + 1);
  });
});

describe("maybeAutoCompact", () => {
  it("短历史/未超阈值 → 不压缩，消息原样返回，不调模型", async () => {
    const fake = new FakeClient([]);
    const msgs: LLMMessage[] = [{ role: "user", content: "hi" }];
    const res = await maybeAutoCompact(msgs, {
      client: fake,
      tools: [echoTool],
      contextWindow: 200_000,
    });
    expect(res.compacted).toBe(false);
    expect(res.messages).toBe(msgs);
    expect(fake.calls.length).toBe(0);
  });

  it("消息数 < 4 即使超阈值也不压缩", async () => {
    const fake = new FakeClient([]);
    const msgs: LLMMessage[] = [
      { role: "user", content: cjk(10_000) },
      { role: "assistant", content: "x" },
    ];
    const res = await maybeAutoCompact(msgs, {
      client: fake,
      tools: [echoTool],
      contextWindow: 10_000, // threshold = 6000
    });
    expect(res.compacted).toBe(false);
    expect(fake.calls.length).toBe(0);
  });

  it("历史超阈值 → 摘要 → 单边界消息（含哨兵/摘要），onCompact 触发", async () => {
    const fake = new FakeClient([
      [
        { type: "text", text: "摘要: 完成了 X" },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    let fired = 0;
    const msgs = longHistory(6, 800); // 12×800 = 9600 token > 6000
    const res = await maybeAutoCompact(msgs, {
      client: fake,
      tools: [echoTool],
      contextWindow: 10_000,
      onCompact: () => {
        fired++;
      },
    });
    expect(res.compacted).toBe(true);
    expect(res.messages.length).toBe(1);
    const c = res.messages[0]!.content as string;
    expect(c).toContain(COMPACT_MARKER);
    expect(c).toContain("摘要: 完成了 X");
    expect(fired).toBe(1);
  });

  it("压缩时已读文件重挂：边界消息含本地文件内容（压缩后可恢复）", async () => {
    const dir = tempDir();
    const f1 = path.join(dir, "a.ts");
    writeFileSync(f1, "export const a = 1;\n", "utf8");
    const fake = new FakeClient([
      [
        { type: "text", text: "摘要" },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    const msgs: LLMMessage[] = [
      ...longHistory(5, 800),
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "r1", name: "read_file", input: { file_path: f1 } }],
      },
    ];
    const res = await maybeAutoCompact(msgs, {
      client: fake,
      tools: [echoTool],
      contextWindow: 10_000,
    });
    expect(res.compacted).toBe(true);
    const c = res.messages[0]!.content as string;
    expect(c).toContain(`--- ${f1} ---`);
    expect(c).toContain("export const a = 1;");
  });

  it("force 忽略阈值与最小消息数：短历史也强制压缩", async () => {
    const fake = new FakeClient([
      [
        { type: "text", text: "强压摘要" },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    const msgs: LLMMessage[] = [{ role: "user", content: "hi" }];
    const res = await maybeAutoCompact(msgs, {
      client: fake,
      tools: [echoTool],
      contextWindow: 10_000,
      force: true,
    });
    expect(res.compacted).toBe(true);
    expect(res.messages.length).toBe(1);
  });
});

describe("hardTruncateToFit（0.3.1 硬截断兜底）", () => {
  it("超限时反复丢最老直到 fit，至少保留 1 条", () => {
    const msgs: LLMMessage[] = [
      { role: "user", content: cjk(300) }, // 300
      { role: "assistant", content: cjk(300) },
      { role: "user", content: cjk(300) },
      { role: "assistant", content: cjk(300) },
    ];
    const out = hardTruncateToFit(msgs, 500);
    expect(estimateMessagesTokens(out)).toBeLessThanOrEqual(500);
    expect(out.length).toBeGreaterThanOrEqual(1);
    // 丢的是最老的（第一条被移走）
    expect(out[0]).not.toEqual(msgs[0]);
  });

  it("已 fit 则原样保留顺序", () => {
    const msgs: LLMMessage[] = [{ role: "user", content: "hi" }];
    expect(hardTruncateToFit(msgs, 1000)).toEqual(msgs);
  });
});

describe("normalizeToolPairing（0.3.1 孤儿 tool 修复）", () => {
  it("无对应 tool_use 的 tool 结果被丢弃", () => {
    const msgs: LLMMessage[] = [
      { role: "user", content: "hi" },
      { role: "tool", tool_use_id: "orphan", content: "echo:1" },
    ];
    expect(normalizeToolPairing(msgs)).toEqual([{ role: "user", content: "hi" }]);
  });

  it("无后续 tool 结果的 tool_use 块被清掉（纯块消息整条丢弃，带文本的保留文本）", () => {
    const dangling: LLMMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "echo", input: {} }],
      },
    ];
    expect(normalizeToolPairing(dangling)).toEqual([]);

    const withText: LLMMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "先说说" },
          { type: "tool_use", id: "t1", name: "echo", input: {} },
        ],
      },
    ];
    expect(normalizeToolPairing(withText)).toEqual([
      { role: "assistant", content: [{ type: "text", text: "先说说" }] },
    ]);
  });

  it("配对完整时原样保留", () => {
    const msgs: LLMMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "echo", input: { text: "x" } }],
      },
      { role: "tool", tool_use_id: "t1", content: "echo:x" },
    ];
    expect(normalizeToolPairing(msgs)).toEqual(msgs);
  });
});
