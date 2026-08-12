/**
 * V6 决策 B3：REPL 技能斜杠命令（注入 input 流驱动真实 dispatch，hermetic）。
 * 覆盖：/skills 列清单（不调模型）/ <技能名> 加载后执行（技能 body 作为 user 消息喂模型）
 * 内置命令优先（技能名与内置冲突时内置赢）。
 */
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LLMClient, LLMMessage, StreamEvent, StreamOptions } from "../src/providers/types.js";
import { runRepl } from "../src/cli/repl.js";
import { SkillRegistry } from "../src/services/skills/skill_tool.js";
import type { Skill } from "../src/services/skills/loader.js";

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

/** 落盘技能（`over.body` 作为文件正文：REPL /技能名 走 readSkillBody 从磁盘现读）。 */
function skill(over: Partial<Skill> & { body?: string } = {}): Skill {
  const { body = "技能指令A\n指令B", ...rest } = over;
  const dir = mkdtempSync(path.join(tmpdir(), "run-agent-skills-repl-"));
  dirs.push(dir);
  const name = rest.name ?? "demo";
  const description = rest.description ?? "演示技能";
  const md = path.join(dir, "SKILL.md");
  writeFileSync(md, `---\nname: ${name}\ndescription: ${description}\n---\n${body}`, "utf8");
  return { name, description, source: "project", path: md, ...rest };
}

/** 用注入 stdin 跑 REPL，收集输出；完成后 resolve。 */
async function runReplLines(opts: Parameters<typeof runRepl>[0], lines: string[]): Promise<string> {
  const input = new PassThrough();
  const chunks: Buffer[] = [];
  const out = new PassThrough();
  out.on("data", (c: Buffer) => chunks.push(c));
  const done = runRepl({ ...opts, input, out });
  const tick = () => new Promise((r) => setTimeout(r, 25));
  for (const l of lines) {
    input.write(l + "\n");
    await tick();
  }
  input.end();
  await done;
  return Buffer.concat(chunks).toString("utf8");
}

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "run-agent-skills-repl-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("REPL 技能斜杠命令（V6 决策 B3）", () => {
  it("/skills 列出技能（名 + 描述 + 来源），不调模型", async () => {
    const reg = new SkillRegistry([
      skill(),
      skill({ name: "review", description: "代码审查", source: "user" }),
    ]);
    const out = await runReplLines(
      {
        client: throwClient,
        tools: [],
        sessionFile: path.join(tempDir(), "s.jsonl"),
        skillRegistry: reg,
      },
      ["/skills", "/exit"],
    );
    expect(out).toContain("可用技能:");
    expect(out).toContain("/demo — 演示技能（项目级）");
    expect(out).toContain("/review — 代码审查（用户级）");
  });

  it("/skills 无技能时给出放置路径提示", async () => {
    const reg = new SkillRegistry([]);
    const out = await runReplLines(
      {
        client: throwClient,
        tools: [],
        sessionFile: path.join(tempDir(), "s.jsonl"),
        skillRegistry: reg,
      },
      ["/skills", "/exit"],
    );
    expect(out).toContain("无可用技能");
    expect(out).toContain(".run-agent/skills");
  });

  it("/<技能名> 加载技能 body 作为 user 消息执行（模型收到技能体）", async () => {
    const client = new FakeClient([
      [
        { type: "text", text: "按技能执行完毕" },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    const reg = new SkillRegistry([skill()]);
    const out = await runReplLines(
      { client, tools: [], sessionFile: path.join(tempDir(), "s.jsonl"), skillRegistry: reg },
      ["/demo", "/exit"],
    );
    expect(out).toContain("已加载技能 demo");
    // 喂给模型的首条 user 消息含技能 body
    const first = client.calls[0]?.[0];
    expect(typeof first?.content).toBe("string");
    expect(first?.content as string).toContain("技能指令A\n指令B");
    expect(out).toContain("按技能执行完毕");
  });

  it("内置命令优先：技能名为 clear 时 /clear 仍是清空上下文", async () => {
    const reg = new SkillRegistry([skill({ name: "clear", description: "想抢内置名" })]);
    const out = await runReplLines(
      {
        client: throwClient,
        tools: [],
        sessionFile: path.join(tempDir(), "s.jsonl"),
        skillRegistry: reg,
      },
      ["/clear", "/exit"],
    );
    expect(out).toContain("已清空上下文");
    expect(out).not.toContain("已加载技能 clear");
  });

  it("未知技能名不拦截，走内置未知命令提示", async () => {
    const reg = new SkillRegistry([skill()]);
    const out = await runReplLines(
      {
        client: throwClient,
        tools: [],
        sessionFile: path.join(tempDir(), "s.jsonl"),
        skillRegistry: reg,
      },
      ["/not-a-skill", "/exit"],
    );
    expect(out).toContain("未知命令");
  });
});
