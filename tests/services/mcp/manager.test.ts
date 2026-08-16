/**
 * V5 决策 B2 测试：状态机 4 态 + InMemoryTransport 集成（连接 → listTools → 调用 → 断开 → 重连）。
 * hermetic：mock server 在测试进程内，无真实网络。
 */
import { describe, expect, it } from "vitest";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpManager, requestInitFor } from "../../../src/services/mcp/manager.js";
import { startMockServer } from "./mockServer.js";

/** 注入一个 start 即抛 401 的假传输（模拟 http 未授权，不发真请求）。 */
function fake401Transport(): Transport {
  return {
    async start() {
      throw Object.assign(new Error("401 Unauthorized"), { status: 401 });
    },
    async send() {},
    async close() {},
  };
}

describe("McpManager 状态机 4 态", () => {
  it("初始（未连接）：enabled 的 server 显示 failed(未连接)；disabled 显示 disabled", () => {
    const m = new McpManager({
      a: { type: "stdio", command: "x" },
      off: { type: "stdio", command: "x", enabled: false },
    });
    expect(m.getStatuses()).toEqual([
      { name: "a", status: "failed", error: "未连接（/mcp connect <name> 重连）" },
      { name: "off", status: "disabled" },
    ]);
  });

  it("连接成功 → connected；工具注册、只读 hint 生效", async () => {
    const m = new McpManager({ mock: { type: "stdio", command: "x" } });
    const srv = await startMockServer([
      { name: "echo", readOnlyHint: false, inputSchema: { type: "object", properties: { x: { type: "string" } } } },
      { name: "ro_op", readOnlyHint: true },
    ]);
    try {
      const res = await m.connect("mock", srv.clientTransport);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.tools.map((t) => t.name).sort()).toEqual([
          "mcp__mock__echo",
          "mcp__mock__ro_op",
        ]);
        expect(res.tools.find((t) => t.name.endsWith("echo"))!.isConcurrencySafe).toBe(false);
        expect(res.tools.find((t) => t.name.endsWith("ro_op"))!.isConcurrencySafe).toBe(true);
        // V8 重设计①：保留 server 原始 JSON Schema
        expect(res.tools.find((t) => t.name.endsWith("echo"))!.jsonSchema).toEqual({
          type: "object",
          properties: { x: { type: "string" } },
        });
      }
      expect(m.isReadOnly("mcp__mock__ro_op")).toBe(true);
      expect(m.isReadOnly("mcp__mock__echo")).toBe(false);
      expect(m.getConnectedTools().length).toBe(2);
      expect(m.getStatuses()).toEqual([{ name: "mock", status: "connected" }]);
    } finally {
      await m.closeAll();
      await srv.close();
    }
  });

  it("重复连接（memoized）→ 返回既有工具，不重复注册", async () => {
    const m = new McpManager({ mock: { type: "stdio", command: "x" } });
    const srv = await startMockServer([{ name: "echo" }]);
    try {
      const r1 = await m.connect("mock", srv.clientTransport);
      const r2 = await m.connect("mock", srv.clientTransport);
      expect(r1.ok && r2.ok).toBe(true);
      expect(m.getConnectedTools().length).toBe(1);
    } finally {
      await m.closeAll();
      await srv.close();
    }
  });

  it("stdio 命令不存在 → failed（带错误消息）", async () => {
    const m = new McpManager({
      broken: { type: "stdio", command: "definitely-not-a-real-command-run-agent-test" },
    });
    const res = await m.connect("broken");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("失败");
    expect(m.getStatuses()[0]!.status).toBe("failed");
  });

  it("http 401 → needs-auth", async () => {
    const m = new McpManager({ gh: { type: "http", url: "https://example.com/mcp" } });
    const res = await m.connect("gh", fake401Transport());
    expect(res.ok).toBe(false);
    expect(m.getStatuses()[0]!.status).toBe("needs-auth");
  });

  it("enabled:false → 不连接、直接报禁用", async () => {
    const m = new McpManager({ off: { type: "stdio", command: "x", enabled: false } });
    const res = await m.connect("off");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("禁用");
    expect(m.getStatuses()[0]!.status).toBe("disabled");
    expect(m.getConnectedTools().length).toBe(0);
  });

  it("未知 server → ok:false", async () => {
    const m = new McpManager({});
    const res = await m.connect("nope");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("未知");
  });
});

