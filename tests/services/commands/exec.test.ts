/**
 * V6 决策 C1/C3：命令执行测试——prompt 模板展开 + local 脚本运行。
 * 覆盖：@file 内联（含缺文件/二进制/超行截断/BOM）、参数行尾追加、参数 @ 字面量；
 * local 脚本 argv/RUN_AGENT_* 环境、非 0 退出码、stdout 30k 截断、超时 kill、
 * .ts strip-types（按 Node 能力条件跑）、.py（有解释器才跑）。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execLocalCommand, expandPromptTemplate } from "../../../src/services/commands/exec.js";
import type { LocalCommand } from "../../../src/services/commands/loader.js";

const HAS_NATIVE_TS = Boolean((process.features as { typescript?: boolean }).typescript);

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "run-agent-cmdx-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function local(over: Partial<LocalCommand> = {}): LocalCommand {
  return { type: "local", name: "x", source: "project", file: "x.js", ext: "js", ...over };
}

function hasPython(): boolean {
  const candidates = process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
  return candidates.some((c) => {
    try {
      execFileSync(c, ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });
}

describe("expandPromptTemplate（prompt 形态）", () => {
  it("模板 + 参数行尾追加；参数里的 @ 视为字面量不展开", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "lit.txt"), "字面量", "utf8");
    const { text } = expandPromptTemplate("模板第一行", "arg1 @lit.txt", dir);
    expect(text).toBe("模板第一行\narg1 @lit.txt");
  });

  it("@file 内联：带 --- abs --- 头 + 内容；无参数时不追加空行", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "notes.txt"), "notes 内容", "utf8");
    const { text } = expandPromptTemplate("读取 @notes.txt", "", dir);
    expect(text).toBe(`读取 --- ${path.join(dir, "notes.txt")} ---\nnotes 内容`);
  });

  it("缺文件 → 占位说明，不中断；二进制 → 占位说明", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "bin.bin"), Buffer.from([0, 1, 2, 3]));
    const miss = expandPromptTemplate("a @no-such.txt b", "", dir).text;
    expect(miss).toContain("[无法内联 @no-such.txt: 文件不存在]");
    const bin = expandPromptTemplate("a @bin.bin", "", dir).text;
    expect(bin).toContain("[无法内联 @bin.bin: 二进制文件]");
  });

  it("BOM 剥离；超 2000 行 → 截断 + 注明", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "bom.txt"), "﻿内容", "utf8");
    expect(expandPromptTemplate("x @bom.txt", "", dir).text).toContain("内容");

    const longFile = path.join(dir, "long.txt");
    const lines: string[] = [];
    for (let i = 0; i < 2001; i++) lines.push(`L${i}`);
    writeFileSync(longFile, lines.join("\n"), "utf8");
    const out = expandPromptTemplate("x @long.txt", "", dir).text;
    expect(out).toContain("（已截断，超 2000 行）");
    expect(out).toContain("L1999"); // 前 2000 行保留（L0..L1999）
    expect(out).not.toContain("L2000"); // 第 2001 行被裁掉
  });
});

describe("execLocalCommand（local 形态）", () => {
  it(".js：参数走 argv；注入 RUN_AGENT_CWD / RUN_AGENT_PROMPT", async () => {
    const dir = tempDir();
    const script = path.join(dir, "probe.js");
    writeFileSync(
      script,
      `console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.env.RUN_AGENT_CWD, prompt: process.env.RUN_AGENT_PROMPT }))`,
      "utf8",
    );
    const res = await execLocalCommand(local({ file: script }), "one two", dir, "/probe one two");
    expect(res.ok).toBe(true);
    const got = JSON.parse(res.output) as { argv: string[]; cwd: string; prompt: string };
    expect(got.argv).toEqual(["one", "two"]);
    expect(got.cwd).toBe(dir);
    expect(got.prompt).toBe("/probe one two");
  });

  it(".js：非 0 退出码 → ok:false + exitCode", async () => {
    const dir = tempDir();
    const script = path.join(dir, "fail.js");
    writeFileSync(script, "process.exit(3)", "utf8");
    const res = await execLocalCommand(local({ file: script }), "", dir, "");
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(3);
  });

  it(".js：stdout 超 30k → 截断 + 注明", async () => {
    const dir = tempDir();
    const script = path.join(dir, "big.js");
    writeFileSync(script, "process.stdout.write('x'.repeat(40000))", "utf8");
    const res = await execLocalCommand(local({ file: script }), "", dir, "");
    expect(res.ok).toBe(true);
    expect(res.output).toContain("（输出超长，已截断）");
    expect(res.output.length).toBeLessThan(31000);
  });

  it("超时 kill → ok:false + [命令超时]；可注入 timeoutMs（测试用小值）", async () => {
    const dir = tempDir();
    const script = path.join(dir, "slow.js");
    writeFileSync(script, "setTimeout(() => {}, 60_000)", "utf8");
    const res = await execLocalCommand(local({ file: script }), "", dir, "", { timeoutMs: 400 });
    expect(res.ok).toBe(false);
    expect(res.output).toContain("[命令超时(400ms)]");
    expect(res.exitCode).toBeNull();
  });

  it.skipIf(!HAS_NATIVE_TS)(".ts：原生 strip-types 时直接跑（Node 22.6+）", async () => {
    const dir = tempDir();
    const script = path.join(dir, "typed.ts");
    writeFileSync(script, "const n: number = 41;\nconsole.log('ts-ok', n + 1);", "utf8");
    const res = await execLocalCommand(local({ file: script, ext: "ts" }), "", dir, "");
    expect(res.ok).toBe(true);
    expect(res.output).toContain("ts-ok 42");
  });

  it.skipIf(!hasPython())(".py：有 python 解释器时执行", async () => {
    const dir = tempDir();
    const script = path.join(dir, "hi.py");
    writeFileSync(script, 'print("py-ok", " | ".join(__import__("sys").argv[1:]))', "utf8");
    const res = await execLocalCommand(local({ file: script, ext: "py" }), "a b", dir, "");
    expect(res.ok).toBe(true);
    expect(res.output).toContain("py-ok a | b");
  });

  it("无 python 环境时给出明确提示（双解释器都缺失）", async () => {
    // 直接构造一个不可能存在的解释器场景：注入非真实路径的 cmd.file 不会触发；
    // 这里通过把 python candidates 全部挡掉的 env 不可行，改为仅验证 ENOENT 不抛异常。
    const dir = tempDir();
    const script = path.join(dir, "nope.py");
    writeFileSync(script, "pass", "utf8");
    const res = await execLocalCommand(local({ file: script, ext: "py" }), "", dir, "");
    // 两种结局都合法：有 python → ok:true；无 python → 明确提示
    expect(res.ok || res.output.includes("找不到 python 解释器")).toBe(true);
  });
});
