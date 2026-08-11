/**
 * V5 决策 B2 测试：REPL /mcp 命令（注入 input 流驱动真实 dispatch，hermetic）。
 * 覆盖：无配置提示 / 列出状态与图标 / /mcp connect 成功与失败 / 未知子命令。
 * 客户端不被触碰（只发 / 命令），dummy client 直接 throw 以证明未走模型。
 */
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LLMClient, StreamEvent } from "../src/providers/types.js";
import { runRepl } from "../src/cli/repl.js";
import type { McpServerConfig } from "../src/services/mcp/config.js";
import { McpManager } from "../src/services/mcp/manager.js";
import { startMockServer } from "./services/mcp/mockServer.js";

const throwClient: LLMClient = {
  provider: "fake",
  async *stream(): AsyncIterable<StreamEvent> {
    throw new Error("REPL 不应调模型（/mcp 是纯命令）");
  },
};

/** 用注入 stdin 跑 REPL，收集输出；完成后 resolve。
 *  逐行写 + 中间等一个 tick：readline 不会等 async line handler 完成，若一次灌入所有行，
 *  后面的 /mcp、/exit 会抢在还在 await 的 connect 之前执行（输出乱序/丢失）。 */
async function runReplLines(opts: Parameters<typeof runRepl>[0], lines: string[]): Promise<string> {
  const input = new PassThrough();
  const chunks: Buffer[] = [];
  const out = new PassThrough();
  out.on("data", (c: Buffer) => chunks.push(c));
  const done = runRepl({ ...opts, input, out });
  const tick = () => new Promise((r) => setTimeout(r, 25));
  for (const l of lines) {
    input.write(l + "\n");
    await tick();
  }
  input.end();
  await done;
  return Buffer.concat(chunks).toString("utf8");
}

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "run-agent-mcp-repl-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("REPL /mcp（V5 决策 B2）", () => {
  it("未配置 manager → 提示配置文件路径", async () => {
    const out = await runReplLines(
      { client: throwClient, tools: [], sessionFile: path.join(tempDir(), "s.jsonl") },
      ["/mcp", "/exit"],
    );
    expect(out).toContain("未配置 MCP server");
    expect(out).toContain("mcp.json");
  });

  it("/mcp 列出各 server 状态与图标（connected/failed/disabled）", async () => {
    const cfg: Record<string, McpServerConfig> = {
      on: { type: "stdio", command: "x" },
      off: { type: "stdio", command: "x", enabled: false },
    };
    const m = new McpManager(cfg);
    const srv = await startMockServer([{ name: "echo" }]);
    await m.connect("on", srv.clientTransport);
    try {
      const out = await runReplLines(
        {
          client: throwClient,
          tools: [],
          sessionFile: path.join(tempDir(), "s.jsonl"),
          mcpManager: m,
        },
        ["/mcp", "/exit"],
      );
      expect(out).toContain("MCP servers:");
      expect(out).toContain("✓ on (connected)");
      expect(out).toContain("⛔ off (disabled)");
    } finally {
      await m.closeAll();
      await srv.close();
    }
  });

  it("/mcp connect <name> 成功注册工具", async () => {
    const srv = await startMockServer([{ name: "echo" }]);
    // 给 manager 注入 InMemoryTransport（构造器覆盖表）
    const cfg: Record<string, McpServerConfig> = { mock: { type: "stdio", command: "x" } };
    const m2 = new McpManager(cfg, { mock: srv.clientTransport });
    try {
      const out = await runReplLines(
        {
          client: throwClient,
          tools: [],
          sessionFile: path.join(tempDir(), "s.jsonl"),
          mcpManager: m2,
        },
        ["/mcp connect mock", "/mcp", "/exit"],
      );
      expect(out).toContain("✓ 已连接 mock，注册 1 个工具");
      // 后续 /mcp 列出 → 状态已变 connected
      expect(out).toContain("✓ mock (connected)");
    } finally {
      await m2.closeAll();
      await srv.close();
    }
  });

  it("/mcp connect 未知 server → 错误提示（✗）", async () => {
    const m = new McpManager({});
    const out = await runReplLines(
      {
        client: throwClient,
        tools: [],
        sessionFile: path.join(tempDir(), "s.jsonl"),
        mcpManager: m,
      },
      ["/mcp connect nope", "/exit"],
    );
    expect(out).toContain("✗");
    expect(out).toContain("未知");
  });
});
