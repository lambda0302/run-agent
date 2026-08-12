/**
 * V7 决策 A7 接线测试：REPL/one-shot 的 queryOpts 把 onBackgroundDone 接到
 * BackgroundTaskManager.awaitAll——轮末等后台子 agent 完成并汇总注入。
 *
 * 背景（实测复现）：协调者用 agent 工具后台委派 2 个 explore 子 agent 后 end_turn，
 * 但 onBackgroundDone 从未传给 runQuery → awaitAll 没被调用，后台结果完成也没人收集，
 * 协调者只说完「等待它们返回后我会汇总结果」就闭嘴，两个结论被丢弃。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { LLMClient, LLMMessage, StreamEvent } from "../../src/providers/types.js";
import { runOneShot } from "../../src/cli/repl.js";
import { BackgroundTaskManager } from "../../src/services/agents/team/registry.js";
import type { Tool } from "../../src/tools.js";

/** 脚本化 fake LLM：每次 stream() 弹出下一组事件。 */
class FakeClient implements LLMClient {
  provider = "fake";
  calls: LLMMessage[][] = [];

  constructor(private scripted: StreamEvent[][]) {}

  async *stream(messages: LLMMessage[]): AsyncIterable<StreamEvent> {
    // 浅拷贝：runQuery 的 requestMessages 与内部 messages 是同一引用（无 system 时），
    // 后续 pushConversation 注入会改动原数组 → 不拷贝会让 calls[0] 被二次写入污染
    this.calls.push([...messages]);
    const next = this.scripted.shift();
    for (const ev of next ?? [{ type: "done", stopReason: "end_turn" }]) yield ev;
  }
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("queryOpts 后台汇总接线（V7 决策 A7）", () => {
  it("协调者 end_turn → awaitAll 收集后台结果 → 注入新轮 → 收尾汇总", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ra-bg-collect-"));
    dirs.push(dir);

    // 后台子 agent：独立 client，产出「结论 A」
    const bgClient = new FakeClient([
      [
        { type: "text", text: "engine.ts 的 hasPermissionsToUseTool 判 ask → repl.ts resolveAsk" },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    const mgr = new BackgroundTaskManager();
    const bgId = mgr.spawn({
      type: "explore",
      prompt: "探索权限管线",
      client: bgClient,
      tools: [] as Tool[],
    });

    // 主协调者：第 1 轮只说完「等待」就 end_turn（后台任务此时可能还在跑）；
    // 第 2 轮（注入汇总后）给出最终汇总。
    const main = new FakeClient([
      [
        { type: "text", text: "已并行委派，等待子 agent 返回" },
        { type: "done", stopReason: "end_turn" },
      ],
      [
        { type: "text", text: "汇总: 权限管线与工具池清单……" },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    const out = new PassThrough();
    out.resume();

    const r = await runOneShot(
      {
        client: main,
        tools: [] as Tool[],
        sessionFile: path.join(dir, "s.jsonl"),
        out,
        backgroundTasks: mgr,
      },
      "并行委派 2 个 explore，等返回后汇总",
    );

    // 最终 reply 是收尾汇总，不是第一轮的「等待」
    expect(r.reply).toBe("汇总: 权限管线与工具池清单……");
    // 主循环发了 2 次请求：委派轮 + 汇总轮
    expect(main.calls).toHaveLength(2);
    // 第一轮请求不掺后台汇总；第二轮请求含注入的「[后台子 agent 结果]」
    expect(
      main.calls[0]!.some(
        (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("后台子 agent 结果"),
      ),
    ).toBe(false);
    const secondUser = main.calls[1]!.find(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("后台子 agent 结果"),
    );
    expect(secondUser).toBeDefined();
    expect((secondUser!.content as string)).toContain(bgId);
    expect((secondUser!.content as string)).toContain("engine.ts 的 hasPermissionsToUseTool");
    // 后台任务已 done 且被报告过（awaitAll 去重：二次调用不再注入）
    expect(mgr.list()[0]!.status).toBe("done");
    const again = await mgr.awaitAll();
    expect(again).toHaveLength(0);
  });

  it("无后台任务时 onBackgroundDone 短路：一轮直接完成", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ra-bg-none-"));
    dirs.push(dir);
    const main = new FakeClient([
      [
        { type: "text", text: "直接完成" },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    const mgr = new BackgroundTaskManager();
    const out = new PassThrough();
    out.resume();

    const r = await runOneShot(
      { client: main, tools: [], sessionFile: path.join(dir, "s.jsonl"), out, backgroundTasks: mgr },
      "直接干一件事",
    );

    expect(r.reply).toBe("直接完成");
    expect(main.calls).toHaveLength(1); // 没有多余轮次
  });
});
