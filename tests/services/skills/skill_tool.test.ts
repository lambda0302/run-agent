/**
 * V6 决策 B2：SkillRegistry + SkillTool 测试。
 * 覆盖：未知技能提示、body 加载回填、activate/resetActive、allowed-tools 过滤
 * （交集 + mcp__* 通配 + 内置只读保留 + 无限制原样）、并发安全 false。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeSkillTool, SkillRegistry } from "../../../src/services/skills/skill_tool.js";
import type { Skill } from "../../../src/services/skills/loader.js";
import type { Tool } from "../../../src/tools.js";
import { TOOLS } from "../../../src/tools.js";

/** 临时技能目录（body 落盘：SkillTool 惰性读取需真实磁盘源；`over.body` 作为文件正文）。 */
const skillDirs: string[] = [];
function makeSkill(over: Partial<Skill> & { body?: string } = {}): Skill {
  const { body = "按以下步骤执行…", ...rest } = over;
  const dir = mkdtempSync(path.join(tmpdir(), "run-agent-skill-"));
  skillDirs.push(dir);
  const name = rest.name ?? "demo";
  const description = rest.description ?? "演示技能";
  const md = path.join(dir, "SKILL.md");
  writeFileSync(md, `---\nname: ${name}\ndescription: ${description}\n---\n${body}`, "utf8");
  return { name, description, source: "project", path: md, ...rest };
}
afterEach(() => {
  for (const d of skillDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 造一批假工具池：真实内置只读（read_file）+ 写工具 + MCP 工具。 */
function pool(): Tool[] {
  const mcpTool: Tool = {
    name: "mcp__files__read",
    description: "mcp",
    inputSchema: { _parse: () => ({}) } as never,
    call: async () => ({ result: "x" }),
  };
  const writeTool: Tool = {
    name: "write_file",
    description: "w",
    inputSchema: { _parse: () => ({}) } as never,
    call: async () => ({ result: "x" }),
  };
  const read = TOOLS.find((t) => t.name === "read_file")!;
  return [read, writeTool, mcpTool];
}

describe("SkillRegistry 过滤（allowed-tools）", () => {
  it("无活跃技能 / 无 allowed-tools → 原样返回", () => {
    const reg = new SkillRegistry([makeSkill()]);
    const p = pool();
    expect(reg.filterToolsForActiveSkill(p)).toBe(p);

    // 无 allowed-tools（缺省）→ 不限制
    reg.activate(reg.find("demo")!);
    expect(reg.filterToolsForActiveSkill(p)).toBe(p);

    // 空 allowed-tools 视为不限制
    reg.activate(makeSkill({ allowedTools: [] }));
    expect(reg.filterToolsForActiveSkill(p)).toBe(p);
  });

  it("有 allowed-tools → 工具集 = allowed-tools ∩ 池 ∪ 内置只读", () => {
    const reg = new SkillRegistry([makeSkill({ allowedTools: ["mcp__files__read"] })]);
    reg.activate(reg.find("demo"));
    const names = reg.filterToolsForActiveSkill(pool()).map((t) => t.name);
    // write_file 不在集内 → 被滤掉；read_file 是内置只读 → 保留；mcp__files__read 命中 → 保留
    expect(names).toContain("read_file");
    expect(names).toContain("mcp__files__read");
    expect(names).not.toContain("write_file");
  });

  it("mcp__* 通配放行所有 MCP 工具", () => {
    const reg = new SkillRegistry([makeSkill({ allowedTools: ["mcp__*"] })]);
    reg.activate(reg.find("demo"));
    const names = reg.filterToolsForActiveSkill(pool()).map((t) => t.name);
    expect(names).toContain("mcp__files__read");
    expect(names).not.toContain("write_file");
  });

  it("无 allowed-tools 时 SkillTool 本身可用；resetActive 清空活跃状态", () => {
    const reg = new SkillRegistry([makeSkill()]);
    reg.activate(reg.find("demo"));
    expect(reg.activeSkill?.name).toBe("demo");
    reg.resetActive();
    expect(reg.activeSkill).toBeUndefined();
  });
});

describe("SkillTool", () => {
  it("未知技能 → 提示串 + 可用清单；不激活", async () => {
    const reg = new SkillRegistry([makeSkill()]);
    const tool = makeSkillTool(reg);
    const r = await tool.call({ name: "nope" });
    expect(r.result).toContain("未知技能「nope」");
    expect(r.result).toContain("demo: 演示技能");
    expect(reg.activeSkill).toBeUndefined();
  });

  it("命中 → body 回填 + 激活技能", async () => {
    const reg = new SkillRegistry([makeSkill({ body: "技能指令A\n指令B" })]);
    const tool = makeSkillTool(reg);
    const r = await tool.call({ name: "demo", args: { target: "x" } });
    expect(r.result).toBe("技能指令A\n指令B");
    expect(reg.activeSkill?.name).toBe("demo");
  });

  it("惰性读取：改动 SKILL.md 后再次调用读到新 body（热更新，无需重启）", async () => {
    const s = makeSkill({ body: "旧指令" });
    const reg = new SkillRegistry([s]);
    const tool = makeSkillTool(reg);
    expect((await tool.call({ name: "demo" })).result).toBe("旧指令");
    writeFileSync(s.path, "---\nname: demo\ndescription: 演示技能\n---\n新指令", "utf8");
    expect((await tool.call({ name: "demo" })).result).toBe("新指令");
  });

  it("技能文件被移除 → 返回错误文本，不崩溃；激活仍生效", async () => {
    const s = makeSkill();
    const reg = new SkillRegistry([s]);
    const tool = makeSkillTool(reg);
    rmSync(path.dirname(s.path), { recursive: true, force: true });
    const r = await tool.call({ name: "demo" });
    expect(r.result).toContain("读取失败");
    expect(reg.activeSkill?.name).toBe("demo"); // skill 仍在 registry，激活照常
  });

  it("并发安全 false（激活改变工具池状态，串行）", () => {
    expect(makeSkillTool(new SkillRegistry([makeSkill()])).isConcurrencySafe).toBe(false);
  });
});
