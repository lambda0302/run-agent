/**
 * V5 决策 A 测试：plan 模式导航工具 + /plan 手动入口 + 装配边界 + REPL 全流程集成。
 * REPL 集成用注入的 ask 弹窗模拟 y/n（不建 readline，保持 hermetic）。
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { makeCheckPermission } from "../../src/cli/repl.js";
import { hasPermissionsToUseTool } from "../../src/permissions/engine.js";
import type { PermissionContext, PermissionMode } from "../../src/permissions/types.js";
import { buildTools } from "../../src/tools.js";
import type { Tool } from "../../src/tools.js";
import { makePlanTools } from "../../src/tools/plan_mode.js";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "run-agent-plan-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 无副作用写流：makeCheckPermission 的 out 参数（deny 时写一行）。 */
const silentOut = { write: () => true } as unknown as NodeJS.WritableStream;

/** 受控 mode 状态（模拟 repl 的 ctx.mode 闭包）。 */
function modeBox(initial: PermissionMode): {
  state: { mode: PermissionMode };
  get: () => PermissionMode;
  set: (m: PermissionMode) => void;
} {
  const state = { mode: initial };
  return { state, get: () => state.mode, set: (m) => void (state.mode = m) };
}

const fakeWrite: Tool = {
  name: "write_file",
  description: "",
  inputSchema: z.object({}),
  call: async () => ({ result: "" }),
};
const fakeRead: Tool = {
  name: "read_file",
  description: "",
  inputSchema: z.object({}),
  call: async () => ({ result: "" }),
};

describe("makePlanTools（V5 决策 A2/A3）", () => {
  it("enter_plan_mode：default 下可进入，mode 变 plan，返回只读指引", async () => {
    const box = modeBox("default");
    const pt = makePlanTools({ getMode: box.get, setMode: box.set, canPrompt: true });
    const [enter] = pt.tools as [Tool];
    const r = await enter.call({});
    expect(box.state.mode).toBe("plan");
    expect(r.result).toContain("plan");
    expect(r.result).toContain("只读");
  });

  it("enter_plan_mode：已在 plan 报错，mode 不变", async () => {
    const box = modeBox("plan");
    const pt = makePlanTools({ getMode: box.get, setMode: box.set, canPrompt: true });
    const [enter] = pt.tools as [Tool];
    const r = await enter.call({});
    expect(box.state.mode).toBe("plan");
    expect(r.result).toContain("已在 plan");
  });

  it("exit_plan_mode：非 plan 报错，mode 不变", async () => {
    const box = modeBox("default");
    const pt = makePlanTools({ getMode: box.get, setMode: box.set, canPrompt: true });
    const [, exit] = pt.tools as [Tool, Tool];
    const r = await exit.call({ plan: "重构 src/utils.ts" });
    expect(box.state.mode).toBe("default");
    expect(r.result).toContain("不在 plan");
  });

  it("exit_plan_mode 装配 denyMessage：用户拒绝计划时回填「停止等待」语义（0.5.1）", async () => {
    const box = modeBox("default");
    const pt = makePlanTools({ getMode: box.get, setMode: box.set, canPrompt: true });
    const [, exit] = pt.tools as [Tool, Tool];
    expect(exit.denyMessage).toContain("用户拒绝了你的计划");
    expect(exit.denyMessage).toContain("等待用户下一条指令");
    expect(exit.denyMessage).toContain("不要再次调用 enter_plan_mode 或 exit_plan_mode");
  });

  it("exit_plan_mode：plan 下写 plan 文件 + 恢复 prePlanMode + 回填计划全文", async () => {
    const plansDir = path.join(tempDir(), ".run-agent", "plans");
    const box = modeBox("acceptEdits");
    const now = new Date("2026-08-11T10:00:00.000Z");
    const pt = makePlanTools({
      getMode: box.get,
      setMode: box.set,
      canPrompt: true,
      plansDir,
      now: () => now,
    });
    const [enter, exit] = pt.tools as [Tool, Tool];
    await enter.call({});
    expect(box.state.mode).toBe("plan");

    const r = await exit.call({ plan: "重构 src/utils.ts" });
    expect(box.state.mode).toBe("acceptEdits"); // 恢复进入前的模式
    expect(r.result).toContain("已批准");
    expect(r.result).toContain("重构 src/utils.ts");
    expect(r.result).toContain("plan-2026-08-11T10-00-00-000Z.md");
    expect(readdirSync(plansDir)).toEqual(["plan-2026-08-11T10-00-00-000Z.md"]);
    expect(readFileSync(path.join(plansDir, "plan-2026-08-11T10-00-00-000Z.md"), "utf8")).toBe(
      "重构 src/utils.ts",
    );
  });

  it("exit_plan_mode：缺 plan 入参 → zod 校验抛错", async () => {
    const box = modeBox("plan");
    const pt = makePlanTools({ getMode: box.get, setMode: box.set, canPrompt: true });
    const [, exit] = pt.tools as [Tool, Tool];
    await expect(exit.call({})).rejects.toThrow();
  });

  it("/plan 手动入口：记录 prePlanMode 并进入；已在 plan 返回 false", async () => {
    const plansDir = path.join(tempDir(), ".run-agent", "plans");
    const box = modeBox("default");
    const pt = makePlanTools({
      getMode: box.get,
      setMode: box.set,
      canPrompt: true,
      plansDir,
    });
    expect(pt.enterPlanManually()).toBe(true);
    expect(box.state.mode).toBe("plan");

    // 与 enter_plan_mode 共用同一状态机：exit 恢复到进入前的 default
    const [, exit] = pt.tools as [Tool, Tool];
    await exit.call({ plan: "计划" });
    expect(box.state.mode).toBe("default");

    // 已在 plan 再敲 /plan → false
    expect(pt.enterPlanManually()).toBe(true);
    expect(box.state.mode).toBe("plan");
    expect(pt.enterPlanManually()).toBe(false);
  });
});

