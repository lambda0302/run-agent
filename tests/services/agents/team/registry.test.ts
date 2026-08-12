import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { LLMClient, LLMMessage, StreamEvent } from "../../../../src/providers/types.js";
import { BackgroundTaskManager } from "../../../../src/services/agents/team/registry.js";
import type { Tool } from "../../../../src/tools.js";

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

describe("BackgroundTaskManager（V7 决策 A6/C2/C3）", () => {
  it("spawn + awaitAll：等任务完成并汇总（含类型与 reply 预览）", async () => {
    const fake = new FakeClient([
      [
        { type: "text", text: "结论 A" },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    const mgr = new BackgroundTaskManager();
    const id = mgr.spawn({
      type: "general-purpose",
      prompt: "do x",
      client: fake,
      tools: [echoTool],
    });

    const summaries = await mgr.awaitAll();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toContain(id);
    expect(summaries[0]).toContain("general-purpose");
    expect(summaries[0]).toContain("结论 A");

    const info = mgr.list();
    expect(info).toHaveLength(1);
    expect(info[0]!.status).toBe("done");
  });

  it("send：写入 pending 队列，poll 原子取空（SendMessage 送达）", async () => {
    const fake = new FakeClient([]);
    const mgr = new BackgroundTaskManager();
    const id = mgr.spawn({ type: "general-purpose", prompt: "x", client: fake, tools: [echoTool] });

    const r = mgr.send(id, "补充要求");
    expect(r).toContain("已发送给后台子 agent");
    expect(mgr.poll(id)).toEqual([{ role: "user", content: "补充要求" }]);
    expect(mgr.poll(id)).toBeUndefined(); // 已取空
  });

  it("stop：abort 传播 + 状态 stopped + 幂等", async () => {
    const fake = new FakeClient([]);
    const mgr = new BackgroundTaskManager();
    const id = mgr.spawn({ type: "general-purpose", prompt: "x", client: fake, tools: [echoTool] });

    expect(mgr.isAborted(id)).toBe(false);
    const r = mgr.stop(id);
    expect(r).toContain("已请求停止");
    expect(mgr.isAborted(id)).toBe(true);
    // 幂等：已结束再 stop 返回已结束
    expect(mgr.stop(id)).toContain("已结束");
  });

  it("awaitAll 只汇总一次：第二次调用返回空（防跨 end_turn 重复注入死循环）", async () => {
    const fake = new FakeClient([
      [
        { type: "text", text: "r" },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    const mgr = new BackgroundTaskManager();
    mgr.spawn({ type: "general-purpose", prompt: "x", client: fake, tools: [echoTool] });

    const first = await mgr.awaitAll();
    expect(first).toHaveLength(1);
    const second = await mgr.awaitAll();
    expect(second).toHaveLength(0);
  });

  it("send/stop 对不存在的任务返回提示", async () => {
    const mgr = new BackgroundTaskManager();
    expect(mgr.send("nope", "hi")).toContain("不存在");
    expect(mgr.stop("nope")).toContain("不存在");
  });

  it("后台永不弹窗：父级 ask 被降级 deny，工具不执行（V7 决策 A7 安全底线）", async () => {
    const executed: string[] = [];
    const spyTool: Tool = {
      name: "spy",
      description: "spy",
      inputSchema: z.object({}),
      async call() {
        executed.push("executed");
        return { result: "ok" };
      },
    };
    // 第一次 stream：请求 spy 工具；第二次：收工具结果后正常结束
    const fake = new FakeClient([
      [
        { type: "tool_use", id: "tu1", name: "spy", input: {} },
        { type: "done", stopReason: "tool_use" },
      ],
      [
        { type: "text", text: "fin" },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    const mgr = new BackgroundTaskManager();
    mgr.spawn({
      type: "general-purpose",
      prompt: "x",
      client: fake,
      tools: [spyTool],
      checkPermission: async () => ({ decision: "ask" }),
    });
    const summaries = await mgr.awaitAll();
    expect(executed).toEqual([]); // ask 被降级 deny → 工具未执行
    expect(mgr.list()[0]!.status).toBe("done");
    expect(summaries[0]).toContain("fin");
  });

  it("两个后台任务并行：awaitAll 汇总两行（协调者拆 2 specialist 的场景）", async () => {
    const mgr = new BackgroundTaskManager();
    mgr.spawn({
      type: "general-purpose",
      prompt: "a",
      client: new FakeClient([
        [
          { type: "text", text: "结论 A" },
          { type: "done", stopReason: "end_turn" },
        ],
      ]),
      tools: [echoTool],
    });
    mgr.spawn({
      type: "explore",
      prompt: "b",
      client: new FakeClient([
        [
          { type: "text", text: "结论 B" },
          { type: "done", stopReason: "end_turn" },
        ],
      ]),
      tools: [echoTool],
    });
    const summaries = await mgr.awaitAll();
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toContain("结论 A");
    expect(summaries[1]).toContain("结论 B");
    expect(mgr.list().every((t) => t.status === "done")).toBe(true);
  });
});
