import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { globTool } from "../../src/tools/glob.js";

let dirs: string[] = [];

/** 造一棵目录树：a.ts, b.js, sub/c.ts, node_modules/d.ts */
function makeTree(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "run-agent-glob-"));
  dirs.push(dir);
  writeFileSync(path.join(dir, "a.ts"), "a");
  writeFileSync(path.join(dir, "b.js"), "b");
  mkdirSync(path.join(dir, "sub"));
  writeFileSync(path.join(dir, "sub", "c.ts"), "c");
  mkdirSync(path.join(dir, "node_modules"));
  writeFileSync(path.join(dir, "node_modules", "d.ts"), "d");
  return dir;
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("glob 工具", () => {
  it("**/*.ts 递归匹配且跳过 node_modules", async () => {
    const dir = makeTree();
    const r = await globTool.call({ pattern: "**/*.ts", path: dir });
    expect(r.result).toContain("a.ts");
    expect(r.result).toContain("sub/c.ts");
    expect(r.result).not.toContain("node_modules");
    expect(r.result).not.toContain("b.js");
  });

  it("* 只匹配当前层", async () => {
    const dir = makeTree();
    const r = await globTool.call({ pattern: "*.ts", path: dir });
    expect(r.result).toContain("a.ts");
    expect(r.result).not.toContain("sub/c.ts");
  });

  it("子目录限定 sub/**", async () => {
    const dir = makeTree();
    const r = await globTool.call({ pattern: "sub/**", path: dir });
    expect(r.result).toContain("sub/c.ts");
    expect(r.result).not.toContain("a.ts");
  });

  it("花括号 {ts,js}", async () => {
    const dir = makeTree();
    const r = await globTool.call({ pattern: "*.{ts,js}", path: dir });
    expect(r.result).toContain("a.ts");
    expect(r.result).toContain("b.js");
  });

  it("无匹配返回未找到", async () => {
    const dir = makeTree();
    const r = await globTool.call({ pattern: "**/*.xyz", path: dir });
    expect(r.result).toContain("未找到匹配");
  });

  it("ignore 参数额外跳过目录", async () => {
    const dir = makeTree();
    const r = await globTool.call({ pattern: "**/*.ts", path: dir, ignore: ["sub"] });
    expect(r.result).toContain("a.ts");
    expect(r.result).not.toContain("sub/c.ts");
  });

  it("默认跳过 .run-agent 目录（V4.5 决策 F：上层根遍历不进入 agent 自身目录）", async () => {
    const dir = makeTree();
    mkdirSync(path.join(dir, ".run-agent", "memory"), { recursive: true });
    writeFileSync(path.join(dir, ".run-agent", "memory", "m.ts"), "m");
    const r = await globTool.call({ pattern: "**/*.ts", path: dir });
    expect(r.result).toContain("a.ts");
    expect(r.result).not.toContain(".run-agent");
    expect(r.result).not.toContain("m.ts");
  });

  it("显式把根设为 .run-agent/memory 时可读取（专属通道的遍历语义：根自身不参与 ignore）", async () => {
    const dir = makeTree();
    mkdirSync(path.join(dir, ".run-agent", "memory"), { recursive: true });
    writeFileSync(path.join(dir, ".run-agent", "memory", "m.md"), "m");
    const r = await globTool.call({
      pattern: "**/*.md",
      path: path.join(dir, ".run-agent", "memory"),
    });
    expect(r.result).toContain("m.md");
  });
});
