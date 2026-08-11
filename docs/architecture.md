# 架构

> 现状：V5（0.5.0 实施中，M1 plan 模式 + M2 MCP 客户端 + M3 StreamingToolExecutor 已交付；M4 发布待做）。
> 分层、统一消息格式、配置、会话持久化的演进见各版本计划与 [Plan.md](Plan.md)。

## 目录结构

```
run-agent/
├── .github/workflows/ci.yml    # 三 OS × Node 20/22/24
├── docs/                       # 文档与路线图（mcp.md、plan-mode.md 见各版本）
├── examples/
│   └── mcp-server/             # 示例 stdio MCP server（本地验证按需连接链路）
├── src/
│   ├── cli/
│   │   ├── index.ts            # Commander 入口：flag 解析 → 配置 → 会话 → 分发（装配 MCP manager）
│   │   └── repl.ts             # 主循环：runOneShot + 交互式 REPL（/plan、/mcp、/compact、added 契约）
│   ├── config/
│   │   ├── index.ts            # 配置合并（flag > env > file > default）+ resolveApiKey + contextWindow
│   │   └── load.ts             # 极简 .env 加载器
│   ├── core/
│   │   ├── query.ts            # ReAct agent loop（system 注入 + 主动压缩 + 指针化；动态工具池）
│   │   ├── context.ts          # token 估算 + git 上下文 + CLAUDE.md 四级记忆 + buildSystemPrompt
│   │   ├── compact.ts          # 压缩：阈值/摘要/边界消息/文件重挂/超大结果指针化
│   │   └── execute.ts          # V5 StreamingToolExecutor：流式边执行（tool_use block 完整即入队），
│   │                           #   只读并行（上限 10）/ 写串行，结果按 index 重排回填
│   ├── permissions/            # 权限引擎：engine（含 plan 分支 + readOnlyNames）/ prompt / store / types
│   ├── providers/              # LLM 抽象与适配器
│   │   ├── types.ts            # 统一消息格式 + LLMClient + StreamEvent + ToolSpec
│   │   ├── index.ts            # createClient 工厂
│   │   ├── anthropic.ts        # Anthropic 适配器（流式 tool_use）
│   │   ├── openai.ts           # OpenAI + OpenAI 兼容共享实现（function calling 互转）
│   │   └── ollama.ts           # Ollama（OpenAI SDK 指向本地 /v1）
│   ├── services/
│   │   └── mcp/                # MCP 客户端：config（用户+Trust 项目合读）/ manager（状态机 4 态 + 按需连接）
│   │                           #   tool（包装：命名/截断 2048/懒 schema/readOnlyHint）/ mcp_connect（工具工厂）
│   ├── tools.ts                # Tool 接口 + 注册表 + zod→JSONSchema 转换
│   ├── tools/                  # 12 个内置工具（read/write/edit/glob/grep/bash/remember/repo_map/explore/verify
│   │                           #   + plan 导航 enter/exit_plan_mode）+ 动态 MCP 工具（mcp__server__tool）
│   └── utils/
│       ├── errors.ts           # RunAgentError
│       └── sessionStorage.ts   # JSONL 会话持久化（含压缩边界重置点）
├── tests/                      # vitest（306 用例）
└── dist/                       # tsup 打包产物（git 忽略）
```

## 分层与数据流

```
cli (入口：参数 → 配置 → 会话文件 → systemCtx/contextWindow → 装配 MCP manager)
  └── core/query.ts (agent loop：只认统一 LLMMessage；工具池每轮重建——函数型 tools 支持动态注入)
        ├── core/context.ts    (system 组装：角色准则 + CLAUDE.md 记忆 + 日期/git 动态段 + MCP server 提示)
        ├── core/compact.ts    (token 估算超阈值 → 摘要 → 边界消息；超大结果指针化)
        ├── providers (适配器：统一格式 ↔ 各家协议互转，差异止步于此)
        ├── tools (Tool 接口；zod schema → JSON Schema 暴露给模型)
        └── services/mcp (McpManager：按需连接 mcp_connect → listTools → 包装 mcp__server__tool 进池，
                          走同一权限管线 readOnlyNames 闭包)
```

