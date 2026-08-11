import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeRememberTool } from "../../src/tools/remember.js";

let dirs: string[] = [];

function makeHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "run-agent-remember-"));
  dirs.push(dir);
  return dir;
}

/** 在沙箱 homeDir 下构造 remember 工具。 */
function tool(home: string) {
  return makeRememberTool(home);
}

/** 沙箱内的用户记忆文件路径。 */
function memFile(home: string): string {
  return path.join(home, ".config", "run-agent", "CLAUDE.md");
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("remember 写入用户级长期记忆", () => {
  it("首次写入：创建父目录 + 记忆文件，内容为 - <条目>", async () => {
    const home = makeHome();
    const r = await tool(home).call({ content: "测试命令是 npm test" });
    expect(r.result).toContain("已记住");
    const file = memFile(home);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("- 测试命令是 npm test");
  });

  it("追加：多条目分行写入，不覆盖已有内容", async () => {
    const home = makeHome();
    const t = tool(home);
    await t.call({ content: "第一条" });
    await t.call({ content: "第二条" });
    const content = readFileSync(memFile(home), "utf8");
    expect(content).toContain("- 第一条");
    expect(content).toContain("- 第二条");
  });

  it("去重：相同条目再次写入 → 跳过，不产生重复行", async () => {
    const home = makeHome();
    const t = tool(home);
    await t.call({ content: "重复条目" });
    const r2 = await t.call({ content: "重复条目" });
    expect(r2.result).toContain("跳过");
    const content = readFileSync(memFile(home), "utf8");
    expect(content.match(/- 重复条目/g)).toHaveLength(1);
  });

  it("已有文件末尾无换行时，追加仍能正确分隔", async () => {
    const home = makeHome();
    const file = memFile(home);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "- 旧条目", "utf8"); // 末尾无换行
    await tool(home).call({ content: "新条目" });
    const content = readFileSync(file, "utf8");
    expect(content).toContain("- 旧条目");
    expect(content).toContain("- 新条目");
    expect(content).not.toContain("旧条目- 新条目");
  });

  it("超 32KB 上限 → 拒绝写入并给出提示", async () => {
    const home = makeHome();
    const t = tool(home);
    const big = "x".repeat(32 * 1024 + 1);
    const r = await t.call({ content: big });
    expect(r.result).toContain("上限");
    // 文件未创建（拒绝写入）
    expect(existsSync(memFile(home))).toBe(false);
  });

  it("空内容 → zod 解析抛错（min(1)）", async () => {
    const home = makeHome();
    await expect(tool(home).call({ content: "" })).rejects.toThrow();
  });
});
