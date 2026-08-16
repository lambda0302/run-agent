/**
 * V6 决策 C2：REPL 自定义命令（注入 input 流驱动真实 dispatch，hermetic）。
 * 覆盖：/commands 列清单（不调模型）/ <命令名> prompt 形态展开模板（含 @file）喂模型 /
 * local 形态跑脚本展示 stdout（不调模型）/ 内置命令优先（命令名 clear 不抢 /clear）/
 * /help 汇总自定义命令。
 */
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LLMClient, LLMMessage, StreamEvent, StreamOptions } from "../src/providers/types.js";
import { runRepl } from "../src/cli/repl.js";
import { CommandRegistry } from "../src/services/commands/loader.js";
import type { CustomCommand } from "../src/services/commands/loader.js";

class FakeClient implements LLMClient {
  provider = "fake";
  calls: LLMMessage[][] = [];
  constructor(private scripted: StreamEvent[][]) {}
  async *stream(messages: LLMMessage[], opts?: StreamOptions): AsyncIterable<StreamEvent> {
    void opts;
    this.calls.push(messages);
    const next = this.scripted.shift();
    for (const ev of next ?? [{ type: "done", stopReason: "end_turn" }]) yield ev;
  }
}

const throwClient: LLMClient = {
  provider: "fake",
  async *stream(): AsyncIterable<StreamEvent> {
    throw new Error("REPL 不应调模型");
  },
};

/** 一条输入行：可带 waitFor 标记——等到该子串出现在输出里才发下一条（跨真实进程，防丢输出）。 */
type Line = string | { input: string; waitFor: string };

/** 用注入 stdin 跑 REPL，收集输出；完成后 resolve。 */
async function runReplLines(opts: Parameters<typeof runRepl>[0], lines: Line[]): Promise<string> {
  const input = new PassThrough();
  const chunks: Buffer[] = [];
  const out = new PassThrough();
  out.on("data", (c: Buffer) => chunks.push(c));
  const done = runRepl({ ...opts, input, out });
  const output = () => Buffer.concat(chunks).toString("utf8");
  const tick = () => new Promise((r) => setTimeout(r, 25));
  for (const entry of lines) {
    const { input: text, waitFor } =
      typeof entry === "string"
        ? { input: entry, waitFor: undefined as string | undefined }
        : entry;
    input.write(text + "\n");
    if (waitFor) {
      // local 命令走 execFile 是真实进程，固定 tick 在负载下会漏；等到目标子串出现（≤8s）
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && !output().includes(waitFor)) await tick();
    } else {
      await tick();
    }
  }
  input.end();
  await done;
  return output();
}

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "run-agent-cmds-repl-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function cmd(over: Partial<CustomCommand>): CustomCommand {
  return {
    type: "prompt",
    name: "demo",
    source: "project",
    template: "模板",
    ...over,
  } as CustomCommand;
}

