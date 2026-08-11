import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_ENTRYPOINT_BYTES,
  MAX_ENTRYPOINT_LINES,
  MAX_MEMORY_FILE_BYTES,
  appendIndexLine,
  buildMemoryIndexBlock,
  deriveDescription,
  deriveName,
  entrypointPath,
  formatIndexLine,
  formatTopicFile,
  listMemories,
  memoryDirPath,
  parseIndexLine,
  parseTopicFile,
  peekIndexWrite,
  pruneMemories,
  readIndexLines,
  removeIndexLine,
  removeMemory,
  sanitizeName,
  topicFilePath,
  writeTopicFile,
} from "../../src/core/memory.js";

let dirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "run-agent-mem-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("parseTopicFile", () => {
  it("解析 frontmatter(name/description/type) + 正文,剥 BOM", () => {
    const m = parseTopicFile(
      "---\nname: feedback-testing\ndescription: 测试入口\ntype: feedback\n---\n\n正文内容",
    );
    expect(m?.name).toBe("feedback-testing");
    expect(m?.description).toBe("测试入口");
    expect(m?.type).toBe("feedback");
    expect(m?.body).toBe("正文内容");
  });

  it("type 非法 → undefined;无 frontmatter → 按纯正文", () => {
    expect(parseTopicFile("---\nname: a\ntype: bogus\n---\nbody")?.type).toBeUndefined();
    const plain = parseTopicFile("无 frontmatter 的文本");
    expect(plain?.name).toBe("");
    expect(plain?.body).toBe("无 frontmatter 的文本");
  });
});

describe("slug 推导", () => {
  it("sanitizeName 保留 CJK 与小写拉丁", () => {
    expect(sanitizeName("重复条目")).toBe("重复条目");
    expect(sanitizeName("Feedback!Testing")).toBe("feedback-testing");
    expect(sanitizeName("a b c")).toBe("a-b-c");
    expect(sanitizeName("!!!")).toBe("note");
  });

  it("deriveName = type 前缀 + 首行片段;deriveDescription = 首行(截断)", () => {
    expect(deriveName("测试命令是 npm test", "feedback")).toMatch(/^feedback-.*/);
    expect(deriveName("npm test 是唯一测试入口", "project")).toContain("npm");
    expect(deriveName("npm test 是唯一测试入口", "project")).toContain("是唯一测试入口");
    expect(deriveDescription("第一行\n第二行")).toBe("第一行");
    expect(deriveDescription("x".repeat(100))).toHaveLength(81); // 80 字符 + …
  });
});

describe("索引读写", () => {
  it("appendIndexLine 写 MEMORY.md;readIndexLines 读回;按 name 更新;removeIndexLine 摘除", async () => {
    const cwd = tempDir();
    const dir = memoryDirPath(cwd);
    await appendIndexLine(dir, formatIndexLine("a", "钩子a", "project"));
    await appendIndexLine(dir, formatIndexLine("b", "钩子b", "feedback"));
    expect(existsSync(entrypointPath(cwd))).toBe(true);

    const lines = await readIndexLines(dir);
    expect(lines).toHaveLength(2);
    expect(parseIndexLine(lines[0]!)?.name).toBe("a");

    // 同 name 再写 → 更新语义,仍 2 行且内容更新
    await appendIndexLine(dir, formatIndexLine("a", "钩子a2", "project"), { replaceName: "a" });
    expect(await readIndexLines(dir)).toHaveLength(2);
    expect((await readIndexLines(dir)).some((l) => l.includes("钩子a2"))).toBe(true);

    // 摘除:命中返回 true,再次摘除返回 false
    expect(await removeIndexLine(dir, "a")).toBe(true);
    expect(await readIndexLines(dir)).toHaveLength(1);
    expect(await removeIndexLine(dir, "a")).toBe(false);
  });

  it("peekIndexWrite 超限预检:行数上限 / 字节上限 / 更新不超限", async () => {
    const cwd = tempDir();
    const dir = memoryDirPath(cwd);
    mkdirSync(dir, { recursive: true });
    // 直接写满 200 行(避免 200 次顺序 appendIndexLine 在并行跑时 I/O 争用超时)
    const many = Array.from({ length: MAX_ENTRYPOINT_LINES }, (_, i) =>
      formatIndexLine(`m${i}`, "x", "project"),
    ).join("\n");
    writeFileSync(entrypointPath(cwd), many + "\n", "utf8");

    // 追加新行 → 超 200 行
    expect((await peekIndexWrite(dir, formatIndexLine("extra", "x", "project"))).ok).toBe(false);
    // 超长行 → 超 25KB
    const bigHook = "x".repeat(MAX_ENTRYPOINT_BYTES + 1);
    expect((await peekIndexWrite(dir, formatIndexLine("big", bigHook, "project"))).ok).toBe(false);
    // 更新已有行(去重替换)不超限
    const upd = await peekIndexWrite(dir, formatIndexLine("m0", "新钩子", "project"), {
      replaceName: "m0",
    });
    expect(upd.ok).toBe(true);
  });

  it("readIndexLines 行数超限截断并附警告行", async () => {
    const cwd = tempDir();
    const dir = memoryDirPath(cwd);
    mkdirSync(dir, { recursive: true });
    const many = Array.from(
      { length: MAX_ENTRYPOINT_LINES + 5 },
      (_, i) => `- [m${i}](m${i}.md) — x`,
    ).join("\n");
    writeFileSync(entrypointPath(cwd), many + "\n", "utf8");

    const lines = await readIndexLines(dir);
    expect(lines).toHaveLength(MAX_ENTRYPOINT_LINES + 1); // 200 行 + 1 条警告
    expect(lines.some((l) => l.includes("截断"))).toBe(true);
  });

  it("readIndexLines 字节超限截断并附警告行", async () => {
    const cwd = tempDir();
    const dir = memoryDirPath(cwd);
    mkdirSync(dir, { recursive: true });
    // 两行各 ~20KB,合计超 25KB
    writeFileSync(
      entrypointPath(cwd),
      `- [a](${"x".repeat(20 * 1024)}.md) — h\n- [b](${"y".repeat(20 * 1024)}.md) — h\n`,
      "utf8",
    );

    const lines = await readIndexLines(dir);
    const total = Buffer.byteLength(lines.join("\n"), "utf8");
    expect(total).toBeLessThanOrEqual(MAX_ENTRYPOINT_BYTES + 200);
    expect(lines.some((l) => l.includes("截断"))).toBe(true);
  });
});

