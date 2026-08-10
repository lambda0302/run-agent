# 架构

> 现状：V1（0.1.0）。分层、统一消息格式、配置、会话持久化的演进见 [Plan_V1.md](Plan_V1.md) 与 [Plan.md](Plan.md)。

## 目录结构

```
run-agent/
├── .github/workflows/ci.yml    # 三 OS × Node 20/22/24
├── docs/                       # 文档与路线图
├── src/
│   ├── cli/
│   │   ├── index.ts            # Commander 入口：flag 解析 → 配置 → 会话 → 分发
│   │   └── repl.ts             # 主循环：单次执行 runOneShot + 交互式 REPL runRepl
│   ├── config/
│   │   ├── index.ts            # 配置合并（flag > env > file > default）+ resolveApiKey
│   │   └── load.ts             # 极简 .env 加载器
│   ├── core/query.ts           # ReAct agent loop
│   ├── providers/              # LLM 抽象与适配器
│   │   ├── types.ts            # 统一消息格式 + LLMClient + StreamEvent + ToolSpec
│   │   ├── index.ts            # createClient 工厂
│   │   ├── anthropic.ts        # Anthropic 适配器（流式 tool_use）
│   │   ├── openai.ts           # OpenAI + OpenAI 兼容共享实现（function calling 互转）
│   │   ├── ollama.ts           # Ollama（OpenAI SDK 指向本地 /v1）
│   ├── tools.ts                # Tool 接口 + 注册表 + zod→JSONSchema 转换
│   ├── tools/                  # 6 个内置工具（read/write/edit/glob/grep/bash）
│   └── utils/
│       ├── errors.ts           # RunAgentError
│       └── sessionStorage.ts   # JSONL 会话持久化
├── tests/                      # vitest（55 用例）
└── dist/                       # tsup 打包产物（git 忽略）
```

## 分层与数据流

```
cli (入口：参数 → 配置 → 会话文件)
  └── core/query.ts (agent loop：只认统一 LLMMessage)
        ├── providers (适配器：统一格式 ↔ 各家协议互转，差异止步于此)
        └── tools (Tool 接口；zod schema → JSON Schema 暴露给模型)
```

- **统一内部消息格式**：`LLMMessage` 对齐 Anthropic 的 `tool_use`/`tool_result` block；
  OpenAI 的 `tool_calls`/`tool role` 在适配器内互转，loop 层只见统一格式。
- **流式是唯一形态**：`LLMClient.stream()` 发射 `text`/`tool_use`/`done` 事件；非流式对话是 stream 的消费者。
- **工具即函数**：`Tool = { name, description, inputSchema: zod, call }`。zod 校验入参，
  注册时经 `zodToJsonSchema`（手写，零依赖）转成 JSON Schema 给模型。

## 关键约定

- 全 ESM；`tsc --noEmit` 只做类型检查，产物统一由 tsup 打包为 `dist/cli.js`。
- `exactOptionalPropertyTypes` 下，可选属性一律用条件 spread 加入对象。
- 配置优先级恒定：`CLI flag > 环境变量 > ~/.config/run-agent/config.json > 默认值`。
- 会话逐行 JSONL 追加；`--resume` 读取最新会话文件原样回放。

## V2 扩展点

| 位置                     | 扩展内容                                            |
| ------------------------ | --------------------------------------------------- |
| `src/core/query.ts`      | 工具执行处预留权限管线；错误重试策略细化            |
| `src/tools.ts`（`Tool`） | `isConcurrencySafe` 字段已就位，V2 并发调度直接消费 |
| `src/providers/`         | 新适配器遵循同一 `LLMClient` 接口即可接入           |
| `src/cli/repl.ts`        | TUI、Hooks、MCP、compact 从 V2/V3 逐步加入          |

详见 [Plan_V1.md §7 V1 → V2 交接](Plan_V1.md)。
