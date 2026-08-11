import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { grepTool } from "../../src/tools/grep.js";

let dirs: string[] = [];

function makeTree(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "run-agent-grep-"));
  dirs.push(dir);
  writeFileSync(path.join(dir, "a.txt"), "hello world\nfoo bar\n");
  mkdirSync(path.join(dir, "sub"));
  writeFileSync(path.join(dir, "sub", "b.ts"), "const hello = 1;\nconst other = 2;\n");
  return dir;
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("grep 工具", () => {
  it("递归匹配并输出 file:line", async () => {
    const dir = makeTree();
    const r = await grepTool.call({ pattern: "hello", path: dir });
    expect(r.result).toContain("a.txt:1");
    expect(r.result).toContain("sub/b.ts:1");
    expect(r.result).not.toContain("foo bar");
  });

  it("glob 参数只搜特定文件", async () => {
    const dir = makeTree();
    const r = await grepTool.call({ pattern: "hello", path: dir, glob: "**/*.ts" });
    expect(r.result).toContain("sub/b.ts:1");
    expect(r.result).not.toContain("a.txt");
  });

  it("无匹配返回未找到", async () => {
    const dir = makeTree();
    const r = await grepTool.call({ pattern: "zzz", path: dir });
    expect(r.result).toContain("未找到匹配");
  });

  it("正则无效返回错误提示", async () => {
    const r = await grepTool.call({ pattern: "(", path: "C:/definitely/not/here" });
    expect(r.result).toContain("正则无效");
  });

  it("默认跳过 .run-agent 目录（V4.5 决策 F：上层根遍历不进入 agent 自身目录）", async () => {
    const dir = makeTree();
    mkdirSync(path.join(dir, ".run-agent", "memory"), { recursive: true });
    writeFileSync(path.join(dir, ".run-agent", "memory", "m.txt"), "hello agent\n");
    const r = await grepTool.call({ pattern: "hello", path: dir });
    expect(r.result).toContain("a.txt:1");
    expect(r.result).not.toContain("m.txt");
  });

  it("显式把根设为 .run-agent/memory 时可读取（专属通道的遍历语义）", async () => {
    const dir = makeTree();
    mkdirSync(path.join(dir, ".run-agent", "memory"), { recursive: true });
    writeFileSync(path.join(dir, ".run-agent", "memory", "m.txt"), "hello agent\n");
    const r = await grepTool.call({
      pattern: "hello",
      path: path.join(dir, ".run-agent", "memory"),
    });
    expect(r.result).toContain("m.txt");
  });
});
