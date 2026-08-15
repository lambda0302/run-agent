/**
 * 权限弹确认的回归锁定：
 * 1. resolveAsk 复用调用方注入的 ask（同一 readline）→ 杜绝"双 y / 三 y 回显"bug；
 * 2. 回显造成的连续 y（yy / yyy）仍判 allow；
 * 3. makeCheckPermission 在 ask 时走注入 ask，拒绝时输出原因。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { makeCheckPermission } from "../../src/cli/repl.js";
import { resolveAsk } from "../../src/permissions/prompt.js";
import { loadRules } from "../../src/permissions/store.js";
import type { PermissionContext } from "../../src/permissions/types.js";
import { TOOLS } from "../../src/tools.js";
import type { Tool } from "../../src/tools.js";

const runBash = TOOLS.find((t) => t.name === "run_bash") as Tool;
const readFile = TOOLS.find((t) => t.name === "read_file") as Tool;

function ctx(over: Partial<PermissionContext> = {}): PermissionContext {
  return {
    mode: "default",
    rules: [],
    canPrompt: true,
    isTrusted: false,
    cwd: process.cwd(),
    ...over,
  };
}

const dirs: string[] = [];
function tmpHome(): string {
  const d = mkdtempSync(path.join(tmpdir(), "run-agent-prompt-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("resolveAsk（注入 ask 复用同一 readline，杜绝双回显）", () => {
  it("y → allow，且只问一次", async () => {
    const asks: string[] = [];
    const r = await resolveAsk(runBash, { command: "echo hi" }, ctx(), async (q) => {
      asks.push(q);
      return "y";
    });
    expect(r).toBe("allow");
    expect(asks).toHaveLength(1);
  });

  it("回显导致的连续 y（yy / yyy）→ 仍 allow（回归锁定）", async () => {
    for (const a of ["yy", "yyy", "yyyy"]) {
      const r = await resolveAsk(runBash, { command: "echo hi" }, ctx(), async () => a);
      expect(r, a).toBe("allow");
    }
  });

  it("n → deny", async () => {
    const r = await resolveAsk(runBash, { command: "echo hi" }, ctx(), async () => "n");
    expect(r).toBe("deny");
  });

  it("其它输入 → deny", async () => {
    const r = await resolveAsk(runBash, { command: "echo hi" }, ctx(), async () => "x");
    expect(r).toBe("deny");
  });

  it("a → allow 且写入规则（沙箱 home）", async () => {
    const home = tmpHome();
    const prevU = process.env.USERPROFILE;
    const prevH = process.env.HOME;
    process.env.USERPROFILE = home;
    process.env.HOME = home;
    try {
      const r = await resolveAsk(runBash, { command: "echo hi" }, ctx(), async () => "a");
      expect(r).toBe("allow");
      expect(loadRules()).toContainEqual({ tool: "run_bash", action: "allow" });
    } finally {
      if (prevU === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevU;
      if (prevH === undefined) delete process.env.HOME;
      else process.env.HOME = prevH;
    }
  });

  it("canPrompt=false → 直接 deny，不调用 ask（无 TTY 不挂起）", async () => {
    let called = false;
    const r = await resolveAsk(
      runBash,
      { command: "echo hi" },
      ctx({ canPrompt: false }),
      async () => {
        called = true;
        return "y";
      },
    );
    expect(r).toBe("deny");
    expect(called).toBe(false);
  });

  it("带 source（子 agent 来源）→ 弹窗文本前缀 [子 agent: <类型>]", async () => {
    const asks: string[] = [];
    const r = await resolveAsk(
      runBash,
      { command: "echo hi" },
      ctx(),
      async (q) => {
        asks.push(q);
        return "y";
      },
      "子 agent: general-purpose",
    );
    expect(r).toBe("allow");
    expect(asks[0]).toContain("[子 agent: general-purpose] 允许 run_bash");
  });

  it("无 source（主循环）→ 弹窗文本不带来源前缀", async () => {
    const asks: string[] = [];
    await resolveAsk(runBash, { command: "echo hi" }, ctx(), async (q) => {
      asks.push(q);
      return "y";
    });
    expect(asks[0]).toMatch(/^\n允许 run_bash /);
    expect(asks[0]).not.toContain("[子 agent:");
  });
});

describe("makeCheckPermission（REPL 内组装：engine + 注入 ask）", () => {
  it("engine 判 allow → 不询问，直接放行（cwd 内只读工具）", async () => {
    let called = false;
    const out = { write: () => {} } as unknown as NodeJS.WritableStream;
    const cp = makeCheckPermission(ctx(), out, async () => {
      called = true;
      return "y";
    });
    expect(await cp(readFile, { file_path: "a.ts" })).toBe("allow");
    expect(called).toBe(false);
  });

  it("只读工具读 cwd 外 → 不再直接放行，走 ask 确认（V4.5 决策 B 缺口 ④ 修复）", async () => {
    const asks: string[] = [];
    const out = { write: () => {} } as unknown as NodeJS.WritableStream;
    const cp = makeCheckPermission(ctx(), out, async (q) => {
      asks.push(q);
      return "n";
    });
    expect(await cp(readFile, { file_path: "../outside-secret.txt" })).toBe("deny");
    expect(asks).toHaveLength(1);
    expect(asks[0]).toContain("工作目录之外");
  });

  it("ask 命中时走注入的 ask；y → allow", async () => {
    const out = { write: () => {} } as unknown as NodeJS.WritableStream;
    const cp = makeCheckPermission(ctx(), out, async () => "y");
    // 非 R0 命令（local-exec）才走 ask 弹窗
    expect(await cp(runBash, { command: "node --version" })).toBe("allow");
  });

  it("ask 被拒 → deny 且输出拒绝原因", async () => {
    const written: string[] = [];
    const out = { write: (s: string) => written.push(s) } as unknown as NodeJS.WritableStream;
    const cp = makeCheckPermission(ctx(), out, async () => "n");
    expect(await cp(runBash, { command: "node --version" })).toBe("deny");
    expect(written.join("")).toContain("已拒绝执行 run_bash");
  });

  it("危险命令（rm -rf /）→ deny，即使 ask 也被跳过（bypass 删除后无任何模式放行）", async () => {
    let called = false;
    const out = { write: () => {} } as unknown as NodeJS.WritableStream;
    const cp = makeCheckPermission(ctx(), out, async () => {
      called = true;
      return "y";
    });
    expect(await cp(runBash, { command: "rm -rf /" })).toBe("deny");
    expect(called).toBe(false);
  });

  it("exit_plan_mode 拒绝 → 输出「用户拒绝了计划」而非 plan 只读提示（V8 决策 I）", async () => {
    const written: string[] = [];
    const out = { write: (s: string) => written.push(s) } as unknown as NodeJS.WritableStream;
    const exitPlan: Tool = {
      name: "exit_plan_mode",
      description: "exit",
      inputSchema: z.object({ plan: z.string().optional() }),
      call: async () => ({ result: "" }),
    };
    const cp = makeCheckPermission(
      ctx({ mode: "plan", planFilePath: path.join(tmpHome(), "plan.md") }),
      out,
      async () => "n",
    );
    expect(await cp(exitPlan, { plan: "计划" })).toBe("deny");
    expect(written.join("")).toContain("已拒绝执行 exit_plan_mode");
    expect(written.join("")).toContain("用户拒绝了计划");
  });
});

describe("resolveAsk（V8 决策 I：exit_plan_mode 编辑后批准）", () => {
  const exitPlan: Tool = {
    name: "exit_plan_mode",
    description: "exit",
    inputSchema: z.object({ plan: z.string().optional() }),
    call: async () => ({ result: "" }),
  };

  it("exit_plan_mode 弹窗传 EXIT_OPTIONS（四选项含「编辑后批准」）", async () => {
    let opts: unknown;
    const r = await resolveAsk(
      exitPlan,
      { plan: "计划" },
      ctx({ mode: "plan", planFilePath: path.join(tmpHome(), "plan.md") }),
      async (_q, options) => {
        opts = options;
        return "y";
      },
    );
    expect(r).toBe("allow");
    expect((opts as Array<{ label: string }>).map((o) => o.label)).toEqual([
      "批准计划",
      "编辑后批准",
      "拒绝",
      "批准并始终记住（写入规则）",
    ]);
  });

  it("普通工具弹窗仍传 ANSWER_OPTIONS（三选项，无编辑项）", async () => {
    let opts: unknown;
    await resolveAsk(runBash, { command: "echo hi" }, ctx(), async (_q, options) => {
      opts = options;
      return "y";
    });
    expect((opts as Array<{ label: string }>).map((o) => o.label)).toEqual([
      "允许（本次执行）",
      "允许并始终记住（写入规则）",
      "拒绝",
    ]);
  });

  it("「编辑后批准」：编辑器返回新内容 → allow + updatedInput {plan, planWasEdited:true}", async () => {
    const planFile = path.join(tmpHome(), "plan.md");
    mkdirSync(path.dirname(planFile), { recursive: true });
    writeFileSync(planFile, "原始计划", "utf8");
    const r = await resolveAsk(
      exitPlan,
      { plan: "原始计划" },
      ctx({ mode: "plan", planFilePath: planFile }),
      async () => "e",
      undefined,
      async () => "修改后的计划",
    );
    expect(r).toEqual({ decision: "allow", updatedInput: { plan: "修改后的计划", planWasEdited: true } });
  });

  it("「编辑后批准」：编辑器内容无变化 → allow + updatedInput {plan}（planWasEdited 不置位）", async () => {
    const planFile = path.join(tmpHome(), "plan.md");
    mkdirSync(path.dirname(planFile), { recursive: true });
    writeFileSync(planFile, "原样计划", "utf8");
    const r = await resolveAsk(
      exitPlan,
      { plan: "原样计划" },
      ctx({ mode: "plan", planFilePath: planFile }),
      async () => "e",
      undefined,
      async () => "原样计划",
    );
    expect(r).toEqual({ decision: "allow", updatedInput: { plan: "原样计划" } });
  });

  it("「编辑后批准」：无 openEditor 注入 → deny（headless/测试保守拒绝）", async () => {
    const r = await resolveAsk(
      exitPlan,
      { plan: "计划" },
      ctx({ mode: "plan", planFilePath: path.join(tmpHome(), "plan.md") }),
      async () => "e",
    );
    expect(r).toBe("deny");
  });

  it("「编辑后批准」：编辑器取消/失败（返回 undefined）→ deny", async () => {
    const planFile = path.join(tmpHome(), "plan.md");
    mkdirSync(path.dirname(planFile), { recursive: true });
    writeFileSync(planFile, "计划", "utf8");
    const r = await resolveAsk(
      exitPlan,
      { plan: "计划" },
      ctx({ mode: "plan", planFilePath: planFile }),
      async () => "e",
      undefined,
      async () => undefined,
    );
    expect(r).toBe("deny");
  });

  it("「编辑后批准」：计划文件不存在且无 plan 入参 → deny（无内容可编辑）", async () => {
    const r = await resolveAsk(
      exitPlan,
      {},
      ctx({ mode: "plan", planFilePath: path.join(tmpHome(), "missing", "plan.md") }),
      async () => "e",
      undefined,
      async () => "内容",
    );
    expect(r).toBe("deny");
  });

  it("「编辑后批准」：计划文件不存在但有 plan 入参 → 先落盘给编辑器打开，改后 allow", async () => {
    const planFile = path.join(tmpHome(), "sub", "plan.md");
    const r = await resolveAsk(
      exitPlan,
      { plan: "初始计划" },
      ctx({ mode: "plan", planFilePath: planFile }),
      async () => "e",
      undefined,
      async (p) => {
        expect(readFileSync(p, "utf8")).toBe("初始计划"); // 已落盘，编辑器有内容可改
        return "编辑后计划";
      },
    );
    expect(r).toEqual({ decision: "allow", updatedInput: { plan: "编辑后计划", planWasEdited: true } });
  });

  it("exit_plan_mode 拒绝（n）→ deny（用户拒绝计划）", async () => {
    const r = await resolveAsk(
      exitPlan,
      { plan: "计划" },
      ctx({ mode: "plan", planFilePath: path.join(tmpHome(), "plan.md") }),
      async () => "n",
    );
    expect(r).toBe("deny");
  });
});
