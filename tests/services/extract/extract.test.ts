import { describe, expect, it } from "vitest";
import { z } from "zod";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { decisionOf } from "../../../src/core/execute.js";
import type { LLMClient, LLMMessage, StreamEvent } from "../../../src/providers/types.js";
import type { Tool } from "../../../src/tools.js";
import { readTool } from "../../../src/tools/read.js";
import { globTool } from "../../../src/tools/glob.js";
import { grepTool } from "../../../src/tools/grep.js";
import { makeRememberTool } from "../../../src/tools/remember.js";
import { memoryDirPath } from "../../../src/core/memory.js";
import {
  EXTRACT_MEMORY_SYSTEM,
  EXTRACT_MEMORY_TOOLS,
  extractMemoriesDef,
  makeExtractMemCheckPermission,
} from "../../../src/services/agents/builtin/extractMemories.js";
import {
  ExtractMemoriesEngine,
  MAX_EXTRACT_BYTES,
  buildExtractPrompt,
} from "../../../src/services/extract/extract.js";

/** mock LLM:记录每次 stream 的消息数组;脚本化事件流或抛错(非 transient 不重试,见 query.ts)。 */
class FakeClient implements LLMClient {
  provider = "fake";
  calls: LLMMessage[][] = [];

  constructor(private scripted: (StreamEvent[] | Error)[]) {}

  async *stream(messages: LLMMessage[]): AsyncIterable<StreamEvent> {
    this.calls.push(messages);
    const next = this.scripted.shift();
    if (next instanceof Error) throw next;
    for (const ev of next ?? [{ type: "done", stopReason: "end_turn" }]) yield ev;
  }
}

const userMsg = (c: string): LLMMessage => ({ role: "user", content: c });
const asstMsg = (c: string): LLMMessage => ({ role: "assistant", content: c });
/** 第 2 条 assistant 消息含 remember tool_use（主 agent 已直接写记忆的互斥信号）。 */
const asstRemember = (c: string): LLMMessage => ({
  role: "assistant",
  content: [
    { type: "text", text: c },
    { type: "tool_use", id: "tu-r", name: "remember", input: { content: "已写" } },
  ],
});

const endTurn = [{ type: "done", stopReason: "end_turn" }] as StreamEvent[];

/** 子 agent 请求的用户消息（首个调用 = system，第二个 = 提取 prompt）。 */
const promptOf = (messages: LLMMessage[]): string =>
  messages.find((m) => m.role === "user")?.content as string;

describe("extractMemories 类型（决策 E2）", () => {
  it("工具集 = 只读三件套 + remember；maxIterations=5；system 含不存什么与先读索引", () => {
    expect(new Set(extractMemoriesDef.resolveTools(() => [
      readTool, globTool, grepTool, makeRememberTool({}), { name: "write_file" } as Tool,
    ]).map((t) => t.name))).toEqual(EXTRACT_MEMORY_TOOLS);
    expect(extractMemoriesDef.maxIterations).toBe(5);
    expect(EXTRACT_MEMORY_SYSTEM).toContain("不存:");
    expect(EXTRACT_MEMORY_SYSTEM).toContain("先读现有记忆再写");
    expect(EXTRACT_MEMORY_SYSTEM).toContain("frontmatter 四类");
  });

  it("权限策略：remember allow(Trust) / deny(未 Trust)；只读放行；其余 deny（永不 ask）", async () => {
    const tool = (name: string): Tool => ({
      name,
      description: name,
      inputSchema: z.object({}),
      async call() {
        return { result: "" };
      },
    });
    const trusted = makeExtractMemCheckPermission(true);
    const untrusted = makeExtractMemCheckPermission(false);
    expect(decisionOf(await trusted(tool("remember"), { content: "x" }))).toBe("allow");
    expect(decisionOf(await untrusted(tool("remember"), { content: "x" }))).toBe("deny");
    expect(decisionOf(await trusted(tool("read_file"), {}))).toBe("allow");
    expect(decisionOf(await trusted(tool("grep"), {}))).toBe("allow");
    expect(decisionOf(await trusted(tool("write_file"), {}))).toBe("deny");
    expect(decisionOf(await trusted(tool("run_bash"), { command: "ls" }))).toBe("deny");
    // 永不出 ask：策略全量 allow/deny，后台无交互
    expect(decisionOf(await trusted(tool("remember"), {}))).not.toBe("ask");
  });
});