describe("buildMemoryIndexBlock", () => {
  it("仅 Trust 注入;空索引/未 Trust → undefined;块含标题与索引行", async () => {
    const cwd = tempDir();
    const dir = memoryDirPath(cwd);
    expect(await buildMemoryIndexBlock(dir, true)).toBeUndefined(); // 空索引
    expect(await buildMemoryIndexBlock(dir, false)).toBeUndefined();

    await appendIndexLine(dir, formatIndexLine("a", "钩子", "project"));
    expect(await buildMemoryIndexBlock(dir, false)).toBeUndefined(); // 未 Trust 仍不注入

    const block = await buildMemoryIndexBlock(dir, true);
    expect(block).toContain("## MEMORY.md");
    expect(block).toContain("(a.md)");
    expect(block).toContain("快照");
  });
});

describe("writeTopicFile / formatTopicFile / removeMemory / prune / listMemories", () => {
  it("写 topic 文件(frontmatter + 正文);formatTopicFile 超 16KB 由字节数体现", async () => {
    const cwd = tempDir();
    await writeTopicFile(cwd, "a", { description: "d", type: "feedback" }, "body text");
    const raw = readFileSync(topicFilePath(cwd, "a"), "utf8");
    expect(raw).toContain("name: a");
    expect(raw).toContain("description: d");
    expect(raw).toContain("type: feedback");
    expect(raw).toContain("body text");

    const big = formatTopicFile(
      "big",
      { description: "d", type: "project" },
      "x".repeat(MAX_MEMORY_FILE_BYTES),
    );
    expect(Buffer.byteLength(big, "utf8")).toBeGreaterThan(MAX_MEMORY_FILE_BYTES);
  });

  it("removeMemory 删文件 + 摘索引行(幂等)", async () => {
    const cwd = tempDir();
    const dir = memoryDirPath(cwd);
    await writeTopicFile(cwd, "a", { type: "project" }, "body");
    await appendIndexLine(dir, formatIndexLine("a", "钩子", "project"));

    expect(await removeMemory(cwd, "a")).toBe(true);
    expect(existsSync(topicFilePath(cwd, "a"))).toBe(false);
    expect(await readIndexLines(dir)).toHaveLength(0);
    // 幂等:文件不存在也成功
    await expect(removeMemory(cwd, "ghost")).resolves.toBe(false);
  });

  it("pruneMemories 删除早于 N 天的 topic 文件 + 摘索引行", async () => {
    const cwd = tempDir();
    const dir = memoryDirPath(cwd);
    await writeTopicFile(cwd, "old", { type: "project" }, "old body");
    await writeTopicFile(cwd, "new", { type: "project" }, "new body");
    await appendIndexLine(dir, formatIndexLine("old", "老", "project"));
    await appendIndexLine(dir, formatIndexLine("new", "新", "project"));

    const fortyDays = 40 * 24 * 60 * 60 * 1000;
    utimesSync(
      topicFilePath(cwd, "old"),
      new Date(Date.now() - fortyDays),
      new Date(Date.now() - fortyDays),
    );

    expect(await pruneMemories(cwd, 30)).toBe(1);
    expect(existsSync(topicFilePath(cwd, "old"))).toBe(false);
    expect(existsSync(topicFilePath(cwd, "new"))).toBe(true);
    expect(await readIndexLines(dir)).toHaveLength(1);
  });

  it("listMemories 按 query 过滤 title/hook/name", async () => {
    const cwd = tempDir();
    const dir = memoryDirPath(cwd);
    await appendIndexLine(
      dir,
      formatIndexLine("feedback-testing", "npm test 是唯一入口", "feedback"),
    );
    await appendIndexLine(dir, formatIndexLine("user-workspace", "Windows 中文 prettier", "user"));

    expect(await listMemories(cwd)).toHaveLength(2);
    const hit = await listMemories(cwd, "npm test");
    expect(hit).toHaveLength(1);
    expect(hit[0]?.name).toBe("feedback-testing");
    expect(await listMemories(cwd, "不存在")).toHaveLength(0);
  });
});
