/**
 * V6 决策 B1：技能扫描 + frontmatter 解析 + Trust 门控测试。
 * 覆盖：用户/项目两源合读、Trust 门控、frontmatter 合法/非法跳过、大小上限、同名去重（用户优先）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_SKILL_BYTES,
  loadSkills,
  parseSkillFile,
  readSkillBody,
  userSkillsDir,
} from "../../../src/services/skills/loader.js";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "run-agent-skills-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 在临时 home 下写一个技能，返回 (homeDir, cwd)。 */
function writeSkill(
  homeDir: string,
  kind: "user" | "project",
  name: string,
  frontmatter: string,
  body = "技能指令正文",
): string {
  const base =
    kind === "user"
      ? path.join(homeDir, ".config", "run-agent", "skills", name)
      : path.join(homeDir, "proj", ".run-agent", "skills", name);
  mkdirSync(base, { recursive: true });
  writeFileSync(path.join(base, "SKILL.md"), `---\n${frontmatter}---\n${body}`, "utf8");
  return path.join(homeDir, "proj");
}

describe("parseSkillFile（frontmatter 解析）", () => {
  it("合法 frontmatter（name/description/allowed-tools）→ 技能对象", () => {
    const s = parseSkillFile(
      `---
name: demo
description: 演示技能
allowed-tools:
  - read_file
  - grep
---
正文第一行
正文第二行`,
      "project",
    );
    expect(s?.name).toBe("demo");
    expect(s?.description).toBe("演示技能");
    expect(s?.allowedTools).toEqual(["read_file", "grep"]);
    expect(s?.body).toBe("正文第一行\n正文第二行");
    expect(s?.source).toBe("project");
  });

  it("缺 name / description → undefined；非法 YAML 形态 → undefined", () => {
    expect(parseSkillFile("---\ndescription: 缺名字\n---\nbody", "user")).toBeUndefined();
    expect(parseSkillFile("---\nname: demo\n---\nbody", "user")).toBeUndefined();
    // 没有 frontmatter 头
    expect(parseSkillFile("name: demo\ndescription: x\n---\nbody", "user")).toBeUndefined();
    // 空文件
    expect(parseSkillFile("", "user")).toBeUndefined();
  });

  it("name 必须是小写 slug（非法字符 → undefined）", () => {
    expect(
      parseSkillFile("---\nname: My Skill!\ndescription: x\n---\nbody", "user"),
    ).toBeUndefined();
    expect(
      parseSkillFile("---\nname: good-name_1\ndescription: x\n---\nbody", "user"),
    )?.toBeTruthy();
  });

  it("BOM 剥离；引号标量剥引号", () => {
    const s = parseSkillFile('﻿---\nname: demo\ndescription: "带引号描述"\n---\nbody', "user");
    expect(s?.description).toBe("带引号描述");
  });
});