describe("ExtractMemoriesEngine（决策 E1/E3）", () => {
  function makeCwd(): Promise<string> {
    return mkdtemp(path.join(os.tmpdir(), "run-agent-extract-"));
  }

  async function engine(
    cwd: string,
    fake: FakeClient,
    overrides: { isTrusted?: boolean; bare?: boolean; disabled?: boolean } = {},
  ) {
    const eng = new ExtractMemoriesEngine({
      cwd,
      isTrusted: overrides.isTrusted ?? true,
      bare: overrides.bare ?? false,
      client: fake,
      parentTools: () => [
        makeRememberTool({ cwd, isTrusted: overrides.isTrusted ?? true }),
        readTool,
        globTool,
        grepTool,
      ],
      ...(overrides.disabled !== undefined ? { disabled: overrides.disabled } : {}),
    });
    return eng;
  }

  it("触发开关：仅 Trust 且非 bare 且未关闭；未 Trust/bare/disabled 不触发（headless 由 REPL 装配结构排除）", async () => {
    const cwd = await makeCwd();
    const enabled = new FakeClient([endTurn]);
    const on = await engine(cwd, enabled);
    expect(on.enabled()).toBe(true);
    const offTrustFake = new FakeClient([]);
    const offTrust = await engine(cwd, offTrustFake, { isTrusted: false });
    expect(offTrust.enabled()).toBe(false);
    const offBareFake = new FakeClient([]);
    const offBare = await engine(cwd, offBareFake, { bare: true });
    expect(offBare.enabled()).toBe(false);
    const offDisabledFake = new FakeClient([]);
    const offDisabled = await engine(cwd, offDisabledFake, { disabled: true });
    expect(offDisabled.enabled()).toBe(false);
    // 关闭的引擎 trigger 直接短路：不发请求
    const msgs = [userMsg("a"), userMsg("b"), userMsg("c"), userMsg("d")];
    await offDisabled.trigger(msgs);
    expect(offDisabledFake.calls).toHaveLength(0);
    await offBare.trigger(msgs);
    expect(offBareFake.calls).toHaveLength(0);
    await offTrust.trigger(msgs);
    expect(offTrustFake.calls).toHaveLength(0);
    // 真正启用（Trust + 非 bare）才跑
    await on.trigger(msgs);
    expect(enabled.calls).toHaveLength(1);
    await rm(cwd, { recursive: true, force: true });
  });

  it("游标增量：第二次触发只分析新消息（prompt 只含增量）", async () => {
    const cwd = await makeCwd();
    const fake = new FakeClient([endTurn, endTurn]);
    const eng = await engine(cwd, fake);
    const first = [userMsg("旧消息1"), asstMsg("旧回复1"), userMsg("旧消息2"), asstMsg("旧回复2"), userMsg("旧消息3"), asstMsg("旧回复3")];
    await eng.trigger(first);
    expect(fake.calls).toHaveLength(1);
    expect(promptOf(fake.calls[0]!)).toContain("旧消息1");
    // 第二轮：只新增 4 条（≥ MIN_EXTRACT_INCREMENT，才会触发）
    const second = [
      ...first,
      userMsg("新消息1"),
      asstMsg("新回复1"),
      userMsg("新消息2"),
      asstMsg("新回复2"),
    ];
    await eng.trigger(second);
    expect(fake.calls).toHaveLength(2);
    const p2 = promptOf(fake.calls[1]!);
    expect(p2).toContain("新消息1");
    expect(p2).toContain("新消息2");
    expect(p2).not.toContain("旧消息1");
    await rm(cwd, { recursive: true, force: true });
  });

  it("增量太少(<4)跳过不发请求，不推进游标（累积到下次）", async () => {
    const cwd = await makeCwd();
    const fake = new FakeClient([]);
    const eng = await engine(cwd, fake);
    await eng.trigger([userMsg("a"), userMsg("b"), userMsg("c")]); // 3 条 < 4
    expect(fake.calls).toHaveLength(0);
    // 累积：再加 3 条 → 6 条 ≥ 4 → 触发
    await eng.trigger([userMsg("a"), userMsg("b"), userMsg("c"), userMsg("d"), userMsg("e"), userMsg("f")]);
    expect(fake.calls).toHaveLength(1);
    await rm(cwd, { recursive: true, force: true });
  });

  it("互斥：增量含 remember tool_use（主 agent 已写）→ 跳过并推进游标", async () => {
    const cwd = await makeCwd();
    const fake = new FakeClient([]);
    const eng = await engine(cwd, fake);
    const msgs = [userMsg("q"), asstRemember("已写"), userMsg("q2"), userMsg("q3"), userMsg("q4")];
    await eng.trigger(msgs);
    expect(fake.calls).toHaveLength(0); // 未发请求
    // 游标已推进：再次触发同批消息不再扫描
    await eng.trigger(msgs);
    expect(fake.calls).toHaveLength(0);
    await rm(cwd, { recursive: true, force: true });
  });

  it("提取子 agent 经 remember 写成功：临时 cwd 生成 <name>.md + MEMORY.md 索引更新", async () => {
    const cwd = await makeCwd();
    const fake = new FakeClient([
      [
        { type: "tool_use", id: "tu1", name: "remember", input: { content: "用户偏好极简输出", scope: "project", type: "feedback" } },
        { type: "done", stopReason: "tool_use" },
      ],
      [
        { type: "text", text: "已写入" },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    const eng = await engine(cwd, fake);
    await eng.trigger([userMsg("u1"), asstMsg("r1"), userMsg("u2"), asstMsg("r2")]);
    const dir = memoryDirPath(cwd);
    const files = await import("node:fs/promises").then((fs) => fs.readdir(dir));
    const mdFiles = files.filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
    expect(mdFiles).toHaveLength(1);
    const body = (await readFile(path.join(dir, mdFiles[0]!), "utf8")).replace(/^﻿/, "");
    expect(body).toContain("极简输出");
    const index = (await readFile(path.join(dir, "MEMORY.md"), "utf8")).replace(/^﻿/, "");
    expect(index).toContain(mdFiles[0]!.replace(/\.md$/, ""));
    await rm(cwd, { recursive: true, force: true });
  });

  it("失败不推进游标、不抛异常：下次触发重试", async () => {
    const cwd = await makeCwd();
    const fake = new FakeClient([new Error("boom")]);
    const eng = await engine(cwd, fake);
    const msgs = [userMsg("u1"), asstMsg("r1"), userMsg("u2"), asstMsg("r2")];
    await expect(eng.trigger(msgs)).resolves.toBeUndefined(); // 不抛
    expect(fake.calls).toHaveLength(1);
    // 游标未推进 → 再次触发会重试
    await eng.trigger(msgs);
    expect(fake.calls).toHaveLength(2);
    await rm(cwd, { recursive: true, force: true });
  });

  it("buildExtractPrompt：字节截断 + tool 消息格式化", () => {
    const msgs: LLMMessage[] = [
      userMsg("a".repeat(MAX_EXTRACT_BYTES + 1000)), // 超长 → 截断
      { role: "tool", tool_use_id: "tu9", content: "工具结果" },
    ];
    const p = buildExtractPrompt(msgs);
    expect(p).toContain("[工具结果 for tu9]");
    // 超长消息在字节上限内被截断（不炸 prompt）
    expect(Buffer.byteLength(p, "utf8")).toBeLessThan(MAX_EXTRACT_BYTES + 5000);
    expect(p).toContain("现有记忆索引");
    expect(p).toContain("增量消息");
  });
});
