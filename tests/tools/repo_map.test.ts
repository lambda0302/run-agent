import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRepoMap,
  clearRepoMapCache,
  filterCandidates,
  scoreByPath,
} from "../../src/tools/repo_map.js";

let dirs: string[] = [];
const originalCwd = process.cwd();

function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "run-agent-repomap-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  process.chdir(originalCwd);
  clearRepoMapCache();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** 建临时 git 仓库：写入文件 → add → commit。repo_map 依赖 git ls-files 列候选。 */
function gitInitRepo(files: Record<string, string>): string {
  const dir = tempDir();
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "tester"], { cwd: dir, stdio: "ignore" });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

describe("scoreByPath / filterCandidates（纯函数）", () => {
  it("打分：文件名含查询词 > 路径段含 > 其他", () => {
    expect(scoreByPath("src/utils.ts", "utils")).toBe(2);
    expect(scoreByPath("src/utils/helper.ts", "utils")).toBe(1);
    expect(scoreByPath("src/other.ts", "utils")).toBe(0);
  });

  it("filterCandidates 过滤黑名单段与二进制扩展名", () => {
    const files = [
      "src/a.ts",
      "node_modules/x.js",
      ".run-agent/memory/m.md",
      ".claude/settings.json",
      "dist/b.js",
      "logo.png",
    ];
    expect(filterCandidates(files)).toEqual(["src/a.ts"]);
  });
});

describe("buildRepoMap（git 仓库两遍排序）", () => {
  it("符号命中 > 文件名命中 > 路径段命中", async () => {
    const dir = gitInitRepo({
      "src/tools/repo_map.ts":
        "export function buildRepoMap(query: string) {}\nexport function scanSymbols(x: string) {}\n",
      "buildRepoMapHelper.ts": "export function helper() {}\n",
      "vendor/buildRepoMapStub/note.txt": "placeholder\n",
    });
    process.chdir(dir);
    const out = await buildRepoMap("buildRepoMap");

    const sym = out.indexOf("src/tools/repo_map.ts");
    const file = out.indexOf("buildRepoMapHelper.ts");
    const pathHit = out.indexOf("vendor/buildRepoMapStub/note.txt");
    expect(sym).toBeGreaterThan(-1);
    expect(file).toBeGreaterThan(-1);
    expect(pathHit).toBeGreaterThan(-1);
    expect(sym).toBeLessThan(file);
    expect(file).toBeLessThan(pathHit);
    expect(out).toContain("export function buildRepoMap");
    expect(out).toContain("query=buildRepoMap");
  });

  it("符号查询：声明行含查询词的符号被扫出", async () => {
    const dir = gitInitRepo({
      "src/core.ts": "export function findAgent() {}\nexport function other() {}\n",
    });
    process.chdir(dir);
    const out = await buildRepoMap("findAgent");
    expect(out).toContain("src/core.ts");
    expect(out).toContain("export function findAgent");
  });

  it(".git/.run-agent/node_modules/.claude/dist 永不进候选", async () => {
    const dir = gitInitRepo({
      "src/main.ts": "export function main() {}\n",
      ".run-agent/memory/secret.md": "# 秘密\n",
      "node_modules/pkg/index.js": "module.exports = 1;\n",
      "dist/bundle.js": "var x = 1;\n",
      ".claude/settings.json": "{}",
    });
    process.chdir(dir);
    const out = await buildRepoMap("main");
    expect(out).not.toContain(".run-agent");
    expect(out).not.toContain("node_modules");
    expect(out).not.toContain("dist/bundle");
    expect(out).not.toContain(".claude");
    expect(out).toContain("src/main.ts");
  });

  it("maxBytes 截断输出（默认 4096）", async () => {
    const lines = Array.from(
      { length: 50 },
      (_, i) => `export function fn${i}(x: number) {}\n`,
    ).join("");
    const dir = gitInitRepo({ "src/a.ts": lines });
    process.chdir(dir);
    const out = await buildRepoMap("a.ts", 200);
    // 截断尾注会追加约 30 字符
    expect(out.length).toBeLessThanOrEqual(230);
    expect(out).toContain("已截断");
  });

  it("非 git 仓库退化为 readdir", async () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "hello.ts"), "export function hello() {}\n", "utf8");
    process.chdir(dir);
    const out = await buildRepoMap("hello");
    expect(out).toContain("src/hello.ts");
    expect(out).toContain("readdir");
  });
});
