# MCP（Model Context Protocol）接入

V5 里程碑 2。run-agent 通过 [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) 接入 MCP server，把 server 暴露的工具接入标准 `Tool` 管线：**同一权限引擎、同一并发调度、同一 token 预算**。

设计目标（对齐 roadmap「接入标准协议生态」，但机制刻意简化）：

- **按需连接**：启动不 spawn 任何 server 进程、不 listTools。模型需要时才经 `mcp_connect` 连接。
- **懒 schema 省 token**：不为每个 MCP 工具传输 server 的完整 JSON Schema，入参校验交给 server 自身。
- **只连可信 server**：MCP 工具的参数是 server 内部黑盒，run-agent 不解析——信任边界必须诚实标注（见下）。

## 配置 `mcp.json`

两处合读（与 `config.json` 同一层级）：

| 位置   | 路径                           | 加载条件                                                                                   |
| ------ | ------------------------------ | ------------------------------------------------------------------------------------------ |
| 用户级 | `~/.config/run-agent/mcp.json` | 始终加载                                                                                   |
| 项目级 | `<cwd>/.run-agent/mcp.json`    | **仅 Trust 会话**（对齐 permissions.json 防提示注入；见 [permissions.md](permissions.md)） |

项目级同名 server **覆盖**用户级。结构：

```json
{
  "servers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
      "env": { "KEY": "value" }
    },
    "github": { "type": "http", "url": "https://api.githubcopilot.com/mcp/" },
    "example-sse": { "type": "sse", "url": "https://example.com/mcp" },
    "off": { "type": "stdio", "command": "x", "enabled": false }
  }
}
```

- `type`：`stdio` | `http`（Streamable HTTP）| `sse`。
- `enabled: false` → **disabled** 态：不连接、不注入工具、`/mcp` 显示 ⛔。
- `preconnect: true`（顶层，默认 false）：启动即全量连接所有 server。高级选项——默认按需连接更省资源与 token。

> 为什么放 `.run-agent/`：项目级私有配置目录已在那里（记忆同址）；配置是用户写的，agent 工具读不到（`.run-agent` 段内置 deny）。

## 连接状态机

每 server 四态（roadmap 点名）：

| 状态         | 含义                                                          | 图标 |
| ------------ | ------------------------------------------------------------- | ---- |
| `connected`  | 已连接、工具已注册                                            | ✓    |
| `failed`     | 连接失败（stdio spawn 失败 / http 连不上 / 超时），带错误消息 | ✗    |
| `needs-auth` | http/sse 401（需补 token/重授权）                             | 🔑   |
| `disabled`   | `enabled:false`                                               | ⛔   |

初始（从未连接）= `failed` + "未连接"。连接 **memoized**：`onclose` 清缓存，server 断开后下次 `connect` 自动重连。

## 按需连接：`mcp_connect` 工具

- 默认不预连。system prompt 动态段注入一行：`MCP servers 已配置: filesystem(stdio), github(http) — 调 mcp_connect <name> 连接`。
- `mcp_connect(server)`：连接 → `tools/list` → 把每个工具包装成标准 `Tool` 注册进池 → 返回工具清单（名 + desc 截断 120 字符预览）。
- **免确认**：用户写好配置 = 已授权；项目级配置仅 Trust 加载是第二道门。连接是配置动作，不是逐次工具调用。
- 连接后 **下一轮请求** 起模型即可调用 `mcp__<server>__<tool>`（工具列表每轮从池里重建，天然动态）。
- plan 模式下 `mcp_connect` **deny**（连接会 spawn 子进程/开网络会话，plan 强制只读；连接是计划外的副作用）。

## 工具包装规则

`mcp__<server>__<tool>` 命名（server/tool 名小写、非 `[a-z0-9_]` → `_`）：

- **desc 截断 2048**：防 OpenAPI 生成 server 的 15–60KB desc 灌爆上下文。
- **懒 schema**：`inputSchema = z.record(z.string(), z.unknown())`，JSON Schema 输出 `{ type: "object" }`——不为每个工具传输/维护完整 zod schema，入参校验完全交给 server 自身。这就是「延迟加载工具 schema 省 token」。
- **`isConcurrencySafe = annotations.readOnlyHint === true`**：只读标注的工具可并行，其余串行（走 `src/core/execute.ts` 分区）。
- **内置优先**：`mcp__server__tool` 与内置 `read_file` 等天然不撞名；装配顺序「内置 + MCP 追加在后」，同名不覆盖（内置永远赢）。
- 调用把 server 的 text content 拼回 `tool_result`；`isError` / 调用异常一律字符串回填（不 throw，loop 语义不变）。

## 权限：MCP 工具走同一管线

`hasPermissionsToUseTool` 新增第 7 参 `readOnlyNames`（缺省 = 内置只读，语义不变）。REPL 装配时传合并闭包：内置只读 ∪ `explore` ∪ MCP readOnlyHint 名。

| 工具               | default               | acceptEdits | plan     |
| ------------------ | --------------------- | ----------- | -------- |
| MCP 只读 hint 工具 | cwd 内 allow / 外 ask | 同左        | allow    |
| MCP 非只读工具     | **ask**（逐次确认）   | allow       | **deny** |
| `mcp_connect`      | allow（免确认）       | allow       | deny     |

## 信任边界（必须读）

MCP 工具的**参数是 server 内部黑盒**：run-agent 的 `inputPath` / `pathInCwd` / 危险目录检查都建立在「工具入参里能认出路径参数」上，而 MCP 工具的参数 schema 由 server 定义、run-agent 不解析。例如 filesystem server 的 `read_file` 读到 `~/.ssh/id_rsa`，run-agent 的管线**看不见**这个 path。

这不是缺陷，是 MCP 协议分层下工具接入的固有形态（Claude Code 同样不解析 MCP 工具参数）。缓解：

1. **非只读 MCP 工具 default 必 ask**——用户逐次确认。
2. **只读 hint 才免确认**。
3. **只连可信 server**。MCP server 的权限语义 = server 自身语义 + run-agent 工具级确认，不承诺 server 内部的路径/命令校验。
4. 项目级 `mcp.json` 仅 Trust 加载。

## REPL 命令

```
/mcp                列出已配置 server 与状态（✓ / ✗ / 🔑 / ⛔）
/mcp connect <name> 手动连接/重连
```

## 明确不做

resources / prompts / 采样 / 完整 schema 传输、批量预连缓存、MCP 工具参数的路径级白黑名单——见 `docs/Plan_V5.md` §0「不做的事」。

## 本地验证

用仓库内示例 server 验证端到端：

```bash
# 1. 起示例 stdio server（任意位置）
node examples/mcp-server/index.js

# 2. 配用户级 mcp.json
mkdir -p ~/.config/run-agent
cat > ~/.config/run-agent/mcp.json <<'EOF'
{ "servers": { "demo": { "type": "stdio", "command": "node", "args": ["<abs-path>/examples/mcp-server/index.js"] } } }
EOF

# 3. 进 REPL
run-agent

# 4. 连接并调用
> /mcp            # 应看到 demo (failed) — 未连接
> /mcp connect demo   # ✓ 已连接，注册 1 个工具
> demo 的 read 工具试试（下一轮起模型即可调 mcp__demo__<tool>）
```

详见 [examples/mcp-server/README](../examples/mcp-server/README.md)。
