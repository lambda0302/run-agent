/**
 * M4 headless 集成测试：--print + --json 契约（决策 D1–D4）。
 * 本文件测试打包产物（dist/cli.js），因此 test 脚本里必须先 build。
 * 全部走本地 mock LLM（tests/cli/mockLLM.ts），hermetic、无真实网络/API key。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import pkg from "../../package.json";
import {
  hasToolResult,
  startMockLLM,
  textChunks,
  toolCallChunks,
  type OpenAIChatBody,
} from "./mockLLM.js";

const run = promisify(execFile);
const distCli = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "cli.js");

const cleanup: Array<() => void> = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "run-agent-headless-"));
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

/** 跑一次 CLI：沙箱 HOME（防读到真实 config/sessions）+ 可选 cwd/env。 */
function runCli(
  args: string[],
  opts: { cwd?: string; homeDir?: string; env?: Record<string, string> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const home = opts.homeDir ?? tempDir();
  return run(process.execPath, [distCli, ...args], {
    cwd: opts.cwd,
    env: { ...process.env, USERPROFILE: home, HOME: home, ...opts.env },
  })
    .then((res) => ({ code: 0, stdout: res.stdout, stderr: res.stderr }))
    .catch((e: { code?: number; stdout?: string; stderr?: string }) => ({
      code: e.code ?? 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    }));
}

/** 组装「先调一次工具、第二轮出终答」的两轮 mock。 */
function twoTurnMock(toolName: string, args: string, finalText = "final-answer") {
  return startMockLLM((body: OpenAIChatBody) =>
    hasToolResult(body)
      ? textChunks(finalText)
      : toolCallChunks({ id: "call_1", name: toolName, args }),
  );
}

describe("M4 headless（--print + --json 契约）", () => {
  it("JSON 契约字段完整 + stdout 纯净 + 只读工具轨迹（permission=allow）", async () => {
    const dir = tempDir();
    const file = join(dir, "a.txt");
    writeFileSync(file, "hello headless\n", "utf8");
    const mock = await twoTurnMock(
      "read_file",
      JSON.stringify({ file_path: file }),
      "final-answer",
    );
    cleanup.push(() => mock.close());

    const res = await runCli(
      [
        "--provider",
        "openai-compatible",
        "--base-url",
        mock.url,
        "--api-key",
        "test-key",
        "--print",
        "read it",
        "--json",
      ],
      { cwd: dir },
    );

    expect(res.code).toBe(0);
    const json = JSON.parse(res.stdout); // 抛错即 stdout 非纯净 JSON
    expect(json.version).toBe(pkg.version);
    expect(json.provider).toBe("openai-compatible");
    expect(json.model).toBe("gpt-4o-mini"); // 未显式指定 → 适配器默认
    expect(json.session).toMatch(/\.jsonl$/);
    expect(json.reply).toBe("final-answer");
    expect(json.messages).toBe(4); // user + assistant(tool_use) + tool + assistant(text)
    expect(json.turns).toBe(2);
    expect(json.tools).toHaveLength(1);
    expect(json.tools[0]).toMatchObject({
      name: "read_file",
      input: { file_path: file },
      permission: "allow",
    });
    expect(json.tools[0].result).toContain("hello headless");
    expect(json.errors).toEqual([]);
    // stdout 纯净：不含任何人类日志（会话路径、提示等全去 stderr）
    expect(res.stdout).not.toContain("✓");
    expect(res.stdout).not.toContain("会话");
    expect(res.stderr).toContain("会话");
  });

  it("SkillTool：default 模式权限=allow（V6 修复）且惰性加载技能 body", async () => {
    // 用户级技能（无需 Trust）落在沙箱 HOME 下
    const home = tempDir();
    const skillDir = join(home, ".config", "run-agent", "skills", "demo");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: demo\ndescription: 演示技能\n---\n技能正文ABC",
      "utf8",
    );
    const mock = await twoTurnMock("SkillTool", JSON.stringify({ name: "demo" }), "技能执行完毕");
    cleanup.push(() => mock.close());

    const res = await runCli(
      [
        "--provider",
        "openai-compatible",
        "--base-url",
        mock.url,
        "--api-key",
        "test-key",
        "--print",
        "加载技能并执行",
        "--json",
      ],
      { homeDir: home },
    );

    expect(res.code).toBe(0);
    const json = JSON.parse(res.stdout);
    expect(json.reply).toBe("技能执行完毕");
    expect(json.tools).toHaveLength(1);
    // 修复前：SkillTool 不在 READ_ONLY_TOOLS → default 模式 ask → headless 降级 deny，body 加载全废
    expect(json.tools[0]).toMatchObject({ name: "SkillTool", permission: "allow" });
    expect(json.tools[0].result).toContain("技能正文ABC");
    expect(json.errors).toEqual([]);
  });

  it("写工具：default 模式降级 deny；--mode acceptEdits 免弹窗 allow", async () => {
    const dir = tempDir();
    const target = join(dir, "new.txt");
    const mock = await twoTurnMock(
      "write_file",
      JSON.stringify({ file_path: target, content: "hi" }),
      "done",
    );
    cleanup.push(() => mock.close());

    // default 模式：one-shot 无交互 → ask 降级 deny
    const denied = await runCli(
      [
        "--provider",
        "openai-compatible",
        "--base-url",
        mock.url,
        "--api-key",
        "test-key",
        "--print",
        "write it",
        "--json",
      ],
      { cwd: dir },
    );
    expect(denied.code).toBe(0);
    const d = JSON.parse(denied.stdout);
    expect(d.tools[0]).toMatchObject({ name: "write_file", permission: "deny" });
    expect(d.tools[0].result).toContain("未授权");
    expect(existsSync(target)).toBe(false);

    // acceptEdits：写免确认 → allow 并真实落盘
    const allowed = await runCli(
      [
        "--provider",
        "openai-compatible",
        "--base-url",
        mock.url,
        "--api-key",
        "test-key",
        "--print",
        "write it",
        "--json",
        "--mode",
        "acceptEdits",
      ],
      { cwd: dir },
    );
    expect(allowed.code).toBe(0);
    const a = JSON.parse(allowed.stdout);
    expect(a.tools[0]).toMatchObject({ name: "write_file", permission: "allow" });
    expect(existsSync(target)).toBe(true);
  });

  it("工具轨迹 result 截断到 2000 字符（TOOL_TRACE_RESULT_LIMIT）", async () => {
    const dir = tempDir();
    const file = join(dir, "big.txt");
    writeFileSync(file, "X".repeat(3000), "utf8");
    const mock = await twoTurnMock("read_file", JSON.stringify({ file_path: file }), "ok");
    cleanup.push(() => mock.close());

    const res = await runCli(
      [
        "--provider",
        "openai-compatible",
        "--base-url",
        mock.url,
        "--api-key",
        "test-key",
        "--print",
        "read big",
        "--json",
      ],
      { cwd: dir },
    );
    expect(res.code).toBe(0);
    const json = JSON.parse(res.stdout);
    const suffix = "…（已截断）";
    expect(json.tools[0].result.endsWith(suffix)).toBe(true);
    // 结果带 read_file 的 ——─ 头部 → 截断不是从 X 起；用「截断后总长 = 2000 + 后缀」+「尾部 X 内容被切」断言
    expect(json.tools[0].result.length).toBe(2000 + suffix.length);
    expect(json.tools[0].result.startsWith("——— ")).toBe(true);
    // 3000 个 X 被切成最多 2000 字符内容（头部占掉一部分），尾部必然丢失
    expect(json.tools[0].result.includes("X".repeat(500))).toBe(true);
    expect(json.tools[0].result.includes("X".repeat(2999))).toBe(false);
  });

  it("--max-turns 限制 ReAct 循环轮数（工具轨迹随轮数累积）", async () => {
    const dir = tempDir();
    const file = join(dir, "a.txt");
    writeFileSync(file, "x", "utf8");
    // 永远返回工具调用 → 循环跑满 max-turns，不会无限
    const mock = await startMockLLM(() =>
      toolCallChunks({
        id: "call_1",
        name: "read_file",
        args: JSON.stringify({ file_path: file }),
      }),
    );
    cleanup.push(() => mock.close());

    const res = await runCli(
      [
        "--provider",
        "openai-compatible",
        "--base-url",
        mock.url,
        "--api-key",
        "test-key",
        "--print",
        "loop",
        "--json",
        "--max-turns",
        "2",
      ],
      { cwd: dir },
    );
    expect(res.code).toBe(0);
    const json = JSON.parse(res.stdout);
    // 0.7.2 收尾轮：预算撞顶且模型仍在调工具 → 多跑一轮纯文本收尾（有界，只多一轮）。
    // 本例 mock 永远调工具 → 2 轮工具循环 + 1 轮收尾 = 3；收尾轮工具池已清空，
    // read_file 走「未知工具」回填并记入轨迹 → 3 条。
    expect(json.turns).toBe(3);
    expect(json.tools).toHaveLength(3);
    expect(json.tools[2]).toMatchObject({ result: "未知工具: read_file" });
  });

  it("无 API key → 退出码 1 且 stderr 提示（不输出 JSON）", async () => {
    const res = await runCli(["--provider", "anthropic", "--print", "hi", "--json"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("API key");
    expect(res.stdout).toBe("");
  });

  it("--print 与位置参数互斥 → 退出码 1", async () => {
    const res = await runCli(["--print", "a", "b"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("互斥");
  });

  it("--json 但无 prompt（交互模式）→ 退出码 1", async () => {
    // ollama 无需 key → 走到 json 无 prompt 的检查分支
    const res = await runCli(["--provider", "ollama", "--json"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("--json");
  });

  it("headless 下 hooks 触发（SessionStart 可观测）", async () => {
    const dir = tempDir();
    const home = tempDir();
    const cfgDir = join(home, ".config", "run-agent");
    mkdirSync(cfgDir, { recursive: true });
    const script = join(dir, "session-hook.js");
    const marker = join(dir, "hook-fired.txt");
    writeFileSync(script, "require('node:fs').writeFileSync(process.argv[2], 'yes')", "utf8");
    writeFileSync(
      join(cfgDir, "settings.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [{ type: "command", command: `${process.execPath} "${script}" "${marker}"` }],
            },
          ],
        },
      }),
      "utf8",
    );
    const mock = await startMockLLM(() => textChunks("hi"));
    cleanup.push(() => mock.close());

    const res = await runCli(
      [
        "--provider",
        "openai-compatible",
        "--base-url",
        mock.url,
        "--api-key",
        "test-key",
        "--print",
        "hi",
        "--json",
      ],
      { cwd: dir, env: { HOME: home, USERPROFILE: home } },
    );
    expect(res.code).toBe(0);
    expect(existsSync(marker)).toBe(true);
  });
});
