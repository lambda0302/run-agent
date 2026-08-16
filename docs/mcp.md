# MCP（Model Context Protocol）接入

V5 里程碑 2。run-agent 通过 [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) 接入 MCP server，把 server 暴露的工具接入标准 `Tool` 管线：**同一权限引擎、同一并发调度、同一 token 预算**。

设计目标（对齐 roadmap「接入标准协议生态」，但机制刻意简化）：

- **启动预连**：启动即连接所有 enabled server、listTools 注册工具，第一轮起模型即可调用。连接失败/401 非致命，各自进 `failed`/`needs-auth` 态，可 `/mcp connect <name>` 手动重连。
- **全量 schema**：连接时保留 server 的完整 JSON Schema，注入工具 spec 让模型看到真实入参结构（跳过 `{type:"object"}` 占位）；入参校验仍交给 server 自身。
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
    "github": { "type": "http", "url": "https://api.githubcopilot.com/mcp/", "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" } },
    "example-sse": { "type": "sse", "url": "https://example.com/mcp" },
    "off": { "type": "stdio", "command": "x", "enabled": false }
  }
}
```

- `type`：`stdio` | `http`（Streamable HTTP）| `sse`。
- `headers`（仅 http/sse）：自定义请求头（认证等），值支持 **`${ENV_VAR}` 展开**——token 不落明文，运行时从进程环境取；未设置的环境变量展开为空串（服务器 401 即暴露，走 `needs-auth` 态）。stdio 不需要：`env` 直接传给子进程。
- `enabled: false` → **disabled** 态：不连接、不注入工具、`/mcp` 显示 ⛔。
- 启动即预连所有 `enabled` server（配置驱动，无需额外字段）；连接失败/401 各自进 `failed`/`needs-auth` 态，不阻断启动，可 `/mcp connect <name>` 手动重连。

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

## 启动预连

- 启动即连接所有 `enabled` server（配置驱动，无手动/按需模式）。动态上下文块注入一行（V8.3 起在 messages、随每轮用户 query 前插入，不再进 system）：`MCP servers 已配置: filesystem(stdio), github(http) — 启动即连接，其工具可直接以 mcp__<server>__<tool> 调用（连接失败的 server 可让用户用 /mcp 查看并用 /mcp connect 重连）`。
- 连接成功 → `tools/list` → 每个工具包装成标准 `Tool` 注册进池，**第一轮起**模型即可调用 `mcp__<server>__<tool>`（工具列表每轮从池里重建，天然动态）。
- 连接失败/401 **不阻断启动**：各自进 `failed`/`needs-auth` 态；用户可 `/mcp connect <name>` 手动重连。
- 连接是配置动作：用户写好配置 = 已授权；项目级配置仅 Trust 加载是第二道门。连接不是逐次工具调用，无需单独的工具级权限。

## 工具包装规则

`mcp__<server>__<tool>` 命名（server/tool 名小写、非 `[a-z0-9_]` → `_`）：

- **desc 截断 2048**：防 OpenAPI 生成 server 的 15–60KB desc 灌爆上下文。
- **全量 schema**：连接时保留 server 的完整 JSON Schema（`jsonSchema`），工具 spec 生成优先直发——模型可见真实入参结构（跳过 `{type:"object"}` 占位）。缺省（server 没给 schema）才回退 `inputSchema = z.record(z.string(), z.unknown())`，JSON Schema 输出 `{ type: "object" }`。入参校验仍完全交给 server 自身。
- **`isConcurrencySafe = annotations.readOnlyHint === true`**：只读标注的工具可并行，其余串行（走 `src/core/execute.ts` 分区）。
- **内置优先**：`mcp__server__tool` 与内置 `read_file` 等天然不撞名；装配顺序「内置 + MCP 追加在后」，同名不覆盖（内置永远赢）。
- 调用把 server 的 text content 拼回 `tool_result`；`isError` / 调用异常一律字符串回填（不 throw，loop 语义不变）。

## 权限：MCP 工具走同一管线

MCP 工具参数是 server 内部黑盒，run-agent 不解析——**三模式一律 `ask`**（V8 决策）。即使 server 标注 `readOnlyHint` 也不再免确认：外部工具不可信分级，每次调用都由用户显式确认。判定顺序里 MCP-ask 位于 plan 分支且先于只读判定（plan 下同样 ask）；headless `canPrompt=false` 时 ask 降级 deny。`readOnlyHint` 现在只影响**并发调度**（`isConcurrencySafe`），不再进权限判定。

| 工具          | default               | acceptEdits | plan     |
| ------------- | --------------------- | ----------- | -------- |
| MCP 工具      | **ask**（逐次确认）   | **ask**     | **ask**  |

用户 `permissions.json` 的 deny 规则仍作用于 MCP 工具（先于一切放行）。default/acceptEdits 下 allow 规则可显式放行特定 MCP 工具（用户手写的窄授权，区别于模式级隐式放行）；plan 下 MCP 一律 ask。

## 信任边界（必须读）

MCP 工具的**参数是 server 内部黑盒**：run-agent 的 `inputPath` / `pathInCwd` / 危险目录检查都建立在「工具入参里能认出路径参数」上，而 MCP 工具的参数 schema 由 server 定义、run-agent 不解析。例如 filesystem server 的 `read_file` 读到 `~/.ssh/id_rsa`，run-agent 的管线**看不见**这个 path。

这不是缺陷，是 MCP 协议分层下工具接入的固有形态（Claude Code 同样不解析 MCP 工具参数）。缓解：

1. **MCP 工具三模式一律 ask**——用户逐次确认（default/acceptEdits/plan）。
2. **不依赖 `readOnlyHint` 免确认**（V8）：外部工具黑盒，hint 只用于并发调度，不降低权限门槛。
3. **只连可信 server**。MCP server 的权限语义 = server 自身语义 + run-agent 工具级确认，不承诺 server 内部的路径/命令校验。
4. 项目级 `mcp.json` 仅 Trust 加载。

## REPL 命令

```
/mcp                列出已配置 server 与状态（✓ / ✗ / 🔑 / ⛔）
/mcp connect <name> 手动连接/重连
```

## 明确不做

resources / prompts / 采样、批量预连缓存、MCP 工具参数的路径级白黑名单——见 `docs/Plan_V5.md` §0「不做的事」。

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

# 4. 调用（demo 启动时已预连）
> /mcp            # 应看到 demo ✓ 已连接，注册 2 个工具
> 让模型调 mcp__demo__echo / mcp__demo__timestamp（第一轮起即可）
```

详见 [examples/mcp-server/README](../examples/mcp-server/README.md)。