describe("REPL 自定义命令（V6 决策 C2）", () => {
  it("/commands 列清单（名 + 形态 + 来源），不调模型", async () => {
    const reg = new CommandRegistry([
      cmd({ name: "summ", type: "prompt", template: "总结", source: "user" }),
      cmd({ name: "ship", type: "local", ext: "js", file: "x.js", source: "project" }),
    ]);
    const out = await runReplLines(
      {
        client: throwClient,
        tools: [],
        sessionFile: path.join(tempDir(), "s.jsonl"),
        commands: reg,
      },
      ["/commands", "/exit"],
    );
    expect(out).toContain("自定义命令:");
    expect(out).toContain("/summ — prompt 模板（用户级）");
    expect(out).toContain("/ship — js 脚本（项目级）");
  });

  it("/commands 无命令时给出放置路径提示", async () => {
    const reg = new CommandRegistry([]);
    const out = await runReplLines(
      {
        client: throwClient,
        tools: [],
        sessionFile: path.join(tempDir(), "s.jsonl"),
        commands: reg,
      },
      ["/commands", "/exit"],
    );
    expect(out).toContain("无自定义命令");
    expect(out).toContain(".run-agent/commands");
  });

  it("/<prompt 命令> 展开模板（含 @file 内联 + 参数追加）作为 user 消息喂模型", async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "data.txt"), "文件内容XYZ", "utf8");
    const reg = new CommandRegistry([
      cmd({ name: "summ", type: "prompt", template: "按文件处理: @data.txt" }),
    ]);
    const client = new FakeClient([
      [
        { type: "text", text: "已处理" },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    const out = await runReplLines(
      {
        client,
        tools: [],
        sessionFile: path.join(dir, "s.jsonl"),
        commands: reg,
        systemCtx: { cwd: dir, isTrusted: true, bare: false },
      },
      [{ input: "/summ 补充说明", waitFor: "已处理" }, "/exit"],
    );
    expect(out).toContain("已加载命令 summ");
    // 模板展开的 user 消息：动态上下文是独立 user 消息（带 DYNAMIC_CONTEXT_MARKER），不与模板混合
    const users = (client.calls[0] ?? []).filter(
      (m): m is { role: "user"; content: string } => m.role === "user" && typeof m.content === "string",
    );
    const expanded = users.find((m) => m.content.includes("文件内容XYZ"));
    expect(expanded).toBeDefined();
    expect(expanded?.content).toContain("补充说明");
    expect(out).toContain("已处理");
  });

  it("/<local 命令> 跑脚本展示 stdout，不调模型", async () => {
    const dir = tempDir();
    const script = path.join(dir, "echo.js");
    writeFileSync(script, "console.log('echo:' + process.argv.slice(2).join(','))", "utf8");
    const reg = new CommandRegistry([
      cmd({ type: "local", name: "echo", ext: "js", file: script, source: "project" }),
    ]);
    const out = await runReplLines(
      { client: throwClient, tools: [], sessionFile: path.join(dir, "s.jsonl"), commands: reg },
      [{ input: "/echo a b", waitFor: "echo:a,b" }, "/exit"],
    );
    expect(out).toContain("正在执行命令 echo");
    expect(out).toContain("echo:a,b");
  });

  it("/<local 命令> 失败（非 0 退出码）→ 展示输出 + 失败提示", async () => {
    const dir = tempDir();
    const script = path.join(dir, "fail.js");
    writeFileSync(script, "process.stderr.write('boom'); process.exit(2)", "utf8");
    const reg = new CommandRegistry([
      cmd({ type: "local", name: "f", ext: "js", file: script, source: "project" }),
    ]);
    const out = await runReplLines(
      { client: throwClient, tools: [], sessionFile: path.join(dir, "s.jsonl"), commands: reg },
      [{ input: "/f", waitFor: "✗ 命令 f 失败（退出码 2）" }, "/exit"],
    );
    expect(out).toContain("boom");
    expect(out).toContain("✗ 命令 f 失败（退出码 2）");
  });

  it("内置命令优先：命令名为 clear 时 /clear 仍是清空上下文", async () => {
    const reg = new CommandRegistry([cmd({ name: "clear", type: "prompt", template: "抢内置名" })]);
    const out = await runReplLines(
      {
        client: throwClient,
        tools: [],
        sessionFile: path.join(tempDir(), "s.jsonl"),
        commands: reg,
      },
      ["/clear", "/exit"],
    );
    expect(out).toContain("已清空上下文");
    expect(out).not.toContain("已加载命令 clear");
  });

  it("未知命令名不拦截，走内置未知命令提示", async () => {
    const reg = new CommandRegistry([cmd({ name: "demo" })]);
    const out = await runReplLines(
      {
        client: throwClient,
        tools: [],
        sessionFile: path.join(tempDir(), "s.jsonl"),
        commands: reg,
      },
      ["/not-a-cmd", "/exit"],
    );
    expect(out).toContain("未知命令");
  });

  it("/help 汇总内置 + 自定义命令", async () => {
    const reg = new CommandRegistry([
      cmd({ name: "summ", type: "prompt", template: "总结", source: "user" }),
    ]);
    const out = await runReplLines(
      {
        client: throwClient,
        tools: [],
        sessionFile: path.join(tempDir(), "s.jsonl"),
        commands: reg,
      },
      ["/help", "/exit"],
    );
    expect(out).toContain("自定义命令:");
    expect(out).toContain("/summ — prompt 模板");
  });
});
