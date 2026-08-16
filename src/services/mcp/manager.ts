/**
 * V5 决策 B2/B3：MCP 连接管理器 + 状态机。
 * - 状态机 4 态：connected / failed / needs-auth / disabled。初始（从未连接）：failed + error "未连接"；
 *   enabled:false → disabled；连接成功 → connected；连接失败 → failed（带错误消息）；http/sse 401 → needs-auth。
 * - connect(name) memoized：连接对象按 name 缓存；transport onclose 清缓存（下次自动重连）。
 * - 启动预连（V8 重设计①）：默认连接全部 enabled server；连接失败/401 进 failed/needs-auth，
 *   不阻断启动；/mcp connect <name> 手动重连（mcp_connect 工具已移除）。
 * - connect 可选注入 transport（测试用 InMemoryTransport 的 client 端）；缺省按配置类型构建：
 *   stdio（StdioClientTransport，stderr pipe）/ http（StreamableHTTPClientTransport，fetch 60s 超时）/ sse。
 * - 连接的 MCP 工具注册进 tools 池（mcp__server__tool），每轮 buildTools ++ getConnectedTools() 动态注入；
 *   readOnlyHints 供权限管线 readOnlyNames 闭包查询（决策 B4）。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "../../tools.js";
import { normalizeNameForMCP, wrapMcpTool } from "./tool.js";
import type { McpClientLike } from "./tool.js";
import type { McpServerConfig } from "./config.js";

export type McpServerStatus = "connected" | "failed" | "needs-auth" | "disabled";

export interface McpServerStatusEntry {
  name: string;
  status: McpServerStatus;
  /** 错误消息 / 未连接说明 */
  error?: string;
}

interface Conn {
  client: Client;
  close: () => Promise<void>;
}

const CONNECT_TIMEOUT_MS = 30_000;
/** 进程退出时给 stdio 子进程发信号的兜底等待（ms）——实际由 SDK transport.close 的升级序列负责。 */
export const STDIO_KILL_GRACE_MS = 600;

/** `${ENV_VAR}` 展开（headers 值 use-time 解析；未设置的环境变量展开为空串，服务器 401 即暴露）。 */
function expandEnvVars(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => process.env[name] ?? "");
}

/** http/sse 的 requestInit（注入展开后的自定义 headers；无 headers 返回空选项，SDK 走默认）。 */
export function requestInitFor(cfg: McpServerConfig): { requestInit?: RequestInit } {
  if (!cfg.headers) return {};
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(cfg.headers)) headers[k] = expandEnvVars(v);
  return { requestInit: { headers } };
}

/** 按配置类型构建传输；缺 url/command 抛错（调用方转 failed）。 */
function makeTransport(name: string, cfg: McpServerConfig): Transport {
  switch (cfg.type) {
    case "stdio": {
      if (!cfg.command) throw new Error(`MCP server ${name} 缺 command`);
      return new StdioClientTransport({
        command: cfg.command,
        ...(cfg.args ? { args: cfg.args } : {}),
        ...(cfg.env ? { env: cfg.env } : {}),
        stderr: "pipe",
      });
    }
    case "http": {
      if (!cfg.url) throw new Error(`MCP server ${name} 缺 url`);
      // SDK 的 StreamableHTTPClientTransport 类型声明在 exactOptionalPropertyTypes 下 sessionId
      // 可选性不匹配（string|undefined 对 string），运行时合法；cast 掉类型噪声。
      return new StreamableHTTPClientTransport(new URL(cfg.url), requestInitFor(cfg)) as unknown as Transport;
    }
    case "sse": {
      if (!cfg.url) throw new Error(`MCP server ${name} 缺 url`);
      return new SSEClientTransport(new URL(cfg.url), requestInitFor(cfg));
    }
  }
}

