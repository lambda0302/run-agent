/**
 * V5 决策 B1 测试：mcp.json 用户级 + 项目级合读、Trust 门控、结构规范化。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadMcpConfig,
  projectMcpFilePath,
  userMcpFilePath,
} from "../../../src/services/mcp/config.js";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "run-agent-mcp-config-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeHomeConfig(homeDir: string, json: unknown): string {
  const file = userMcpFilePath(homeDir);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(json), "utf8");
  return file;
}

function writeProjectConfig(cwd: string, json: unknown): string {
  const file = projectMcpFilePath(cwd);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(json), "utf8");
  return file;
}

describe("loadMcpConfig", () => {
  it("无配置 → 空 servers", () => {
    const home = tempDir();
    const cfg = loadMcpConfig(tempDir(), true, home);
    expect(cfg.servers).toEqual({});
    expect(cfg.preconnect).toBe(false);
  });

  it("用户级 stdio/http/sse 配置解析", () => {
    const home = tempDir();
    writeHomeConfig(home, {
      servers: {
        filesystem: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/p"],
          env: { A: "1" },
        },
        github: { type: "http", url: "https://example.com/mcp" },
        sse1: { type: "sse", url: "https://example.com/sse" },
      },
    });
    const cfg = loadMcpConfig(tempDir(), true, home);
    expect(cfg.servers.filesystem).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/p"],
      env: { A: "1" },
    });
    expect(cfg.servers.github).toEqual({ type: "http", url: "https://example.com/mcp" });
    expect(cfg.servers.sse1).toEqual({ type: "sse", url: "https://example.com/sse" });
  });

  it("项目级仅 Trust 加载；未 Trust 忽略；项目级同名覆盖用户级", () => {
    const home = tempDir();
    writeHomeConfig(home, {
      servers: { git: { type: "http", url: "https://user.example/mcp" } },
    });
    const cwd = tempDir();
    writeProjectConfig(cwd, {
      servers: {
        git: { type: "http", url: "https://project.example/mcp" },
        local: { type: "stdio", command: "x" },
      },
    });

    // 未 Trust → 项目级不加载
    expect(loadMcpConfig(cwd, false, home).servers.git?.url).toBe("https://user.example/mcp");
    expect(loadMcpConfig(cwd, false, home).servers.local).toBeUndefined();

    // Trust → 合并，项目级覆盖同名
    const cfg = loadMcpConfig(cwd, true, home);
    expect(cfg.servers.git?.url).toBe("https://project.example/mcp");
    expect(cfg.servers.local).toEqual({ type: "stdio", command: "x" });
  });

  it("enabled:false 保留；preconnect 用户或项目任一 true 即 true", () => {
    const home = tempDir();
    writeHomeConfig(home, {
      preconnect: true,
      servers: { off: { type: "stdio", command: "x", enabled: false } },
    });
    const cfg = loadMcpConfig(tempDir(), true, home);
    expect(cfg.preconnect).toBe(true);
    expect(cfg.servers.off).toEqual({ type: "stdio", command: "x", enabled: false });
  });

  it("损坏 JSON / 非法 server 项 → 跳过（不崩溃）", () => {
    const home = tempDir();
    const file = userMcpFilePath(home);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{ not json", "utf8");
    expect(loadMcpConfig(tempDir(), true, home).servers).toEqual({});
  });

  it("type 非法的 server 丢弃；合法项保留", () => {
    const home = tempDir();
    writeHomeConfig(home, {
      servers: {
        good: { type: "stdio", command: "x" },
        bad: { type: "websocket", url: "wss://x" },
        notObj: "hello",
      },
    });
    const cfg = loadMcpConfig(tempDir(), true, home);
    expect(Object.keys(cfg.servers)).toEqual(["good"]);
  });
});
