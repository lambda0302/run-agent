/**
 * V5 决策 B1：MCP 配置加载（零依赖，直读 fs）。
 * 两处合读：用户级 ~/.config/run-agent/mcp.json（始终加载）+ 项目级 <cwd>/.run-agent/mcp.json
 * （仅 Trust 会话加载，对齐 permissions.json 的防提示注入——项目文件是用户写的、agent 工具读不到）。
 * 项目级同名 server 覆盖用户级。读失败一律返回空（绝不因配置损坏让 CLI 崩溃）。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface McpServerConfig {
  /** stdio = 子进程；http = Streamable HTTP；sse = 传统 SSE */
  type: "stdio" | "http" | "sse";
  /** stdio：启动命令（如 npx） */
  command?: string;
  /** stdio：命令参数 */
  args?: string[];
  /** stdio：子进程环境变量覆盖 */
  env?: Record<string, string>;
  /** http/sse：端点 URL */
  url?: string;
  /** enabled:false → disabled 态（不连接、不注入） */
  enabled?: boolean;
}

export interface McpConfig {
  /** 启动即全量连接（默认 false，按需连接省 token/资源） */
  preconnect?: boolean;
  servers: Record<string, McpServerConfig>;
}

/** 用户级配置文件路径。 */
export function userMcpFilePath(homeDir: string = homedir()): string {
  return path.join(homeDir, ".config", "run-agent", "mcp.json");
}

/** 项目级配置文件路径（危险目录 .run-agent 下，agent 工具读不到）。 */
export function projectMcpFilePath(cwd: string): string {
  return path.join(cwd, ".run-agent", "mcp.json");
}

function parseJsonFile(file: string): McpConfig | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const serversRaw = raw.servers;
    const servers: Record<string, McpServerConfig> =
      serversRaw && typeof serversRaw === "object" && !Array.isArray(serversRaw)
        ? (serversRaw as Record<string, McpServerConfig>)
        : {};
    // 规范化：只保留结构合法的 server；非法项丢弃（保守，防恶意/损坏配置注入）
    const clean: Record<string, McpServerConfig> = {};
    for (const [name, cfg] of Object.entries(servers)) {
      if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) continue;
      const c = cfg as unknown as Record<string, unknown>;
      const type = c.type;
      if (type !== "stdio" && type !== "http" && type !== "sse") continue;
      clean[name] = {
        type,
        ...(typeof c.command === "string" ? { command: c.command } : {}),
        ...(Array.isArray(c.args)
          ? { args: c.args.filter((a): a is string => typeof a === "string") }
          : {}),
        ...(c.env && typeof c.env === "object" && !Array.isArray(c.env)
          ? { env: c.env as Record<string, string> }
          : {}),
        ...(typeof c.url === "string" ? { url: c.url } : {}),
        ...(c.enabled === false ? { enabled: false } : {}),
      };
    }
    return { preconnect: raw.preconnect === true, servers: clean };
  } catch {
    return undefined;
  }
}

/** 合读用户级 + 项目级（仅 Trust）。项目级同名覆盖用户级。全空返回 { servers: {} }。 */
export function loadMcpConfig(
  cwd: string,
  isTrusted: boolean,
  homeDir: string = homedir(),
): McpConfig {
  const user = parseJsonFile(userMcpFilePath(homeDir));
  const project = isTrusted ? parseJsonFile(projectMcpFilePath(cwd)) : undefined;
  const servers: Record<string, McpServerConfig> = {};
  if (user) Object.assign(servers, user.servers);
  if (project) Object.assign(servers, project.servers); // 项目级覆盖同名
  return {
    preconnect: (user?.preconnect ?? false) || (project?.preconnect ?? false),
    servers,
  };
}
