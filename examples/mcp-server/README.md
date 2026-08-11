# MCP 示例 server

最小 stdio MCP server，供本地验证 run-agent 的按需连接端到端链路。无真实 I/O 副作用。

## 暴露的工具

| 工具        | 说明                | 只读标注                              |
| ----------- | ------------------- | ------------------------------------- |
| `echo`      | 原样返回给定文本    | ✅（连上后 plan 模式可用、可并行）    |
| `timestamp` | 返回当前 ISO 时间戳 | ❌（示范：default 必 ask、plan deny） |

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

2. 进 REPL，`/mcp` 应看到 `demo`（未连接）：

   ```
   run-agent> /mcp
   MCP servers:
     ✗ demo (failed) — 未连接（调 mcp_connect 连接）
   ```

3. 连接并调用：

   ```
   run-agent> /mcp connect demo
   ✓ 已连接 demo，注册 2 个工具
   ```

   之后让模型调 `mcp__demo__echo` / `mcp__demo__timestamp`（连接后下一轮起可用）。

## 权限观察点

- `echo` 带 `readOnlyHint` → default 下免确认；`timestamp` 非只读 → default 必 ask。
- plan 模式下：`echo` allow、`timestamp` deny、`mcp_connect` deny。

详见 [docs/mcp.md](../../docs/mcp.md)。
