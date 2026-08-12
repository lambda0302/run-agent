import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  VERIFICATION_SYSTEM,
  VERIFICATION_TOOL_NAMES,
  makeVerificationCheckPermission,
  parseVerdict,
} from "../../../../src/services/agents/builtin/verification.js";
import { builtinAgentTypes } from "../../../../src/services/agents/registry.js";
import { decisionOf } from "../../../../src/core/execute.js";
import type { Tool } from "../../../../src/tools.js";

const tool = (name: string): Tool => ({
  name,
  description: name,
  inputSchema: z.object({}),
  async call() {
    return { result: "" };
  },
});

// cwd 用 process.cwd()：pathInCwd 对相对路径 target 按进程 cwd 解析，测试环境即仓库根
const cp = (name: string, input: unknown) =>
  makeVerificationCheckPermission(process.cwd())(tool(name), input);

describe("verification 类型注册（决策 D）", () => {
  it("内置三型含 verification：工具集无写工具（repo_map/glob/grep/read_file/verify/run_bash）", () => {
    const registry = builtinAgentTypes();
    const def = registry.find((d) => d.name === "verification")!;
    expect(def).toBeDefined();
    const parent = [
      tool("read_file"),
      tool("write_file"),
      tool("edit_file"),
      tool("glob"),
      tool("grep"),
      tool("repo_map"),
      tool("verify"),
      tool("run_bash"),
      tool("agent"),
    ];
    const names = def.resolveTools(() => parent).map((t) => t.name);
    expect(new Set(names)).toEqual(VERIFICATION_TOOL_NAMES); // 接线一致：registry 用的就是导出常量
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("edit_file");
    expect(names).not.toContain("agent"); // 无协调权
    // 类型级专门权限策略 + 子 system 含策略/反合理化/契约
    expect(def.checkPermission).toBeDefined();
    expect(def.maxIterations).toBe(12);
    expect(def.system).toBe(VERIFICATION_SYSTEM); // registry 直接装配导出 system
    expect(def.system).toContain("反合理化");
    expect(def.system).toContain("按改动类型定策略");
    expect(def.system).toContain("Command run:");
    expect(def.system).toContain("VERDICT: PASS");
  });
});

describe("verification 权限策略（决策 D3）", () => {
  it("safe bash 自动放行（构建/测试/lint 不弹窗）", async () => {
    for (const cmd of ["npx tsc --noEmit", "npm test", "npx eslint src/", "npm run build"]) {
      const r = await cp("run_bash", { command: cmd });
      expect(r).toEqual({ decision: "allow" });
    }
  });

  it("危险命令 deny（engine 硬底线）", async () => {
    for (const cmd of ["rm -rf /", "git push --force", "npm publish"]) {
      expect(decisionOf(await cp("run_bash", { command: cmd }))).toBe("deny");
    }
  });

  it("risky 命令 deny（sudo / 具体路径 rm）", async () => {
    for (const cmd of ["sudo apt install x", "rm -rf node_modules"]) {
      expect(decisionOf(await cp("run_bash", { command: cmd }))).toBe("deny");
    }
  });

  it("项目内写重定向 deny", async () => {
    const r = await cp("run_bash", { command: "echo x > README.md" });
    expect(decisionOf(r)).toBe("deny");
    expect(r && typeof r === "object" ? r.reason : undefined).toContain("禁写项目文件");
  });

  it("/tmp 与 $TMPDIR 临时脚本放行", async () => {
    for (const cmd of [
      "cat > /tmp/race.sh <<'EOF'\necho hi\nEOF",
      "echo x > $TMPDIR/probe.sh",
      "echo y > $TMP/probe.sh",
    ]) {
      expect(decisionOf(await cp("run_bash", { command: cmd }))).toBe("allow");
    }
  });

  it("写目标越界（cwd 外）deny", async () => {
    expect(decisionOf(await cp("run_bash", { command: "echo x > /etc/passwd" }))).toBe("deny");
  });

  it("write/edit 兜底 deny；只读工具放行；未知工具 deny", async () => {
    expect(decisionOf(await cp("write_file", { file_path: "C:/proj/x.ts" }))).toBe("deny");
    expect(decisionOf(await cp("edit_file", { file_path: "C:/proj/x.ts" }))).toBe("deny");
    expect(decisionOf(await cp("read_file", {}))).toBe("allow");
    expect(decisionOf(await cp("repo_map", {}))).toBe("allow");
    expect(decisionOf(await cp("verify", { file: "x.ts" }))).toBe("allow");
    expect(decisionOf(await cp("random_tool", {}))).toBe("deny");
  });
});

describe("VERDICT 解析器（决策 D4 证据契约）", () => {
  it("合法 PASS（含 Command run 证据）→ valid", () => {
    const r = parseVerdict(
      "### Check: build\n**Command run:**\n  npx tsc --noEmit\n**Result: PASS**\n\nVERDICT: PASS",
    );
    expect(r).toEqual({ verdict: "PASS", valid: true, issues: [] });
  });

  it("PASS 但无命令证据 → 判拒", () => {
    const r = parseVerdict("我读了代码觉得没问题。\n\nVERDICT: PASS");
    expect(r.verdict).toBe("PASS");
    expect(r.valid).toBe(false);
    expect(r.issues[0]).toContain("缺证据");
  });

  it("FAIL / PARTIAL 无需命令证据仍合法（字面量校验）", () => {
    expect(parseVerdict("构建失败：Expected vs Actual。\n\nVERDICT: FAIL").valid).toBe(true);
    expect(parseVerdict("环境无测试框架。\n\nVERDICT: PARTIAL").valid).toBe(true);
  });

  it("缺 VERDICT 字面量 → 告警", () => {
    const r = parseVerdict("### Check: build\n**Command run:**\n  npx tsc\n**Result: PASS**");
    expect(r.verdict).toBeUndefined();
    expect(r.valid).toBe(false);
  });

  it("markdown 包裹 / 大写字面量也能解析", () => {
    expect(parseVerdict("**VERDICT: PASS**\n**Command run:**\n x").verdict).toBe("PASS");
    expect(parseVerdict("VERDICT : fail").verdict).toBeUndefined(); // 小写不匹配
  });
});
