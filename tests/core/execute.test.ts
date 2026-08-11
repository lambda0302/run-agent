import { describe, expect, it } from "vitest";
import { z } from "zod";
import { executeToolCalls, StreamingToolExecutor } from "../../src/core/execute.js";
import type { Decision } from "../../src/permissions/types.js";
import type { ToolUseBlock } from "../../src/providers/types.js";
import type { Tool } from "../../src/tools.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 并发追踪器：记录最大同时活跃数。注意 max 要用 getter 暴露——属性会按值快照（恒为 0）。 */
function tracker() {
  let active = 0;
  let max = 0;
  return {
    run: async (fn: () => Promise<string>): Promise<string> => {
      active++;
      if (active > max) max = active;
      try {
        return await fn();
      } finally {
        active--;
      }
    },
    currentMax: () => max,
  };
}

/**
 * 建工具：delay 毫秒的异步执行，让"是否真的并行"可被并发追踪器观测。
 * concurrencySafe 决定工具进并行批还是串行批。
 * sleep 放在 tracker.run 内部，这样"同时活跃"就包含执行耗时，并发度可被稳定测量。
 */
function makeTool(
  name: string,
  delay: number,
  concurrencySafe: boolean,
): { tool: Tool; maxActive: () => number } {
  const t = tracker();
  const tool: Tool = {
    name,
    description: name,
    inputSchema: z.object({ id: z.number() }),
    ...(concurrencySafe ? { isConcurrencySafe: true } : {}),
    async call(input) {
      const { id } = input as { id: number };
      return {
        result: await t.run(async () => {
          if (delay > 0) await sleep(delay);
          return `${name}:${id}`;
        }),
      };
    },
  };
  return { tool, maxActive: () => t.currentMax() };
}

function tu(name: string, id: string, input: unknown): ToolUseBlock {
  return { type: "tool_use", id, name, input };
}

describe("executeToolCalls 并发执行", () => {
  it("只读工具并行执行，结果按原顺序返回", async () => {
    const read = makeTool("read", 15, true);
    const calls = [
      tu("read", "a", { id: 1 }),
      tu("read", "b", { id: 2 }),
      tu("read", "c", { id: 3 }),
    ];
    const results = await executeToolCalls(calls, { tools: [read.tool] });
    expect(results).toEqual(["read:1", "read:2", "read:3"]);
    expect(read.maxActive()).toBe(3); // 3 个并行全开
  });

  it("读写混合：结果重排回原始顺序（读并行、写串行）", async () => {
    const read = makeTool("read", 10, true);
    const write = makeTool("write", 5, false);
    const calls = [
      tu("write", "w1", { id: 1 }),
      tu("read", "r1", { id: 10 }),
      tu("write", "w2", { id: 2 }),
      tu("read", "r2", { id: 20 }),
    ];
    const results = await executeToolCalls(calls, { tools: [read.tool, write.tool] });
    expect(results).toEqual(["write:1", "read:10", "write:2", "read:20"]);
  });

  it("写工具串行：同时活跃的写从不超过 1", async () => {
    const write = makeTool("write", 20, false);
    const calls = [1, 2, 3, 4].map((n) => tu("write", `w${n}`, { id: n }));
    await executeToolCalls(calls, { tools: [write.tool] });
    expect(write.maxActive()).toBe(1);
  });

  it("maxConcurrency 限制并行批的并发度", async () => {
    const read = makeTool("read", 20, true);
    const calls = [1, 2, 3, 4, 5].map((n) => tu("read", `r${n}`, { id: n }));
    await executeToolCalls(calls, { tools: [read.tool], maxConcurrency: 2 });
    expect(read.maxActive()).toBe(2);
  });
});