describe("loadSkills（扫描 + Trust 门控 + 合读）", () => {
  it("用户级始终加载（与 cwd 无关）；项目级仅 Trust；无配置 → 空", () => {
    const home = tempDir();
    writeSkill(home, "user", "user-skill", "name: user-skill\ndescription: 用户技能\n");
    writeSkill(home, "project", "proj-skill", "name: proj-skill\ndescription: 项目技能\n");

    const untrusted = loadSkills(path.join(home, "proj"), false, home);
    expect(untrusted.skills.map((s) => s.name)).toEqual(["user-skill"]);
    expect(untrusted.skills[0]!.source).toBe("user");

    const trusted = loadSkills(path.join(home, "proj"), true, home);
    expect(trusted.skills.map((s) => s.name)).toEqual(["user-skill", "proj-skill"]);
    expect(trusted.skills[1]!.source).toBe("project");

    // 惰性契约：registry 条目持 path、不持 body（body 由 readSkillBody 调用时现读）
    expect(trusted.skills[0]!.path).toMatch(/SKILL\.md$/);
    expect("body" in trusted.skills[0]!).toBe(false);

    // 换 cwd：用户级照常加载（用户技能全局生效），只是项目级不读
    const other = loadSkills(path.join(home, "other"), true, home);
    expect(other.skills.map((s) => s.name)).toEqual(["user-skill"]);

    // 全新 home：完全无配置 → 空
    const fresh = tempDir();
    const none = loadSkills(path.join(fresh, "proj"), true, fresh);
    expect(none.skills).toEqual([]);
    expect(none.skipped).toEqual([]);
  });

  it("同名去重：用户级优先，项目级同名丢弃", () => {
    const home = tempDir();
    writeSkill(home, "user", "same", "name: same\ndescription: 用户版\n");
    writeSkill(home, "project", "same", "name: same\ndescription: 项目版\n");
    const { skills } = loadSkills(path.join(home, "proj"), true, home);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.description).toBe("用户版");
  });

  it("非法 frontmatter → 记入 skipped 不阻断；大小超限 → 记入 skipped", () => {
    const home = tempDir();
    writeSkill(home, "project", "bad", "name: 中文名非法\ndescription: x\n");
    writeSkill(home, "project", "ok", "name: ok-skill\ndescription: 好的\n");
    const big = path.join(home, "proj", ".run-agent", "skills", "big-skill");
    mkdirSync(big, { recursive: true });
    writeFileSync(path.join(big, "SKILL.md"), "x".repeat(MAX_SKILL_BYTES + 1), "utf8");

    const { skills, skipped } = loadSkills(path.join(home, "proj"), true, home);
    expect(skills.map((s) => s.name)).toEqual(["ok-skill"]);
    expect(skipped).toContain("bad");
    expect(skipped).toContain("big-skill");
  });

  it("userSkillsDir 路径约定", () => {
    expect(userSkillsDir("/fake/home")).toBe(
      path.join("/fake/home", ".config", "run-agent", "skills"),
    );
  });
});

describe("readSkillBody（惰性读取 + 热更新）", () => {
  it("从磁盘现读 body；改动文件后再次读取 → 新 body（无需重启/重建 registry）", () => {
    const home = tempDir();
    const proj = writeSkill(home, "project", "demo", "name: demo\ndescription: 演示\n", "旧指令");
    const { skills } = loadSkills(proj, true, home);
    const skill = skills.find((s) => s.name === "demo")!;
    expect(readSkillBody(skill)).toBe("旧指令");

    const md = path.join(home, "proj", ".run-agent", "skills", "demo", "SKILL.md");
    writeFileSync(md, "---\nname: demo\ndescription: 演示\n---\n新指令", "utf8");
    expect(readSkillBody(skill)).toBe("新指令");
  });

  it("文件被移除 → 错误文本（不抛，tool_result 兜底）", () => {
    const home = tempDir();
    const proj = writeSkill(home, "project", "demo", "name: demo\ndescription: 演示\n");
    const { skills } = loadSkills(proj, true, home);
    const skill = skills[0]!;
    rmSync(path.join(home, "proj", ".run-agent", "skills", "demo"), {
      recursive: true,
      force: true,
    });
    expect(readSkillBody(skill)).toContain("读取失败");
  });

  it("调用时超上限 / frontmatter 失效 → 对应错误文本", () => {
    const home = tempDir();
    const proj = writeSkill(home, "project", "demo", "name: demo\ndescription: 演示\n");
    const { skills } = loadSkills(proj, true, home);
    const skill = skills[0]!;
    const md = path.join(home, "proj", ".run-agent", "skills", "demo", "SKILL.md");
    writeFileSync(md, "x".repeat(MAX_SKILL_BYTES + 1), "utf8");
    expect(readSkillBody(skill)).toContain("上限");
    writeFileSync(md, "---\nname: 中文名非法\ndescription: x\n---\nbody", "utf8");
    expect(readSkillBody(skill)).toContain("解析失败");
  });
});
