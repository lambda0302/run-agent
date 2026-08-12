/**
 * 权限弹确认的回归锁定：
 * 1. resolveAsk 复用调用方注入的 ask（同一 readline）→ 杜绝"双 y / 三 y 回显"bug；
 * 2. 回显造成的连续 y（yy / yyy）仍判 allow；
 * 3. makeCheckPermission 在 ask 时走注入 ask，拒绝时输出原因。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
    expect(await cp(runBash, { command: "echo hi" })).toBe("allow");
  });

  it("ask 被拒 → deny 且输出拒绝原因", async () => {
    const written: string[] = [];
    const out = { write: (s: string) => written.push(s) } as unknown as NodeJS.WritableStream;
    const cp = makeCheckPermission(ctx(), out, async () => "n");
    expect(await cp(runBash, { command: "echo hi" })).toBe("deny");
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
});