/** http/sse 连接被拒（401）→ needs-auth；其余错误 → failed。 */
function isNeedsAuth(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const status = (e as { status?: unknown }).status;
  if (status === 401 || status === "401") return true;
  return /401|unauthoriz|authentication required/i.test(e.message);
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(msg)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export class McpManager {
  private readonly servers: Record<string, McpServerConfig>;
  private readonly connections = new Map<string, Conn>();
  private readonly statuses = new Map<string, { status: McpServerStatus; error?: string }>();
  /** 已注册（已连接）工具池：完全限定名 → Tool */
  private readonly tools = new Map<string, Tool>();
  /** 完全限定名 → 只读 hint（供权限管线 readOnlyNames 闭包） */
  private readonly readOnlyHints = new Map<string, boolean>();
  /** server 名 → 它注册的工具完全限定名（连接关闭时按 server 清理，防残留旧 client 引用） */
  private readonly serverTools = new Map<string, string[]>();

  constructor(
    servers: Record<string, McpServerConfig>,
    /** 测试注入：按 name 覆盖按配置构建的传输（InMemoryTransport 等，见 startMockServer）。
     *  connect 显式传 transport 优先于本表。生产（cli/index.ts）不传。 */
    private readonly transportOverrides: Record<string, Transport> = {},
  ) {
    this.servers = servers;
    for (const name of Object.keys(servers)) {
      const cfg = servers[name]!;
      this.statuses.set(
        name,
        cfg.enabled === false
          ? { status: "disabled" }
          : { status: "failed", error: "未连接（/mcp connect <name> 重连）" },
      );
    }
  }

  /** 已配置的 server 名（保持配置顺序）。 */
  serverNames(): string[] {
    return Object.keys(this.servers);
  }

  getStatuses(): McpServerStatusEntry[] {
    return this.serverNames().map((name) => ({
      name,
      ...(this.statuses.get(name) ?? { status: "failed" as const, error: "未连接" }),
    }));
  }

  /** 完全限定名是否只读（MCP readOnlyHint；供权限管线 readOnlyNames 闭包）。 */
  isReadOnly(name: string): boolean {
    return this.readOnlyHints.get(name) ?? false;
  }

  /** 已连接 server 的完整配置摘要（/mcp 展示）。 */
  serverConfig(name: string): McpServerConfig | undefined {
    return this.servers[name];
  }

  /** 已注册（已连接）工具池，供每轮 tools 动态追加。 */
  getConnectedTools(): Tool[] {
    return [...this.tools.values()];
  }

  /** 清理一个 server 的注册工具 + 连接（幂等；连接关闭时调用，防旧 client 引用残留）。 */
  private forgetServer(name: string): void {
    const names = this.serverTools.get(name);
    if (names) {
      for (const n of names) {
        this.tools.delete(n);
        this.readOnlyHints.delete(n);
      }
      this.serverTools.delete(name);
    }
    this.connections.delete(name);
  }

  /**
   * 连接一个 server（memoized）：连接 → tools/list → 包装注册 → connected。
   * 已在连接态直接返回既有工具。失败 → failed/needs-auth（带错误消息），返回 ok:false。
   * @param transport 测试注入：覆盖按配置类型构建（InMemoryTransport 的 client 端）。
   */
  async connect(
    name: string,
    transport?: Transport,
  ): Promise<{ ok: true; tools: Tool[] } | { ok: false; error: string }> {
    const cfg = this.servers[name];
    if (!cfg) return { ok: false, error: `未知 MCP server: ${name}（/mcp 查看已配置）` };
    if (cfg.enabled === false)
      return { ok: false, error: `MCP server ${name} 已禁用（enabled:false）` };

    const prefix = `mcp__${normalizeNameForMCP(name)}__`;
    const existing = this.connections.get(name);
    if (existing) {
      return {
        ok: true,
        tools: [...this.tools.values()].filter((t) => t.name.startsWith(prefix)),
      };
    }

    let client: Client;
    let close: () => Promise<void>;
    try {
      const t = transport ?? this.transportOverrides[name] ?? makeTransport(name, cfg);
      // onclose 清缓存：stdio server 退出/http 断线后，下次 connect 自动重连
      t.onclose = () => {
        this.forgetServer(name);
      };
      client = new Client({ name: "run-agent", version: "0.5.0" }, { capabilities: {} });
      close = () => t.close();
      await withTimeout(
        client.connect(t),
        CONNECT_TIMEOUT_MS,
        `连接 MCP server ${name} 超时（${CONNECT_TIMEOUT_MS / 1000}s）`,
      );
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      this.statuses.set(
        name,
        isNeedsAuth(e) ? { status: "needs-auth", error: err } : { status: "failed", error: err },
      );
      return { ok: false, error: `连接 MCP server ${name} 失败: ${err}` };
    }

    try {
      const { tools: mcpTools } = await client.listTools();
      const wrapped: Tool[] = [];
      const addedNames: string[] = [];
      for (const mt of mcpTools) {
        // SDK Client 的 callTool 泛型返回是宽联合（含 error shape）；我们只用 text 子集，
        // cast 到最小表面（运行时行为已实测，见 tool.ts 单测）。
        const tool = wrapMcpTool(name, mt, client as unknown as McpClientLike);
        if (this.tools.has(tool.name)) continue; // 同名不覆盖（内置永远赢；后连 server 撞名跳过）
        this.tools.set(tool.name, tool);
        this.readOnlyHints.set(tool.name, tool.isConcurrencySafe === true);
        addedNames.push(tool.name);
        wrapped.push(tool);
      }
      this.serverTools.set(name, addedNames);
      this.connections.set(name, { client, close });
      this.statuses.set(name, { status: "connected" });
      return { ok: true, tools: wrapped };
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      this.statuses.set(name, { status: "failed", error: err });
      return { ok: false, error: `读取 MCP server ${name} 工具列表失败: ${err}` };
    }
  }

  /**
   * 非阻塞预连（REPL 启动用）：并发发起全部 enabled server 的连接，不等待结果。
   * connect() 内部捕获所有错误（失败进 failed/needs-auth 态、返回 ok:false），.catch 仅防御性兜底；
   * 连接完成注册的工具在下一轮 getConnectedTools() 拾取（工具池每轮重建）。
   */
  connectAllInBackground(): void {
    for (const name of this.serverNames()) {
      void this.connect(name).catch(() => {});
    }
  }

  /** 关闭并清理所有连接（进程退出时调用；幂等）。 */
  async closeAll(): Promise<void> {
    for (const name of [...this.connections.keys()]) {
      const conn = this.connections.get(name);
      this.forgetServer(name);
      try {
        await conn?.close();
      } catch {
        // 关闭失败静默（子进程可能已退出）
      }
    }
  }
}

/** 暴露给 cli/index.ts：进程退出清理。 */
export async function closeAllConnections(manager: McpManager | undefined): Promise<void> {
  if (manager) await manager.closeAll();
}