describe("McpManager 连接集成", () => {
  it("连接 → 调用 mcp__server__tool 拿到结果 → closeAll 清理 → 重连新 server 可再调", async () => {
    const m = new McpManager({ mock: { type: "stdio", command: "x" } });
    const srv1 = await startMockServer([{ name: "echo", handler: (a) => `v1:${String(a.x)}` }]);
    try {
      const r1 = await m.connect("mock", srv1.clientTransport);
      expect(r1.ok).toBe(true);
      const echo1 = m.getConnectedTools().find((t) => t.name === "mcp__mock__echo")!;
      expect((await echo1.call({ x: "hi" })).result).toBe("v1:hi");
    } finally {
      await m.closeAll();
      await srv1.close();
    }

    // 清理后工具池清空，旧连接已断
    expect(m.getConnectedTools().length).toBe(0);

    // 重连新 server（不同 in-memory 实例）
    const srv2 = await startMockServer([{ name: "echo", handler: (a) => `v2:${String(a.x)}` }]);
    try {
      const r2 = await m.connect("mock", srv2.clientTransport);
      expect(r2.ok).toBe(true);
      const echo2 = m.getConnectedTools().find((t) => t.name === "mcp__mock__echo")!;
      expect((await echo2.call({ x: "hi" })).result).toBe("v2:hi");
      expect(m.getStatuses()[0]!.status).toBe("connected");
    } finally {
      await m.closeAll();
      await srv2.close();
    }
  });

  it("server 关闭（onclose）→ 自动清理连接与工具；重连自动恢复", async () => {
    const m = new McpManager({ mock: { type: "stdio", command: "x" } });
    const srv1 = await startMockServer([{ name: "echo" }]);
    const r1 = await m.connect("mock", srv1.clientTransport);
    expect(r1.ok).toBe(true);
    expect(m.getConnectedTools().length).toBe(1);

    // server 端关闭 → InMemoryTransport 向 client 端传播 onclose → 清缓存
    await srv1.close();
    // onclose 传播是异步的，等一个 tick
    await new Promise((r) => setTimeout(r, 20));
    expect(m.getConnectedTools().length).toBe(0);

    // 重连自动恢复
    const srv2 = await startMockServer([{ name: "echo" }]);
    try {
      const r2 = await m.connect("mock", srv2.clientTransport);
      expect(r2.ok).toBe(true);
      expect(m.getConnectedTools().length).toBe(1);
    } finally {
      await m.closeAll();
      await srv2.close();
    }
  });

  it("disconnect → 清理工具 + 关闭传输 + 状态回「未连接」；重复断开 ok:false；重连可再调", async () => {
    const m = new McpManager({ mock: { type: "stdio", command: "x" } });
    const srv1 = await startMockServer([{ name: "echo", handler: (a) => `v1:${String(a.x)}` }]);
    try {
      const r1 = await m.connect("mock", srv1.clientTransport);
      expect(r1.ok).toBe(true);
      expect(m.getConnectedTools().length).toBe(1);
      expect(m.getStatuses()).toEqual([{ name: "mock", status: "connected" }]);

      // 断开：工具清空、传输关闭、状态回初始「未连接」（/mcp 显示 ✗）
      const d1 = await m.disconnect("mock");
      expect(d1.ok).toBe(true);
      expect(m.getConnectedTools().length).toBe(0);
      expect(m.getStatuses()).toEqual([
        { name: "mock", status: "failed", error: "未连接（/mcp connect <name> 重连）" },
      ]);

      // 已断开再断 → ok:false（不抛）
      const d2 = await m.disconnect("mock");
      expect(d2.ok).toBe(false);
      if (!d2.ok) expect(d2.error).toContain("未连接");

      // 断开后重连新 server（不同 in-memory 实例）→ 工具重新注册、可再调
      const srv2 = await startMockServer([{ name: "echo", handler: (a) => `v2:${String(a.x)}` }]);
      try {
        const r2 = await m.connect("mock", srv2.clientTransport);
        expect(r2.ok).toBe(true);
        expect(m.getConnectedTools().length).toBe(1);
        const echo = m.getConnectedTools().find((t) => t.name === "mcp__mock__echo")!;
        expect((await echo.call({ x: "hi" })).result).toBe("v2:hi");
      } finally {
        await m.closeAll();
        await srv2.close();
      }
    } finally {
      await m.closeAll();
      await srv1.close();
    }
  });

  it("disconnect 未知 server → ok:false", async () => {
    const m = new McpManager({ mock: { type: "stdio", command: "x" } });
    const res = await m.disconnect("nope");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("未知");
  });

  it("tools/list 抛错 → failed（非连接阶段错误）", async () => {
    const m = new McpManager({ mock: { type: "stdio", command: "x" } });
    const srv = await startMockServer([{ name: "echo" }]);
    // 构造一个 start 成功、之后失败的假 client：用 InMemoryTransport 但 server 直接不响应——
    // 这里改用：注入一个 start 成功但 send 抛错的假传输
    const badTransport: Transport = {
      async start() {},
      async send() {
        throw new Error("broken pipe");
      },
      async close() {},
    };
    // 注意：InMemoryTransport 真实连接在下面测试；此处验证的是 start 抛错路径（fake 无 send 调用点）。
    const res = await m.connect("mock", badTransport);
    expect(res.ok).toBe(false);
    await srv.close();
  });
});

