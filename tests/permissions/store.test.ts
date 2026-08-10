import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addRule,
  addTrustedProject,
  isProjectTrusted,
  loadRules,
  loadTrustedProjects,
  removeTrustedProject,
} from "../../src/permissions/store.js";
import type { PermissionRule } from "../../src/permissions/types.js";

const dirs: string[] = [];
function tmpFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "run-agent-store-"));
  dirs.push(dir);
  return path.join(dir, "store.json");
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("规则持久化", () => {
  it("文件不存在 → 空数组", () => {
    expect(loadRules(tmpFile())).toEqual([]);
  });

  it("addRule 写入后可读回，JSON 形状为 { rules: [...] }", () => {
    const f = tmpFile();
    const rule: PermissionRule = { tool: "run_bash", action: "allow" };
    const rules = addRule(rule, f);
    expect(rules).toContainEqual(rule);
    expect(loadRules(f)).toEqual([rule]);
  });

  it("损坏的 JSON → 空数组（不崩溃）", () => {
    const f = tmpFile();
    // 手动写坏内容
    writeFileSync(f, "{not json", "utf8");
    expect(loadRules(f)).toEqual([]);
  });

  it("非 { rules: [] } 形状 → 空数组", () => {
    const f = tmpFile();
    writeFileSync(f, JSON.stringify({ rules: "nope" }), "utf8");
    expect(loadRules(f)).toEqual([]);
  });
});

describe("Trust 持久化", () => {
  it("addTrustedProject 去重并读回（路径归一化）", () => {
    const f = tmpFile();
    const p = path.resolve("proj");
    addTrustedProject(p, f);
    addTrustedProject(p + path.sep, f); // 重复添加（带尾分隔符）应去重
    expect(loadTrustedProjects(f)).toEqual([p]);
  });

  it("removeTrustedProject 移除", () => {
    const f = tmpFile();
    addTrustedProject("a", f);
    addTrustedProject("b", f);
    removeTrustedProject("a", f);
    const list = loadTrustedProjects(f);
    expect(list).not.toContain(path.resolve("a"));
    expect(list).toContain(path.resolve("b"));
  });

  it("isProjectTrusted：精确匹配与子目录为真，兄弟目录为假", () => {
    const trusted = [path.resolve("C:/repo-a")];
    expect(isProjectTrusted("C:/repo-a", trusted)).toBe(true);
    expect(isProjectTrusted("C:/repo-a/src", trusted)).toBe(true);
    expect(isProjectTrusted("C:/repo-ab", trusted)).toBe(false);
    expect(isProjectTrusted("C:/other", trusted)).toBe(false);
  });

  it("路径大小写/分隔符差异经 resolve+normalize 归一化", () => {
    const f = tmpFile();
    addTrustedProject("C:/Repo-X/./", f);
    expect(isProjectTrusted("C:/Repo-X", loadTrustedProjects(f))).toBe(true);
  });

  it("损坏的 trust.json → 空数组", () => {
    const f = tmpFile();
    writeFileSync(f, "###", "utf8");
    expect(loadTrustedProjects(f)).toEqual([]);
  });
});
