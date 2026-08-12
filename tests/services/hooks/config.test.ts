/**
 * V6 决策 A3：hooks 配置加载测试。
 * 用户级 + 项目级(Trust 门控)合读、同事件合并、非法文件容错、空配置判定。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isHooksConfigEmpty, loadHooksConfig } from "../../../src/services/hooks/config.js";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "run-agent-hooks-config-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 在临时 home/cwd 里写 settings.json，返回 homeDir。 */
function writeSettings(homeDir: string, kind: "user" | "project", json: unknown): string {
  const file =
    kind === "user"
      ? path.join(homeDir, ".config", "run-agent", "settings.json")
      : path.join(homeDir, "proj", ".run-agent", "settings.json");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(json), "utf8");
  return path.join(homeDir, "proj");
}

describe("loadHooksConfig（V6 决策 A3）", () => {
  it("无任何配置 → 空 config，isHooksConfigEmpty 为 true", () => {
    const home = tempDir();
    const cfg = loadHooksConfig(path.join(home, "proj"), false, home);
    expect(isHooksConfigEmpty(cfg)).toBe(true);
  });

  it("用户级始终加载；项目级仅 Trust 加载", () => {
    const home = tempDir();
    const cwd = writeSettings(home, "user", {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo user" }] }] },
    });
    writeSettings(home, "project", {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo project" }] }] },
    });

    // 未 Trust → 只有用户级
    const untrusted = loadHooksConfig(cwd, false, home);
    expect(untrusted.Stop).toHaveLength(1);
    expect(untrusted.Stop![0]!.hooks[0]!.command).toBe("echo user");

    // Trust → 用户 + 项目合并（用户在前）
    const trusted = loadHooksConfig(cwd, true, home);
    expect(trusted.Stop).toHaveLength(2);
    expect(trusted.Stop![0]!.hooks[0]!.command).toBe("echo user");
    expect(trusted.Stop![1]!.hooks[0]!.command).toBe("echo project");
  });

  it("同一事件多规则 + matcher + http 形态完整解析", () => {
    const home = tempDir();
    const cwd = writeSettings(home, "user", {
      hooks: {
        PreToolUse: [
          { matcher: "Edit|Write", hooks: [{ type: "command", command: "a", timeout: 1000 }] },
          { hooks: [{ type: "http", url: "http://x", headers: { "x-a": "1" } }] },
        ],
      },
    });
    const cfg = loadHooksConfig(cwd, true, home);
    expect(cfg.PreToolUse).toHaveLength(2);
    expect(cfg.PreToolUse![0]!.matcher).toBe("Edit|Write");
    expect(cfg.PreToolUse![0]!.hooks[0]!.timeout).toBe(1000);
    expect(cfg.PreToolUse![1]!.hooks[0]!.type).toBe("http");
    expect(cfg.PreToolUse![1]!.hooks[0]!.url).toBe("http://x");
  });

  it("非法 JSON / 非法结构 / 超大文件 → 容错跳过不崩", () => {
    const home = tempDir();
    const cwd = path.join(home, "proj");
    mkdirSync(path.join(home, ".config", "run-agent"), { recursive: true });
    writeFileSync(
      path.join(home, ".config", "run-agent", "settings.json"),
      "this is not json{{{",
      "utf8",
    );
    expect(isHooksConfigEmpty(loadHooksConfig(cwd, true, home))).toBe(true);

    // 结构非法（hooks 值不是数组）
    writeFileSync(
      path.join(home, ".config", "run-agent", "settings.json"),
      JSON.stringify({ hooks: { Stop: { type: "command" } } }),
      "utf8",
    );
    expect(isHooksConfigEmpty(loadHooksConfig(cwd, true, home))).toBe(true);
  });

  it("settings.json 非 hooks 键忽略（为后续扩展留位）", () => {
    const home = tempDir();
    const cwd = writeSettings(home, "user", {
      permission: "acceptEdits",
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] },
    });
    const cfg = loadHooksConfig(cwd, true, home);
    expect(cfg.SessionStart).toHaveLength(1);
    expect((cfg as Record<string, unknown>).permission).toBeUndefined();
  });
});
