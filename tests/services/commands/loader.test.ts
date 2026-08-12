/**
 * V6 决策 C1：自定义命令扫描 + 形态识别 + Trust 门控测试。
 * 覆盖：用户/项目两源合读、Trust 门控、命令名合法性过滤、大小上限、同名去重（用户优先）、
 * 空文件（.md→空模板 prompt / .js→合法 local）、CommandRegistry.find。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CommandRegistry,
  MAX_COMMAND_BYTES,
  loadCommands,
} from "../../../src/services/commands/loader.js";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "run-agent-cmds-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 在临时 home 下写一个命令文件，返回项目 cwd。 */
function writeCmd(
  homeDir: string,
  kind: "user" | "project",
  filename: string,
  content = "",
): string {
  const base =
    kind === "user"
      ? path.join(homeDir, ".config", "run-agent", "commands")
      : path.join(homeDir, "proj", ".run-agent", "commands");
  mkdirSync(base, { recursive: true });
  writeFileSync(path.join(base, filename), content, "utf8");
  return path.join(homeDir, "proj");
}

describe("loadCommands（扫描 + Trust 门控 + 合读）", () => {
  it("用户级始终加载；项目级仅 Trust；无配置 → 空", () => {
    const home = tempDir();
    writeCmd(home, "user", "hello.md", "# 问候模板");
    writeCmd(home, "project", "ship.js", "console.log('ship')");

    const untrusted = loadCommands(path.join(home, "proj"), false, home);
    expect(untrusted.commands.map((c) => c.name)).toEqual(["hello"]);
    expect(untrusted.commands[0]!.source).toBe("user");

    const trusted = loadCommands(path.join(home, "proj"), true, home);
    expect(trusted.commands.map((c) => c.name)).toEqual(["hello", "ship"]);
    expect(trusted.commands[1]!.source).toBe("project");
    expect(trusted.commands[1]!.type).toBe("local");
    expect(trusted.commands[1]!.type === "local" && trusted.commands[1]!.ext).toBe("js");

    // 全新 home：完全无配置 → 空
    const fresh = tempDir();
    const none = loadCommands(path.join(fresh, "proj"), true, fresh);
    expect(none.commands).toEqual([]);
    expect(none.skipped).toEqual([]);
  });

  it("形态识别：.md → prompt；.py/.js/.ts → local；其它扩展名忽略", () => {
    const home = tempDir();
    writeCmd(home, "project", "a.md", "模板");
    writeCmd(home, "project", "b.py", "print(1)");
    writeCmd(home, "project", "c.ts", "console.log(1)");
    writeCmd(home, "project", "d.txt", "ignored");
    const { commands } = loadCommands(path.join(home, "proj"), true, home);
    const names = commands.map((c) => `${c.name}:${c.type}`);
    expect(names).toEqual(["a:prompt", "b:local", "c:local"]);
    expect(commands.find((c) => c.name === "c")).toMatchObject({ type: "local", ext: "ts" });
  });

  it("同名去重：用户级优先，项目级同名丢弃", () => {
    const home = tempDir();
    writeCmd(home, "user", "greet.md", "用户版模板");
    writeCmd(home, "project", "greet.md", "项目版模板");
    const { commands } = loadCommands(path.join(home, "proj"), true, home);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.source).toBe("user");
    expect(commands[0]!.type).toBe("prompt");
  });

  it("命令名含空白 → 记入 skipped；大小超限 → 记入 skipped", () => {
    const home = tempDir();
    writeCmd(home, "project", "good.md", "好模板");
    writeCmd(home, "project", "bad name.md", "不该加载");
    writeCmd(home, "project", "big.md", "x".repeat(MAX_COMMAND_BYTES + 1));
    const { commands, skipped } = loadCommands(path.join(home, "proj"), true, home);
    expect(commands.map((c) => c.name)).toEqual(["good"]);
    expect(skipped).toContain("bad name.md");
    expect(skipped).toContain("big.md");
  });

  it("空文件：.md → 空模板 prompt 命令；.js → 合法 local 命令（不跳过）", () => {
    const home = tempDir();
    writeCmd(home, "project", "blank.md", "");
    writeCmd(home, "project", "noop.js", "");
    const { commands, skipped } = loadCommands(path.join(home, "proj"), true, home);
    expect(commands.map((c) => c.name)).toEqual(["blank", "noop"]);
    expect(skipped).toEqual([]);
    const blank = commands.find((c) => c.name === "blank")!;
    expect(blank.type).toBe("prompt");
    expect((blank as { template: string }).template).toBe("");
  });
});

describe("CommandRegistry", () => {
  it("find 命中/未命中；all 原样", () => {
    const home = tempDir();
    writeCmd(home, "project", "hi.md", "hi");
    const { commands } = loadCommands(path.join(home, "proj"), true, home);
    const reg = new CommandRegistry(commands);
    expect(reg.find("hi")?.name).toBe("hi");
    expect(reg.find("nope")).toBeUndefined();
    expect(reg.all).toHaveLength(1);
  });
});
