# MCP 示例 server

最小 stdio MCP server，供本地验证 run-agent 的 MCP 接入端到端链路。无真实 I/O 副作用。

## 暴露的工具

| 工具        | 说明                | 只读标注                             |
| ----------- | ------------------- | ------------------------------------ |
| `echo`      | 原样返回给定文本    | ✅（仅并发调度：可并行）             |
| `timestamp` | 返回当前 ISO 时间戳 | ❌（串行；权限上三模式一律 ask）      |

## 运行

仓库根目录（`node_modules` 已含 `@modelcontextprotocol/sdk`）：

```bash
node examples/mcp-server/index.js
```

## 接入 run-agent

1. 配置用户级 `mcp.json`（server 名任意，这里叫 `demo`）：

   ```bash
   mkdir -p ~/.config/run-agent
   cat > ~/.config/run-agent/mcp.json <<EOF
   { "servers": { "demo": { "type": "stdio", "command": "node", "args": ["<仓库绝对路径>/examples/mcp-server/index.js"] } } }
   EOF
   ```

2. 进 REPL，`/mcp` 应看到 `demo`（启动已预连）：

   ```
   run-agent> /mcp
   MCP servers:
     ✓ demo (connected) — 已连接，注册 2 个工具
   ```

3. 直接让模型调 `mcp__demo__echo` / `mcp__demo__timestamp`（第一轮起可用）。

   若连接失败（server 未起来等），进 `failed` 态不阻断启动，用 `/mcp connect demo` 手动重连。

## 权限观察点

- `echo` 带 `readOnlyHint` → 仅**并发调度**（可并行），不再免确认——MCP 工具参数是 server 黑盒，
  **三模式一律 ask**（default/acceptEdits/plan 都逐次确认）。
- `timestamp` 非只读 → 串行；权限同样三模式一律 ask。

详见 [docs/mcp.md](../../docs/mcp.md)。