- **动态工具池（V5 决策 B3）**：`RunQueryOptions.tools` 可为 `() => Tool[]`。query 每轮调用
  `getTools()` 重建工具 spec 与执行表，因此 `mcp_connect` 注册的 MCP 工具**下一轮请求**即可被模型调用。
- **流式即时执行（V5 决策 C）**：`src/core/execute.ts` 的 `StreamingToolExecutor` 让 tool_use block
  一完整就入队执行（不必等响应完结）——只读并行（上限 10）/ 写串行且不打断；流结束统一
  `getResults` 按 index 重排回填。transient 错误/反应式压缩路径先 drain 已启动的工具再重试。
- **MCP 工具**：命名 `mcp__<server>__<tool>`，desc 截断 2048、懒 schema（`{type:"object"}`）、
  `isConcurrencySafe = readOnlyHint`；权限与并发调度与内置工具同一管线（见 [mcp.md](mcp.md)）。

- **统一内部消息格式**：`LLMMessage` 对齐 Anthropic 的 `tool_use`/`tool_result` block；
  OpenAI 的 `tool_calls`/`tool role` 在适配器内互转，loop 层只见统一格式。
- **流式是唯一形态**：`LLMClient.stream()` 发射 `text`/`tool_use`/`done` 事件；非流式对话是 stream 的消费者。
- **工具即函数**：`Tool = { name, description, inputSchema: zod, call }`。zod 校验入参，
  注册时经 `zodToJsonSchema`（手写，零依赖）转成 JSON Schema 给模型。
- **持久化契约（added）**：`runQuery` 统一经 `pushConversation(m)` 同时进 `messages` 与 `added`；
  compact 边界消息也走 `added`。调用方 `messages = result.messages` + 逐条持久化 `result.added`。
- **system 不进返回/持久化**：`opts.system` 只拼进请求消息首条；`initial` 里的 system 被防御性过滤。

## 关键约定

- 全 ESM；`tsc --noEmit` 只做类型检查，产物统一由 tsup 打包为 `dist/cli.js`。
- `exactOptionalPropertyTypes` 下，可选属性一律用条件 spread 加入对象。
- 配置优先级恒定：`CLI flag > 环境变量 > ~/.config/run-agent/config.json > 默认值`。
- 会话逐行 JSONL 追加；`--resume` 读取最新会话文件，从**最后一个**压缩边界消息续起
  （无哨兵的旧会话回退全量加载）。

## 扩展点

| 位置                     | 扩展内容                                                                    |
| ------------------------ | --------------------------------------------------------------------------- |
| `src/core/query.ts`      | catch 分支接 0.3.1 反应式压缩（prompt_too_long → 强制 compact）             |
| `src/core/compact.ts`    | 0.3.1 硬截断 `hardTruncateToFit` / 孤儿 tool 修复 `normalizeToolPairing`    |
| `src/core/context.ts`    | managed 级记忆内容由后续版本填充；语义索引 → V5（repo_map 已随 0.4.1 落地） |
| `src/tools.ts`（`Tool`） | 新工具实现同一接口即可接入，写类工具显式 `isConcurrencySafe: false`         |
| `src/providers/`         | 新适配器遵循同一 `LLMClient` 接口即可接入                                   |
| `src/services/mcp/`      | 新 MCP 传输/能力（resources/prompts、preconnect 缓存）后续版本加入          |
| `src/core/execute.ts`    | V7 任务级/后台并发（Agent 工具泛化）在 StreamingToolExecutor 之上叠加       |
| `src/cli/repl.ts`        | session 切换 UI、Hooks、TUI 从后续版本逐步加入                              |

V4.5 交接见 [Plan_V4.5.md](Plan_V4.5.md)；M2 交接见 [Plan_V5.md](Plan_V5.md)。
