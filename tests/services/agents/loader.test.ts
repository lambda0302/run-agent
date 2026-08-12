import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  loadAgents,
  parseAgentFile,
  projectAgentsDir,
  userAgentsDir,
} from "../../../src/services/agents/loader.js";
import { CORE_TEAM_TOOLS } from "../../../src/services/agents/registry.js";
import type { Tool } from "../../../src/tools.js";

let dirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "run-agent-agents-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const echoTool: Tool = {
  name: "echo",
  description: "Echo text",
  inputSchema: z.object({ text: z.string() }),
  async call(input) {
    return { result: String((input as { text: string }).text) };
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
const parent = () => [echoTool, ...["agent", "send_message", "task_stop"].map(teamTool)];

describe("parseAgentFile（frontmatter + body → AgentTypeDef）", () => {
  it("合法定义：tools 白名单 + system 片段 + body 并入子 system", () => {
    const def = parseAgentFile(
      `---\nname: qa\ndescription: 代码审查\nmodel: claude-sonnet-5\nmaxIterations: 6\ntools:\n  - echo\nsystem: 你是 QA。\n---\n专注找 bug，报 file:line。\n`,
    )!;
    expect(def.name).toBe("qa");
    expect(def.description).toBe("代码审查");
    expect(def.model).toBe("claude-sonnet-5");
    expect(def.maxIterations).toBe(6);
    // 子 system = frontmatter system + body
    expect(def.system).toContain("你是 QA。");
    expect(def.system).toContain("专注找 bug，报 file:line。");
    // 显式 tools → 只给声明的工具（白名单生效）
    expect(def.resolveTools(parent).map((t) => t.name)).toEqual(["echo"]);
  });

  it("tools 缺省 → 父级全部工具、默认不含三件套（worker 无协调权，防递归失控）", () => {
    const def = parseAgentFile("---\nname: worker\n---\n干活。\n")!;
    const tools = def.resolveTools(parent).map((t) => t.name);
    expect(tools).toContain("echo");
    for (const n of CORE_TEAM_TOOLS) expect(tools).not.toContain(n);
  });

  it("tools 显式含三件套 → 开放协调权（coordinator 型自定义）", () => {
    const def = parseAgentFile(
      `---\nname: captain\ntools:\n  - agent\n  - send_message\n  - task_stop\n---\n调度。\n`,
    )!;
    const tools = def.resolveTools(parent).map((t) => t.name);
    expect(tools).toEqual(["agent", "send_message", "task_stop"]);
  });

  it("剥 BOM（Windows 写出的 UTF-8 BOM）", () => {
    const def = parseAgentFile("﻿---\nname: bom\n---\nbody\n")!;
    expect(def.name).toBe("bom");
  });

  it("非法 frontmatter（缺 name / 名字非法 / 无 frontmatter）→ undefined", () => {
    expect(parseAgentFile("---\ndescription: 无名\n---\nbody\n")).toBeUndefined();
    expect(parseAgentFile("---\nname: 大写不行\n---\nbody\n")).toBeUndefined();
    expect(parseAgentFile("没有 frontmatter 的正文")).toBeUndefined();
  });
});

describe("loadAgents（用户级始终 + 项目级 Trust 门控 + 同名用户优先）", () => {
  function makeHome(): { home: string; cwd: string } {
    const home = tempDir();
    const cwd = path.join(home, "proj");
    mkdirSync(path.join(cwd, ".run-agent", "agents"), { recursive: true });
    return { home, cwd };
  }

  it("未 Trust：只加载用户级，项目级忽略", () => {
    const { home, cwd } = makeHome();
    mkdirSync(userAgentsDir(home), { recursive: true });
    writeFileSync(path.join(userAgentsDir(home), "user-agent.md"), "---\nname: user-agent\n---\n", "utf8");
    writeFileSync(
      path.join(projectAgentsDir(cwd), "proj-agent.md"),
      "---\nname: proj-agent\n---\n",
      "utf8",
    );
    const { agents } = loadAgents(cwd, false, home);
    expect(agents.map((a) => a.name)).toEqual(["user-agent"]);
  });

  it("Trust：项目级并入；同名用户级优先，项目级丢弃", () => {
    const { home, cwd } = makeHome();
    mkdirSync(userAgentsDir(home), { recursive: true });
    writeFileSync(
      path.join(userAgentsDir(home), "same.md"),
      "---\nname: same\ndescription: 用户版\n---\n",
      "utf8",
    );
    writeFileSync(
      path.join(projectAgentsDir(cwd), "same.md"),
      "---\nname: same\ndescription: 项目版\n---\n",
      "utf8",
    );
    writeFileSync(
      path.join(projectAgentsDir(cwd), "proj.md"),
      "---\nname: proj\n---\n",
      "utf8",
    );
    const { agents } = loadAgents(cwd, true, home);
    expect(agents.map((a) => a.name).sort()).toEqual(["proj", "same"]);
    expect(agents.find((a) => a.name === "same")!.description).toBe("用户版");
  });

  it("非法定义记入 skipped（不阻断启动）；目录缺失 → 空", () => {
    const { home, cwd } = makeHome();
    mkdirSync(userAgentsDir(home), { recursive: true });
    writeFileSync(path.join(userAgentsDir(home), "ok.md"), "---\nname: ok\n---\n", "utf8");
    writeFileSync(path.join(userAgentsDir(home), "bad.md"), "---\nname: 非法\n---\n", "utf8");
    writeFileSync(path.join(userAgentsDir(home), "no-fm.md"), "没有 frontmatter\n", "utf8");
    const { agents, skipped } = loadAgents(cwd, false, home);
    expect(agents.map((a) => a.name)).toEqual(["ok"]);
    expect(skipped).toContain("bad.md");
    expect(skipped).toContain("no-fm.md");
    // 空目录 → 空列表
    expect(loadAgents(cwd, false, tempDir()).agents).toEqual([]);
  });
});
