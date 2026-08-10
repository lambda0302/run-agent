import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { editTool } from "../../src/tools/edit.js";

let dirs: string[] = [];

function makeFile(content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "run-agent-edit-"));
  dirs.push(dir);
  const p = path.join(dir, "a.txt");
  writeFileSync(p, content, "utf8");
  return p;
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("edit_file 精确字符串替换", () => {
  it("单处替换成功", async () => {
    const p = makeFile("foo bar baz");
    const r = await editTool.call({ file_path: p, old_string: "bar", new_string: "X" });
    expect(r.result).toContain("替换了 1 处");
    expect(readFileSync(p, "utf8")).toBe("foo X baz");
  });

  it("old_string 未找到 → 报错且不改文件", async () => {
    const p = makeFile("abc");
    const r = await editTool.call({ file_path: p, old_string: "zzz", new_string: "q" });
    expect(r.result).toContain("没有找到");
    expect(readFileSync(p, "utf8")).toBe("abc");
  });

  it("多处匹配且未开 replace_all → 报错", async () => {
    const p = makeFile("a b a");
    const r = await editTool.call({ file_path: p, old_string: "a", new_string: "z" });
    expect(r.result).toContain("出现 2 次");
    expect(readFileSync(p, "utf8")).toBe("a b a");
  });

  it("replace_all=true 全部替换", async () => {
    const p = makeFile("a b a");
    const r = await editTool.call({
      file_path: p,
      old_string: "a",
      new_string: "z",
      replace_all: true,
    });
    expect(r.result).toContain("替换了 2 处");
    expect(readFileSync(p, "utf8")).toBe("z b z");
  });

  it("old_string 与 new_string 相同 → 成功且无变化", async () => {
    const p = makeFile("same");
    const r = await editTool.call({ file_path: p, old_string: "same", new_string: "same" });
    expect(r.result).toContain("替换了 1 处");
    expect(readFileSync(p, "utf8")).toBe("same");
  });

  it("文件不存在 → 报错", async () => {
    const r = await editTool.call({
      file_path: "C:/definitely/not/here.txt",
      old_string: "a",
      new_string: "b",
    });
    expect(r.result).toContain("编辑失败");
  });
});