describe("executeToolCalls 异常与权限", () => {
  it("未知工具 → 提示串", async () => {
    const read = makeTool("read", 0, true);
    const results = await executeToolCalls([tu("nope", "x", {})], { tools: [read.tool] });
    expect(results).toEqual(["未知工具: nope"]);
  });

  it("权限 deny → 提示串，且不执行工具本体", async () => {
    const read = makeTool("read", 0, true);
    let called = false;
    const checkPermission = async (): Promise<Decision> => {
      called = true;
      return "deny";
    };
    const results = await executeToolCalls([tu("read", "a", { id: 1 })], {
      tools: [read.tool],
      checkPermission,
    });
    expect(results).toEqual(["权限被拒绝: 未授权执行 read"]);
    expect(called).toBe(true);
  });

  it("工具本体抛错 → 提示串（不中断整批）", async () => {
    const boom: Tool = {
      name: "boom",
      description: "boom",
      inputSchema: z.object({}),
      isConcurrencySafe: true,
      async call() {
        throw new Error("爆炸");
      },
    };
    const read = makeTool("read", 0, true);
    const results = await executeToolCalls([tu("boom", "b", {}), tu("read", "r", { id: 1 })], {
      tools: [boom, read.tool],
    });
    expect(results).toEqual(["工具执行错误: 爆炸", "read:1"]);
  });

  it("onToolCall / onToolResult 回调触发", async () => {
    const read = makeTool("read", 0, true);
    const calls: string[] = [];
    const results: string[] = [];
    await executeToolCalls([tu("read", "a", { id: 7 })], {
      tools: [read.tool],
      onToolCall: (n) => calls.push(n),
      onToolResult: (n, res) => results.push(`${n}:${res}`),
    });
    expect(calls).toEqual(["read"]);
    expect(results).toEqual(["read:read:7"]);
  });
});

// ── V5 决策 C：StreamingToolExecutor 直测（流式边执行语义）──────────────────────────
describe("StreamingToolExecutor 流式即时执行", () => {
  it("addTool 后工具立即启动（不等 getResults）", async () => {
    const read = makeTool("read", 40, true);
    const exec = new StreamingToolExecutor({ tools: [read.tool] });
    await exec.addTool(tu("read", "a", { id: 1 }), 0);
    // addTool 只等权限校验+入队，工具本体已 fire-and-forget 启动
    expect(read.maxActive()).toBe(1);
    expect(await exec.getResults()).toEqual(["read:1"]);
  });

  it("写类执行期间不并入 safe 工具；写一次一个、不打断，随后 safe 并行", async () => {
    const read = makeTool("read", 30, true);
    const write = makeTool("write", 20, false);
    const exec = new StreamingToolExecutor({ tools: [read.tool, write.tool] });
    await exec.addTool(tu("write", "w1", { id: 1 }), 0);
    await exec.addTool(tu("read", "r1", { id: 10 }), 1);
    await exec.addTool(tu("read", "r2", { id: 20 }), 2);
    // write 20ms 先完成（期间 read 不入队执行）→ read 两个随后并行
    expect(await exec.getResults()).toEqual(["write:1", "read:10", "read:20"]);
    expect(write.maxActive()).toBe(1);
    expect(read.maxActive()).toBe(2);
  });

  it("getResults 等待全部完成且幂等（可并发调用多次）", async () => {
    const read = makeTool("read", 30, true);
    const exec = new StreamingToolExecutor({ tools: [read.tool] });
    await exec.addTool(tu("read", "a", { id: 1 }), 0);
    const p1 = exec.getResults();
    const p2 = exec.getResults();
    expect(await p1).toEqual(["read:1"]);
    expect(await p2).toEqual(["read:1"]);
  });

  it("addTool 权限 deny → 立即回填且不执行工具本体", async () => {
    const read = makeTool("read", 0, true);
    let called = false;
    const exec = new StreamingToolExecutor({
      tools: [read.tool],
      checkPermission: async () => {
        called = true;
        return "deny";
      },
    });
    await exec.addTool(tu("read", "a", { id: 1 }), 0);
    expect(called).toBe(true);
    expect(await exec.getResults()).toEqual(["权限被拒绝: 未授权执行 read"]);
  });

  it("工具池为函数时每次 addTool 重新解析（动态 MCP 场景）", async () => {
    const read = makeTool("read", 0, true);
    let resolved = 0;
    const toolsFn = () => {
      resolved++;
      return [read.tool];
    };
    const exec = new StreamingToolExecutor({ tools: toolsFn });
    await exec.addTool(tu("read", "a", { id: 1 }), 0);
    await exec.addTool(tu("read", "b", { id: 2 }), 1);
    expect(resolved).toBe(2); // 每个 block 解析一次
    expect(await exec.getResults()).toEqual(["read:1", "read:2"]);
  });
});
