# 架构

> 现状：V6（0.6.0，已交付：Hooks + Skills + 自定义命令 + Headless）。
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
│   │   ├── index.ts            # Commander 入口：flag 解析 → 配置 → 会话 → 分发（装配 MCP manager；
│   │   │                       #   headless：--print/--json/--max-turns → runHeadless JSON 契约）
│   │   └── repl.ts             # 主循环：runOneShot + 交互式 REPL（/plan、/mcp、/compact、
│   │                           #   /skills、/commands、added 契约 + hooks 回调装配）
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
│   │   ├── mcp/                # MCP 客户端：config（用户+Trust 项目合读）/ manager（状态机 4 态 + 按需连接）
│   │   │                       #   tool（包装：命名/截断 2048/懒 schema/readOnlyHint）/ mcp_connect（工具工厂）
│   │   ├── hooks/              # V6 Hooks：config（settings.json 用户+Trust 项目合读）/ manager（五类事件
│   │   │                       #   PreToolUse/PostToolUse/SessionStart/SessionEnd/Stop × execCommand/execHttp）
│   │   ├── skills/             # V6 Skills：loader（frontmatter 扫描 + Trust 门控 + readSkillBody
│   │   │                       #   惰性读 body）/ skill_tool（SkillRegistry + SkillTool 激活 + 过滤）
│   │   └── commands/           # V6 自定义命令：loader（prompt/local 两形态）/ exec（模板展开 + 脚本运行）
│   ├── tools.ts                # Tool 接口 + 注册表 + zod→JSONSchema 转换
│   ├── tools/                  # 13 个内置工具（read/write/edit/glob/grep/bash/remember/repo_map/explore/verify
│   │                           #   + plan 导航 enter/exit_plan_mode + SkillTool V6）+ 动态 MCP 工具（mcp__server__tool）
│   └── utils/
│       ├── errors.ts           # RunAgentError
│       └── sessionStorage.ts   # JSONL 会话持久化（含压缩边界重置点）
├── tests/                      # vitest（41 文件 / 387 用例，含 headless 集成测试）
└── dist/                       # tsup 打包产物（git 忽略）
```

## 分层与数据流

```
cli (入口：参数 → 配置 → 会话文件 → systemCtx/contextWindow → 装配 MCP manager + hooks/skills/commands)
  └── core/query.ts (agent loop：只认统一 LLMMessage；工具池每轮重建——函数型 tools 支持动态注入)
        ├── core/context.ts    (system 组装：角色准则 + CLAUDE.md 记忆 + 日期/git 动态段 + MCP server 提示
        │                       + 技能清单 + Stop hook 注入段)
        ├── core/compact.ts    (token 估算超阈值 → 摘要 → 边界消息；超大结果指针化)
        ├── providers (适配器：统一格式 ↔ 各家协议互转，差异止步于此)
        ├── tools (Tool 接口；zod schema → JSON Schema 暴露给模型)
        └── services (McpManager：按需连接 mcp_connect → 包装 mcp__server__tool 进池，同一权限管线；
                      HookManager：五类事件挂命令/HTTP，PreToolUse 可覆盖判定（engine deny 不可放行）；
                      SkillRegistry + SkillTool：加载技能、allowed-tools 过滤；CommandRegistry：prompt/local 命令)
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
- **V6 可编程化一律走自有路径**（无 `.claude/`）：用户级 `~/.config/run-agent/`、项目级
  `.run-agent/`（仅 Trust 加载）。项目级 Hooks/Skills/Commands 都经 fs 直读（`.run-agent`
  是内置 deny 段），模型没有工具能偷看，防提示注入。
- **headless JSON 契约**：`--print` + `--json` → stdout 只有 JSON（人类日志去 stderr）；
  工具轨迹 `tools[]` 记录时截断 2000 字符；退出码 0 成功 / 1 出错；收尾用
  `process.exitCode` + 自然退出（Windows libuv 下 `process.exit()` 会断言崩溃，见
  [Bug_V6.md](Bug_V6.md)）。

## 扩展点

| 位置                     | 扩展内容                                                                          |
| ------------------------ | --------------------------------------------------------------------------------- |
| `src/services/hooks/`    | 新事件类型（Notification/SubagentStop 等）、hook 输出回喂模型（当前 Stop 仅注入） |
| `src/services/skills/`   | SkillTool 子 agent 化 → V7（当前为主循环内注入 + allowed-tools 过滤近似）         |
| `src/services/commands/` | local-jsx 形态（React/Ink 渲染）→ V8 TUI；local 命令输出自动回喂模型              |
| `src/core/query.ts`      | catch 分支接 0.3.1 反应式压缩（prompt_too_long → 强制 compact）                   |
| `src/core/compact.ts`    | 0.3.1 硬截断 `hardTruncateToFit` / 孤儿 tool 修复 `normalizeToolPairing`          |
| `src/core/context.ts`    | managed 级记忆内容由后续版本填充；语义索引 → V5（repo_map 已随 0.4.1 落地）       |
| `src/tools.ts`（`Tool`） | 新工具实现同一接口即可接入，写类工具显式 `isConcurrencySafe: false`               |
| `src/providers/`         | 新适配器遵循同一 `LLMClient` 接口即可接入                                         |
| `src/services/mcp/`      | 新 MCP 传输/能力（resources/prompts、preconnect 缓存）后续版本加入                |
| `src/core/execute.ts`    | V7 任务级/后台并发（Agent 工具泛化）在 StreamingToolExecutor 之上叠加             |
| `src/cli/repl.ts`        | session 切换 UI、TUI 从后续版本逐步加入                                           |

V4.5 交接见 [Plan_V4.5.md](Plan_V4.5.md)；M2 交接见 [Plan_V5.md](Plan_V5.md)；V6 交接见 [Plan_V6.md](Plan_V6.md)。
