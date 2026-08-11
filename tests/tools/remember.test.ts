import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeRememberTool } from "../../src/tools/remember.js";
import { memoryDirPath } from "../../src/core/memory.js";

let dirs: string[] = [];

function makeEnv(): { home: string; cwd: string } {
  const home = mkdtempSync(path.join(tmpdir(), "run-agent-remember-"));
  dirs.push(home);
  const cwd = path.join(home, "proj");
  mkdirSync(cwd, { recursive: true });
  return { home, cwd };
}

function tool(env: { home: string; cwd: string }, isTrusted = true) {
  return makeRememberTool({ homeDir: env.home, cwd: env.cwd, isTrusted });
}

function memDir(env: { home: string; cwd: string }): string {
  return memoryDirPath(env.cwd);
}

function userMemFile(env: { home: string; cwd: string }): string {
  return path.join(env.home, ".config", "run-agent", "CLAUDE.md");
}

/** 记忆目录下的 topic 文件（不含 MEMORY.md）。 */
function topicFiles(env: { home: string; cwd: string }): string[] {
  const dir = memDir(env);
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
  } catch {
    return [];
  }
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("remember 项目级写入（scope 默认 project）", () => {
  it("首次写入：建 topic 文件（frontmatter + 正文）+ MEMORY.md 索引行", async () => {
    const env = makeEnv();
    const r = await tool(env).call({ content: "测试命令是 npm test" });
    expect(r.result).toContain("已记住");

    const files = topicFiles(env);
    expect(files).toHaveLength(1);
    const topic = readFileSync(path.join(memDir(env), files[0]!), "utf8");
    expect(topic).toContain("name:");
    expect(topic).toContain("测试命令是 npm test");

    const index = readFileSync(path.join(memDir(env), "MEMORY.md"), "utf8");
    expect(index).toMatch(/\[.*\]\(.+\.md\) — /);
  });

  it("主动沉淀不触碰用户级 CLAUDE.md", async () => {
    const env = makeEnv();
    await tool(env).call({ content: "某项目约定" });
    expect(existsSync(userMemFile(env))).toBe(false);
  });

  it("同内容再写（同 name）→ 跳过，不重复建文件/索引行", async () => {
    const env = makeEnv();
    const t = tool(env);
    await t.call({ content: "重复条目" });
    const r2 = await t.call({ content: "重复条目" });
    expect(r2.result).toContain("跳过");
    expect(topicFiles(env)).toHaveLength(1);
    const index = readFileSync(path.join(memDir(env), "MEMORY.md"), "utf8");
    expect(index.match(/- \[/g)).toHaveLength(1);
  });

  it("显式 name → 对应文件名；不同内容同 name → 更新原文件与索引行，不重复建", async () => {
    const env = makeEnv();
    const t = tool(env);
    await t.call({ content: "第一版", name: "feedback-testing", type: "feedback" });
    expect(existsSync(path.join(memDir(env), "feedback-testing.md"))).toBe(true);

    await t.call({ content: "第二版", name: "feedback-testing" });
    const topic = readFileSync(path.join(memDir(env), "feedback-testing.md"), "utf8");
    expect(topic).toContain("第二版");
    expect(topicFiles(env)).toHaveLength(1);
  });

  it("未信任项目 → 拒绝写入", async () => {
    const env = makeEnv();
    const r = await tool(env, false).call({ content: "不该写" });
    expect(r.result).toContain("未受信任");
    expect(topicFiles(env)).toHaveLength(0);
  });

  it("正文超 16KB → 拒绝写入", async () => {
    const env = makeEnv();
    const r = await tool(env).call({ content: "x".repeat(16 * 1024 + 1) });
    expect(r.result).toContain("上限");
    expect(topicFiles(env)).toHaveLength(0);
  });

  it("空内容 → zod 解析抛错（min(1)）", async () => {
    const env = makeEnv();
    await expect(tool(env).call({ content: "" })).rejects.toThrow();
  });
});

describe("remember scope='user'（仅用户明确要求时用）", () => {
  it("仍写用户级 CLAUDE.md（0.3.2 行为保留）", async () => {
    const env = makeEnv();
    const r = await tool(env).call({ content: "用户偏好：中文回复", scope: "user" });
    expect(r.result).toContain("已记住");
    expect(readFileSync(userMemFile(env), "utf8")).toContain("- 用户偏好：中文回复");
  });

  it("去重：相同内容再次写入 → 跳过", async () => {
    const env = makeEnv();
    const t = tool(env);
    await t.call({ content: "重复条目", scope: "user" });
    const r2 = await t.call({ content: "重复条目", scope: "user" });
    expect(r2.result).toContain("跳过");
  });

  it("超 32KB 上限 → 拒绝写入，文件未创建", async () => {
    const env = makeEnv();
    const r = await tool(env).call({ content: "x".repeat(32 * 1024 + 1), scope: "user" });
    expect(r.result).toContain("上限");
    expect(existsSync(userMemFile(env))).toBe(false);
  });
});