describe("buildTools 装配边界（V5 决策 A4）", () => {
  it("one-shot 不传 planMode → 无 plan 导航工具", () => {
    const tools = buildTools({ cwd: tempDir(), isTrusted: false });
    expect(tools.some((t) => t.name === "enter_plan_mode")).toBe(false);
    expect(tools.some((t) => t.name === "exit_plan_mode")).toBe(false);
  });

  it("传 planMode → plan 导航工具追加在后", () => {
    const box = modeBox("default");
    const pt = makePlanTools({ getMode: box.get, setMode: box.set, canPrompt: true });
    const tools = buildTools({ cwd: tempDir(), isTrusted: false, planMode: pt });
    expect(tools.some((t) => t.name === "enter_plan_mode")).toBe(true);
    expect(tools.some((t) => t.name === "exit_plan_mode")).toBe(true);
    // 追加在后（内置工具永远在前）
    expect(tools[tools.length - 1]!.name).toBe("exit_plan_mode");
    expect(tools[tools.length - 2]!.name).toBe("enter_plan_mode");
  });
});

describe("buildTools 装配边界（V5 决策 B3）", () => {
  it("不传 mcpConnect → 无 mcp_connect 工具", () => {
    const tools = buildTools({ cwd: tempDir(), isTrusted: false });
    expect(tools.some((t) => t.name === "mcp_connect")).toBe(false);
  });

  it("传 mcpConnect → mcp_connect 追加在 plan 导航之后（内置永远在前）", () => {
    const box = modeBox("default");
    const pt = makePlanTools({ getMode: box.get, setMode: box.set, canPrompt: true });
    const fake: Tool = {
      name: "mcp_connect",
      description: "fake",
      inputSchema: z.object({ server: z.string() }),
      async call() {
        return { result: "ok" };
      },
    };
    const tools = buildTools({ cwd: tempDir(), isTrusted: false, planMode: pt, mcpConnect: fake });
    expect(tools[tools.length - 1]!.name).toBe("mcp_connect");
    expect(tools[tools.length - 2]!.name).toBe("exit_plan_mode");
  });
});

