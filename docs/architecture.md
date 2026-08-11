# 架构

> 现状：V3（0.3.2）。分层、统一消息格式、配置、会话持久化的演进见各版本计划与 [Plan.md](Plan.md)。

## 目录结构

```
run-agent/
├── .github/workflows/ci.yml    # 三 OS × Node 20/22/24
├── docs/                       # 文档与路线图
├── src/
│   ├── cli/
│   │   ├── index.ts            # Commander 入口：flag 解析 → 配置 → 会话 → 分发
│   │   └── repl.ts             # 主循环：runOneShot + 交互式 REPL（/compact、added 契约）
│   ├── config/
│   │   ├── index.ts            # 配置合并（flag > env > file > default）+ resolveApiKey + contextWindow
│   │   └── load.ts             # 极简 .env 加载器
│   ├── core/
│   │   ├── query.ts            # ReAct agent loop（system 注入 + 主动压缩 + 指针化）
│   │   ├── context.ts          # token 估算 + git 上下文 + CLAUDE.md 四级记忆 + buildSystemPrompt
│   │   ├── compact.ts          # 压缩：阈值/摘要/边界消息/文件重挂/超大结果指针化
│   │   └── execute.ts          # 只读并行（上限 10）/ 写串行调度，结果按原顺序回填
│   ├── permissions/            # 权限引擎：engine / prompt / store / types
│   ├── providers/              # LLM 抽象与适配器
│   │   ├── types.ts            # 统一消息格式 + LLMClient + StreamEvent + ToolSpec
│   │   ├── index.ts            # createClient 工厂
│   │   ├── anthropic.ts        # Anthropic 适配器（流式 tool_use）
│   │   ├── openai.ts           # OpenAI + OpenAI 兼容共享实现（function calling 互转）
│   │   └── ollama.ts           # Ollama（OpenAI SDK 指向本地 /v1）
│   ├── tools.ts                # Tool 接口 + 注册表 + zod→JSONSchema 转换
│   ├── tools/                  # 10 个内置工具（read/write/edit/glob/grep/bash/remember/repo_map/explore/verify）
│   └── utils/
│       ├── errors.ts           # RunAgentError
│       └── sessionStorage.ts   # JSONL 会话持久化（含压缩边界重置点）
├── tests/                      # vitest（215 用例）
└── dist/                       # tsup 打包产物（git 忽略）
```

## 分层与数据流

```
cli (入口：参数 → 配置 → 会话文件 → systemCtx/contextWindow)
  └── core/query.ts (agent loop：只认统一 LLMMessage)
        ├── core/context.ts    (system 组装：角色准则 + CLAUDE.md 记忆 + 日期/git 动态段)
        ├── core/compact.ts    (token 估算超阈值 → 摘要 → 边界消息；超大结果指针化)
        ├── providers (适配器：统一格式 ↔ 各家协议互转，差异止步于此)
        └── tools (Tool 接口；zod schema → JSON Schema 暴露给模型)
```

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

| 位置                     | 扩展内容                                                                 |
| ------------------------ | ------------------------------------------------------------------------ |
| `src/core/query.ts`      | catch 分支接 0.3.1 反应式压缩（prompt_too_long → 强制 compact）          |
| `src/core/compact.ts`    | 0.3.1 硬截断 `hardTruncateToFit` / 孤儿 tool 修复 `normalizeToolPairing` |
| `src/core/context.ts`    | managed 级记忆内容由后续版本填充；语义索引 → V5（repo_map 已随 0.4.1 落地）|
| `src/tools.ts`（`Tool`） | 新工具实现同一接口即可接入，写类工具显式 `isConcurrencySafe: false`      |
| `src/providers/`         | 新适配器遵循同一 `LLMClient` 接口即可接入                                |
| `src/cli/repl.ts`        | session 切换 UI、Hooks、MCP、TUI 从后续版本逐步加入                      |

0.3.1 交接见 [Plan_V3.md §7](Plan_V3.md)。
