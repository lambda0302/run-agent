/**
 * V6 决策 A4：PreToolUse hook 决策矩阵（engine 判定 × hook 决策）回归锁定。
 * 铁律：engine deny 是硬底线，hook 只能 ask→allow / allow→deny / ask→deny，不能放行 deny。
 * 测试全部走注入 ask / 注入 preToolUse，不弹真实交互。
 */
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { makeCheckPermission } from "../../../src/cli/repl.js";
import type { PermissionContext } from "../../../src/permissions/types.js";
import { TOOLS } from "../../../src/tools.js";
import type { Tool } from "../../../src/tools.js";

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

/** 收集 makeCheckPermission 的 out 输出。 */
function sink(): { out: PassThrough; text: () => string } {
  const out = new PassThrough();
  let acc = "";
  out.on("data", (c: Buffer) => (acc += c.toString()));
  return { out, text: () => acc };
}

afterEach(() => {
  /* PassThrough 无需清理 */
});

/** 注入 hook 决策的 preToolUse 回调。 */
function hookOf(d: { permissionDecision?: "allow" | "deny"; permissionDecisionReason?: string }) {
  return async () => d;
}

describe("PreToolUse hook × engine 判定矩阵（V6 决策 A4）", () => {
  it("engine deny（危险命令）+ hook allow → 仍 deny（硬底线不可放行）", async () => {
    const { out, text } = sink();
    const check = makeCheckPermission(
      ctx(),
      out,
      async () => "y",
      undefined,
      hookOf({ permissionDecision: "allow" }),
    );
    const r = await check(runBash, { command: "rm -rf /" });
    expect(r).toBe("deny");
    expect(text()).not.toContain("hook");
  });

  it("engine allow + hook deny → deny，reason 回填进拒绝信息", async () => {
    const { out, text } = sink();
    const check = makeCheckPermission(
      ctx(),
      out,
      async () => "y",
      undefined,
      hookOf({ permissionDecision: "deny", permissionDecisionReason: "测试禁止写入" }),
    );
    const r = await check(readFile, { file_path: "a.ts" });
    expect(r).toMatchObject({ decision: "deny", reason: "hook 拒绝: 测试禁止写入" });
    expect(text()).toContain("hook: 测试禁止写入");
  });

  it("engine ask + hook allow → allow，且不弹确认（ask 不被调用）", async () => {
    const { out, text } = sink();
    let asked = 0;
    const check = makeCheckPermission(
      ctx(),
      out,
      async () => {
        asked += 1;
        return "n"; // 若被调用则 deny，可作反证
      },
      undefined,
      hookOf({ permissionDecision: "allow" }),
    );
    const r = await check(runBash, { command: "echo hi" }); // 默认 default/未 trust → ask
    expect(r).toBe("allow");
    expect(asked).toBe(0);
    expect(text()).toBe("");
  });

  it("engine ask + hook deny → deny（不弹确认），reason 可见", async () => {
    const { out, text } = sink();
    let asked = 0;
    const check = makeCheckPermission(
      ctx(),
      out,
      async () => {
        asked += 1;
        return "y";
      },
      undefined,
      hookOf({ permissionDecision: "deny", permissionDecisionReason: "策略禁止" }),
    );
    const r = await check(runBash, { command: "echo hi" });
    expect(r).toMatchObject({ decision: "deny", reason: "hook 拒绝: 策略禁止" });
    expect(asked).toBe(0);
    expect(text()).toContain("hook: 策略禁止");
  });

  it("hook 无决策 → 回落 engine：ask 时正常弹确认", async () => {
    const { out, text } = sink();
    const check = makeCheckPermission(ctx(), out, async () => "y");
    const r = await check(runBash, { command: "echo hi" });
    expect(r).toBe("allow");
    expect(text()).toBe(""); // 允许不写拒绝原因
  });

  it("hook deny 无 reason → 用默认文案", async () => {
    const { out } = sink();
    const check = makeCheckPermission(
      ctx(),
      out,
      async () => "y",
      undefined,
      hookOf({ permissionDecision: "deny" }),
    );
    const r = await check(readFile, { file_path: "a.ts" });
    expect(r).toMatchObject({ decision: "deny", reason: "hook 拒绝: PreToolUse hook 拒绝" });
  });
});
