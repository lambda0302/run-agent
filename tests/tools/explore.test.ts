import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  LLMClient,
  LLMMessage,
  StreamEvent,
  StreamOptions,
  ToolSpec,
} from "../../src/providers/types.js";
import { makeExploreTool } from "../../src/tools/explore.js";

let dirs: string[] = [];

/** 极小的临时目录：让 explore 子查询里的真实 grep 只扫到一个文件，跑得快。 */
function tinyDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "run-agent-explore-"));
  dirs.push(d);
  writeFileSync(path.join(d, "a.txt"), "x\n", "utf8");
  return d;
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

interface StreamCall {
  messages: LLMMessage[];
  tools?: ToolSpec[];
}

/** 假 client：记录每次 stream 的入参，按脚本逐事件回放。 */
function fakeClient(script: (call: StreamCall) => StreamEvent[]): {
  client: LLMClient;
  calls: StreamCall[];
} {
  const calls: StreamCall[] = [];
  const client: LLMClient = {
    provider: "fake",
    async *stream(messages: LLMMessage[], opts?: StreamOptions) {
      const call: StreamCall = {
        messages,
        // exactOptionalPropertyTypes：没传 tools 就不设键（摘要请求靠它区分）
        ...(opts?.tools !== undefined ? { tools: opts.tools } : {}),
      };
      calls.push(call);
      for (const ev of script(call)) yield ev;
    },
  };
  return { client, calls };
}

/** 一条指向极小时目录的 grep tool_use 事件；每次调用建一个新临时目录（测试内复用，afterEach 清理）。 */
function grepUse(): StreamEvent {
  return {
    type: "tool_use",
    id: "t1",
    name: "grep",
    input: { pattern: "zzz-nomatch", path: tinyDir() },
  };
}

describe("explore（只读子 agent）", () => {
  it("返回子 agent 的最终 reply", async () => {
    const { client } = fakeClient(() => [
      { type: "text", text: "子 agent 结论" },
      { type: "done", stopReason: "end_turn" },
    ]);
    const tool = makeExploreTool({ client });
    const r = await tool.call({ prompt: "探索一下" });
    expect(r.result).toBe("子 agent 结论");
  });

  it("子查询工具集只含只读工具（无 write/edit/bash/remember）", async () => {
    const { client, calls } = fakeClient(() => [
      { type: "text", text: "ok" },
      { type: "done", stopReason: "end_turn" },
    ]);
    const tool = makeExploreTool({ client });
    await tool.call({ prompt: "p" });
    const names = [...(calls[0]!.tools?.map((t) => t.name) ?? [])].sort();
    expect(names).toEqual(["glob", "grep", "read_file", "repo_map"].sort());
  });

  it("system 透传进子查询首条（复用主 system）", async () => {
    const { client, calls } = fakeClient(() => [
      { type: "text", text: "ok" },
      { type: "done", stopReason: "end_turn" },
    ]);
    const tool = makeExploreTool({ client, system: "MEMORY 索引: [[a]] [[b]]" });
    await tool.call({ prompt: "p" });
    const first = calls[0]!.messages[0];
    expect(first?.role).toBe("system");
    expect(first?.content).toContain("MEMORY 索引");
  });

  it("thoroughness → maxIterations（quick/medium/very thorough = 4/12/16；工具轮耗尽后补一轮收尾）", async () => {
    for (const [depth, expected] of [
      ["quick", 4],
      ["medium", 12],
      ["very thorough", 16],
    ] as const) {
      const ev = grepUse();
      const { client, calls } = fakeClient(() => [
        { type: "text", text: "x" },
        ev,
        { type: "done", stopReason: "tool_use" },
      ]);
      const tool = makeExploreTool({ client });
      await tool.call({ prompt: "p", thoroughness: depth });
      // 工具轮耗尽后 query.ts 补一轮仅文本收尾 → 调用数 = 轮数 + 1
      expect(calls).toHaveLength(expected + 1);
      // 收尾轮请求不带工具（强制纯文本给结论）
      expect(calls[expected]!.tools).toEqual([]);
    }
  });

  it("子查询超阈值自动压缩（摘要请求不带 tools，独立上下文不炸主会话）", async () => {
    let summarySeen = false;
    const ev = grepUse();
    const { client } = fakeClient((call) => {
      // 摘要请求不带 tools（summarizeHistory 无 tools）——用这一点区分
      if (call.tools === undefined) {
        summarySeen = true;
        return [
          { type: "text", text: "[摘要]" },
          { type: "done", stopReason: "end_turn" },
        ];
      }
      return [{ type: "text", text: "x" }, ev, { type: "done", stopReason: "tool_use" }];
    });
    const tool = makeExploreTool({ client, contextWindow: 300 });
    const r = await tool.call({ prompt: "p" });
    expect(summarySeen).toBe(true);
    expect(typeof r.result).toBe("string");
  });

  it("子查询异常转为 tool_result 文本（不抛出）", async () => {
    const { client } = fakeClient(() => {
      throw new Error("boom");
    });
    const tool = makeExploreTool({ client });
    const r = await tool.call({ prompt: "p" });
    expect(r.result).toContain("explore 子查询失败");
    expect(r.result).toContain("boom");
  });
});
