import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { makeAgentTool } from "../../src/tools/agent.js";
import { AgentRegistry, builtinAgentTypes, CORE_TEAM_TOOLS } from "../../src/services/agents/registry.js";
import { BackgroundTaskManager } from "../../src/services/agents/team/registry.js";
import type { LLMClient, LLMMessage, StreamEvent, StreamOptions } from "../../src/providers/types.js";
import type { Tool } from "../../src/tools.js";

class FakeClient implements LLMClient {
  provider = "fake";
  calls: LLMMessage[][] = [];
  toolCalls: string[][] = [];

  constructor(private scripted: StreamEvent[][]) {}

  async *stream(messages: LLMMessage[], opts?: StreamOptions): AsyncIterable<StreamEvent> {
    this.calls.push(messages);
    this.toolCalls.push(opts?.tools?.map((t) => t.name) ?? []);
    const next = this.scripted.shift();
    for (const ev of next ?? [{ type: "done", stopReason: "end_turn" }]) yield ev;
  }
}

const echoTool: Tool = {
  name: "echo",
  description: "Echo the given text back",
  inputSchema: z.object({ text: z.string() }),
  async call(input) {
    const { text } = input as { text: string };
    return { result: `echo:${text}` };
  },
};

const teamTool = (name: string): Tool => ({
  name,
  description: name,
  inputSchema: z.object({}),
  async call() {
    return { result: "" };
  },
});

describe("AgentRegistry + 内置类型（V7 决策 B）", () => {
  it("general-purpose：父级池过滤协调者三件套（防递归）", () => {
    const registry = new AgentRegistry(builtinAgentTypes());
    const def = registry.get("general-purpose")!;
    expect(def).toBeDefined();
    const parent = [echoTool, teamTool("agent"), teamTool("send_message"), teamTool("task_stop")];
    const tools = def.resolveTools(() => parent);
    expect(tools.map((t) => t.name)).toEqual(["echo"]);
    // 全部三件套都在排除集里
    for (const n of CORE_TEAM_TOOLS) expect(CORE_TEAM_TOOLS.has(n)).toBe(true);
  });

  it("explore：固定只读集（repo_map/glob/grep/read_file）", () => {
    const registry = new AgentRegistry(builtinAgentTypes());
    const def = registry.get("explore")!;
    const tools = def.resolveTools(() => []);
    expect(tools.map((t) => t.name).sort()).toEqual(["glob", "grep", "read_file", "repo_map"]);
    expect(def.maxIterations).toBe(8);
    expect(def.system).toContain("只读");
  });

  it("register：内置优先，同名自定义被忽略", () => {
    const registry = new AgentRegistry(builtinAgentTypes());
    const custom = {
      name: "general-purpose",
      description: "x",
      resolveTools: () => [],
    };
    expect(registry.register(custom)).toBe(false);
    expect(registry.get("general-purpose")!.description).not.toBe("x");
  });
});

describe("agent 工具（V7 决策 A2）", () => {
  it("未知类型 → 返回可用类型提示", async () => {
    const tool = makeAgentTool({
      client: new FakeClient([]),
      registry: new AgentRegistry(builtinAgentTypes()),
      parentTools: () => [echoTool],
    });
    const r = await tool.call({ description: "x", prompt: "y", agentType: "nope" });
    expect(r.result).toContain("未知 agent 类型");
    expect(r.result).toContain("general-purpose");
  });

  it("前台：await runAgent → 回填 [<类型> 结论] + reply", async () => {
    const fake = new FakeClient([
      [
        { type: "text", text: "答案" },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    const tool = makeAgentTool({
      client: fake,
      registry: new AgentRegistry(builtinAgentTypes()),
      parentTools: () => [echoTool],
    });
    const r = await tool.call({ description: "sub task", prompt: "去算一下" });
    expect(r.result).toContain("[general-purpose 结论]");
    expect(r.result).toContain("答案");
    // 子查询走独立上下文：请求首条是 prompt
    expect(fake.calls[0]![0]).toEqual({ role: "user", content: "去算一下" });
  });

  it("自定义 frontmatter 类型（agentType=qa）：子 system 含类型 body + 父级快照，工具集按白名单不含三件套", async () => {
    const fake = new FakeClient([
      [
        { type: "text", text: "qaqa" },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    const registry = new AgentRegistry(builtinAgentTypes());
    // 等价于 `.run-agent/agents/qa.md`：tools 白名单 echo + system 片段 + body
    registry.register({
      name: "qa",
      description: "代码审查",
      system: "你是 QA。\n\n专注找 bug。",
      resolveTools: (parent) => parent().filter((t) => t.name === "echo"),
    });
    const parentPool = [
      echoTool,
      teamTool("agent"),
      teamTool("send_message"),
      teamTool("task_stop"),
    ];
    const tool = makeAgentTool({
      client: fake,
      registry,
      system: "MAIN_SYSTEM",
      parentTools: () => parentPool,
    });
    const r = await tool.call({ description: "review", prompt: "审查", agentType: "qa" });
    expect(r.result).toContain("[qa 结论]");
    expect(r.result).toContain("qaqa");
    // 子 system = 类型 system + 主 system 快照（请求首条）
    const sysMsg = fake.calls[0]![0]!;
    expect(sysMsg.role).toBe("system");
    const sysText = typeof sysMsg.content === "string" ? sysMsg.content : "";
    expect(sysText).toContain("你是 QA");
    expect(sysText).toContain("专注找 bug");
    expect(sysText).toContain("MAIN_SYSTEM");
    // 子 agent 工具池按白名单过滤，三件套不在其中
    expect(fake.toolCalls[0]).toEqual(["echo"]);
  });

  it("model 覆盖：makeModelClient 被调用，子 agent 用新 client", async () => {
    const fake = new FakeClient([
      [
        { type: "text", text: "hi" },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    const makeModelClient = vi.fn(() => fake);
    const tool = makeAgentTool({
      client: fake,
      registry: new AgentRegistry(builtinAgentTypes()),
      makeModelClient,
      parentTools: () => [echoTool],
    });
    await tool.call({ description: "sub", prompt: "do", model: "claude-sonnet-5" });
    expect(makeModelClient).toHaveBeenCalledWith("claude-sonnet-5");
  });

  it("后台：spawn 返回可寻址占位，任务注册进 manager", async () => {
    const fake = new FakeClient([
      [
        { type: "text", text: "bg 结果" },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    const mgr = new BackgroundTaskManager();
    const tool = makeAgentTool({
      client: fake,
      registry: new AgentRegistry(builtinAgentTypes()),
      backgroundTasks: mgr,
      parentTools: () => [echoTool],
    });
    const r = await tool.call({ description: "bg", prompt: "慢慢跑", run_in_background: true });
    expect(r.result).toContain("后台子 agent task-1(general-purpose) 已启动");
    expect(mgr.list()).toHaveLength(1);
    expect(mgr.list()[0]!.status).toBe("running");
  });
});