describe("REPL 全流程集成（两条进入路径 → 禁写 → 审批 → 恢复）", () => {
  it("用户 /plan 进入 → 写 deny / 只读 allow → exit(ask y) → 恢复 default 写需确认", async () => {
    const cwd = tempDir();
    const plansDir = path.join(cwd, ".run-agent", "plans");
    const aTs = path.join(cwd, "a.ts"); // 绝对路径：pathInCwd 不受 process.cwd() 影响
    const ctx: PermissionContext = {
      mode: "default",
      rules: [],
      canPrompt: true,
      isTrusted: false,
      cwd,
    };
    const pt = makePlanTools({
      getMode: () => ctx.mode,
      setMode: (m) => {
        ctx.mode = m;
      },
      canPrompt: true,
      plansDir,
    });
    const [, exit] = pt.tools as [Tool, Tool];
    let answer = "y";
    const ask = async () => answer;
    const checkPermission = makeCheckPermission(ctx, silentOut, ask);

    // /plan 手动进入（不经模型判断）
    expect(pt.enterPlanManually()).toBe(true);
    expect(ctx.mode).toBe("plan");

    // plan 下：写 deny、只读 allow
    expect(await checkPermission(fakeWrite, { file_path: aTs })).toBe("deny");
    expect(await checkPermission(fakeRead, { file_path: aTs })).toBe("allow");

    // exit 审批：engine 返回 ask → 弹窗 "y" → allow；批准后 call 落盘 + 恢复
    expect(await checkPermission(exit, { plan: "计划" })).toBe("allow");
    await exit.call({ plan: "计划" });
    expect(ctx.mode).toBe("default");
    expect(readdirSync(plansDir).length).toBe(1);

    // 恢复 default 后：写不再是 plan 的强制 deny → engine 判 ask（非 acceptEdits 免确认）
    expect(
      hasPermissionsToUseTool("write_file", { file_path: aTs }, "default", [], false, cwd),
    ).toBe("ask");
    // 且走弹窗确认：say n → deny（证明恢复后写需要用户授权）
    answer = "n";
    expect(await checkPermission(fakeWrite, { file_path: aTs })).toBe("deny");
  });

  it("exit 审批拒绝（n）→ allow 不通过、plan 文件不落盘、mode 不变", async () => {
    const cwd = tempDir();
    const plansDir = path.join(cwd, ".run-agent", "plans");
    const ctx: PermissionContext = {
      mode: "default",
      rules: [],
      canPrompt: true,
      isTrusted: false,
      cwd,
    };
    const pt = makePlanTools({
      getMode: () => ctx.mode,
      setMode: (m) => {
        ctx.mode = m;
      },
      canPrompt: true,
      plansDir,
    });
    const [, exit] = pt.tools as [Tool, Tool];
    const ask = async () => "n";
    const checkPermission = makeCheckPermission(ctx, silentOut, ask);

    pt.enterPlanManually();
    expect(ctx.mode).toBe("plan");

    expect(await checkPermission(exit, { plan: "计划" })).toBe("deny");
    expect(ctx.mode).toBe("plan"); // 拒绝 → 模型留在 plan 模式继续探索
    expect(() => readdirSync(plansDir)).toThrow(); // 无 plan 文件
  });

  it("模型 enter_plan_mode 路径：写 deny → exit 审批 → 恢复", async () => {
    const cwd = tempDir();
    const plansDir = path.join(cwd, ".run-agent", "plans");
    const aTs = path.join(cwd, "a.ts");
    const ctx: PermissionContext = {
      mode: "default",
      rules: [],
      canPrompt: true,
      isTrusted: false,
      cwd,
    };
    const pt = makePlanTools({
      getMode: () => ctx.mode,
      setMode: (m) => {
        ctx.mode = m;
      },
      canPrompt: true,
      plansDir,
    });
    const [enter, exit] = pt.tools as [Tool, Tool];
    const ask = async () => "y";
    const checkPermission = makeCheckPermission(ctx, silentOut, ask);

    // 模型路径：enter_plan_mode 工具（需先放行它本身）
    expect(await checkPermission(enter, {})).toBe("allow");
    await enter.call({});
    expect(ctx.mode).toBe("plan");

    expect(await checkPermission(fakeWrite, { file_path: aTs })).toBe("deny");
    expect(await checkPermission(exit, { plan: "计划" })).toBe("allow");
    await exit.call({ plan: "计划" });
    expect(ctx.mode).toBe("default");
  });

  it("one-shot（canPrompt=false）不装配 plan 工具：model 无入口，不会死锁", () => {
    // 与 buildTools 无 planMode 同一语义：这里验证 plan 工具列表为空
    const tools = buildTools({ cwd: tempDir(), isTrusted: false });
    expect(tools.find((t) => t.name === "exit_plan_mode")).toBeUndefined();
  });
});