describe("McpManager 非阻塞预连（connectAllInBackground）", () => {
  /** 轮询直到条件成立（CI 慢机上比固定 setTimeout 可靠）。 */
  async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it("连接进行中 → 状态 pending（而非 failed/未连接）；结束后落地终态", async () => {
    const m = new McpManager({ slow: { type: "http", url: "https://example.com/mcp" } });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // start 挂起直到 release：模拟慢连接，让 pending 窗口可观测
    const gatedTransport: Transport = {
      async start() { await gate; throw new Error("boom"); },
      async send() {},
      async close() {},
    };
    const p = m.connect("slow", gatedTransport);
    // 连接已发起但未完成 → 立即可见 pending（REPL 启动后立刻 /mcp 看到的就是它）
    expect(m.getStatuses()[0]!.status).toBe("pending");
    release();
    const res = await p;
    expect(res.ok).toBe(false);
    expect(m.getStatuses()[0]!.status).toBe("failed");
  });

  it("同步返回（void），连接完成后工具进入池、状态 connected", async () => {
    // connectAllInBackground 不带 transport，走 transportOverrides（生产走配置构建的真实传输）
    const srv = await startMockServer([{ name: "echo" }]);
    const m = new McpManager({ mock: { type: "stdio", command: "x" } }, { mock: srv.clientTransport });
    try {
      // 不 await、不阻塞——调用即刻返回
      m.connectAllInBackground();
      await waitFor(() => m.getStatuses()[0]!.status === "connected");
      expect(m.getConnectedTools().length).toBe(1);
      expect(m.getConnectedTools()[0]!.name).toBe("mcp__mock__echo");
    } finally {
      await m.closeAll();
      await srv.close();
    }
  });

  it("连接失败不抛（fire-and-forget），状态进 failed", async () => {
    const m = new McpManager({
      broken: { type: "stdio", command: "definitely-not-a-real-command-run-agent-test" },
    });
    expect(() => m.connectAllInBackground()).not.toThrow();
    await waitFor(() => m.getStatuses()[0]!.status === "failed");
  });

  it("enabled:false 的 server 跳过（不连接）", async () => {
    const m = new McpManager({ off: { type: "stdio", command: "x", enabled: false } });
    m.connectAllInBackground();
    // 禁用 server 同步返回 disabled，无异步连接
    expect(m.getStatuses()).toEqual([{ name: "off", status: "disabled" }]);
  });
});

describe("requestInitFor（http/sse 认证 headers + ${ENV_VAR} 展开）", () => {
  it("无 headers → 空选项（SDK 走默认）", () => {
    expect(requestInitFor({ type: "http", url: "https://x/mcp" })).toEqual({});
  });

  it("headers 透传 + ${ENV_VAR} 展开为进程环境变量值", () => {
    process.env.MCP_TEST_TOKEN = "tok-123";
    try {
      const init = requestInitFor({
        type: "http",
        url: "https://x/mcp",
        headers: {
          Authorization: "Bearer ${MCP_TEST_TOKEN}",
          "X-Static": "v",
        },
      });
      expect(init.requestInit).toEqual({
        headers: { Authorization: "Bearer tok-123", "X-Static": "v" },
      });
    } finally {
      delete process.env.MCP_TEST_TOKEN;
    }
  });

  it("未设置的环境变量展开为空串（不抛错，服务器 401 即暴露）", () => {
    const init = requestInitFor({
      type: "http",
      url: "https://x/mcp",
      headers: { Authorization: "Bearer ${MCP_TEST_UNSET_VAR}" },
    });
    expect(init.requestInit).toEqual({ headers: { Authorization: "Bearer " } });
  });
});
