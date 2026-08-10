# Run Agent · V1「ReAct MVP + 多提供商」实施方案

> 上游总计划：`Plan.md`（§五 V1 章节 + 附版本节奏表）
> 目标：**终端里用自然语言让 agent 改一个真实文件并跑通测试；这是第一个对外可安装的 release `0.1.0`。**
> 工期参考：2~3 周 ｜ 里程碑拆 3 个（M1 提供层 / M2 loop+工具 / M3 REPL+发布）

---

## 0. 结论速览

**交付什么**：`npm install -g run-agent` 后——

1. `run-agent "把 README 里的 X 改成 Y"` 能自己读文件 → 改文件 → 跑测试 → 汇报；
2. 三种模型来源跑通：**Anthropic / DeepSeek(OpenAI 兼容) / Ollama**；
3. `run-agent --resume` 能续接上次会话。

**技术栈增量**：`@anthropic-ai/sdk`（已有）＋ `openai` ＋ `zod` ＋ readline（Node 内置，不引第三方 REPL 库）。

**不做的事**（留给 V2+）：权限审批/Trust、工具并发、compact、CLAUDE.md、repo map、MCP、Hooks、多 agent、TUI。

---

## 1. 架构决策（V0 交接 → V1 落地）

### 1.1 内部统一消息格式（LLM 无关，全项目唯一真相）

```ts
// src/providers/types.ts 扩展
type Role = "user" | "assistant" | "system" | "tool";
type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };
type ToolResultBlock = { type: "tool_result"; tool_use_id: string; content: string };
type ContentBlock = { type: "text"; text: string } | ToolUseBlock;
type LLMMessage = { role: Role; content: string | ContentBlock[] };
```

> 对齐 Anthropic 的 `tool_use`/`tool_result` block 作为**内部格式**。OpenAI 适配器负责 `tool_calls`/`tool` role ↔ 内部格式互转——差异只在适配层，loop 层只见内部格式。

### 1.2 LLMClient 接口（V1 重构）

```ts
type StreamEvent =
  | { type: "text"; text: string } // 增量文本
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "done"; stopReason: "end_turn" | "tool_use" | "max_tokens" | "error" };

interface LLMClient {
  readonly provider: string;
  stream(
    messages: LLMMessage[],
    opts?: { tools?: ToolSpec[]; maxTokens?: number },
  ): AsyncIterable<StreamEvent>;
}
```

- **流式是必须的**（REPL 逐 token 渲染），非流式 `chat()` 退化为 `stream()` 的消费者。
- `ToolSpec = { name; description; inputSchema: JSONSchema }`——zod 侧不直接进接口，转换在工具注册层做。

### 1.3 适配器矩阵（一个 baseURL 覆盖一族）

| 适配器                    | 实现                                            | 覆盖                                              |
| ------------------------- | ----------------------------------------------- | ------------------------------------------------- |
| `AnthropicAdapter`        | `@anthropic-ai/sdk` 原生 tool_use               | Claude                                            |
| `OpenAIAdapter`           | `openai` 包 function calling                    | GPT / 官方端点                                    |
| `OpenAICompatibleAdapter` | **复用 OpenAI 适配器逻辑 + `baseURL` 覆盖**     | **DeepSeek / Qwen / vLLM / 本地推理**（最大杠杆） |
| `OllamaAdapter`           | `openai` 包指向本地 `http://localhost:11434/v1` | 本地 Ollama                                       |

> 实现上 OpenAICompatible 与 Ollama 都是"OpenAI SDK + baseURL 指向别处"，可合并为一个带默认 baseURL 的适配器，配置层决定指向哪。**约 1.5 个适配器实现覆盖三大类。**

### 1.4 工具接口（V1 定版，MCP/skill/子 agent 全复用）

```ts
// src/tools.ts
interface Tool {
  name: string;
  description: string;
  inputSchema: z.ZodType; // zod 校验 → 转 JSONSchema 给模型
  call(input: unknown): Promise<{ result: string; artifacts?: string[] }>;
}
```

### 1.5 Agent loop（`src/core/query.ts`，保持极简 200~400 行）

```
while(true):
  events = client.stream(messages, { tools })
  收集 text 增量（透传给 stdout）与 tool_use blocks
  stopReason == "end_turn" → 结束
  stopReason == "tool_use" →
    按顺序执行工具（写入 messages: tool_result）
    循环继续
  max_tokens / error → 按错误类型恢复（重试 / 截断重试）
```

### 1.6 配置系统（`src/config/`）

优先级：**CLI flag > 环境变量 > 配置文件 > 默认值**。文件 `~/.config/run-agent/config.json`，示例：

```json
{
  "provider": "openai-compatible",
  "model": "deepseek-chat",
  "baseURL": "https://api.deepseek.com/v1",
  "apiKeyEnv": "DEEPSEEK_API_KEY"
}
```

也支持 `.env`（Node 20.6+ 的 `--env-file` 或手写极简 loader）。

### 1.7 跨平台 Bash（`src/tools/bash/`）

- `ShellProvider` 抽象：检测平台 → Windows 用 `powershell.exe -NoProfile -Command`，macOS/Linux 用 `bash -lc`；可被 `SHELL`/配置覆盖。
- 每次调用：**默认 120s 超时 + 输出截断 30k 字符**（超长落盘提示）+ 错误时回填 stderr。
- `cwd` 默认项目根；路径统一 `node:path` 规范化。

### 1.8 会话持久化（`src/utils/sessionStorage.ts`）

- 逐行 JSONL 追加：`~/.local/share/run-agent/sessions/<ts>-<id>.jsonl`（或项目内 `.run-agent/`，配置可选）。
- 每行 = 一个内部消息（LLMMessage 直接序列化，保证 `--resume` 时原样回放）。
- `--resume`：读最后一条会话文件 → 重建 messages → 续接。

---

## 2. 里程碑 M1 —— LLM 抽象层 + 配置（先做，解锁一切）

**文件**：

```
src/providers/types.ts        # 重写：统一消息格式 + StreamEvent + ToolSpec
src/providers/openai.ts       # OpenAIAdapter（含 function calling 互转）
src/providers/openai-compatible.ts  # baseURL 覆盖 → DeepSeek/Qwen/本地
src/providers/anthropic.ts    # 升级：流式 + tool_use
src/config/index.ts           # 配置解析（flag>env>file>default）
src/config/load.ts            # 配置文件 + .env 加载
tests/providers/openai.test.ts    # mock SDK：function calling 互转
tests/config.test.ts          # 优先级矩阵
```

**M1 验收**：4 个适配器能 mock 出 streaming + tool_use；配置优先级矩阵测试绿。

## 3. 里程碑 M2 —— Agent loop + 内置工具（V1 的心脏）

**文件**：

```
src/tools.ts                  # Tool 接口 + 注册表 + zod→JSONSchema
src/tools/read.ts  write.ts  edit.ts  glob.ts  grep.ts
src/tools/bash/shell.ts       # ShellProvider
src/tools/bash/index.ts       # Bash 工具（超时/截断/后台）
src/core/query.ts             # agent loop
tests/core/query.test.ts      # mock LLM 的 golden 场景：单轮→工具→完成
tests/tools/edit.test.ts      # 精确字符串替换边界
tests/tools/bash.test.ts      # 简单命令 + 超时
```

**M2 验收**：mock LLM 驱动的 loop 集成测试绿；Edit/Bash 工具单测绿；用真实模型能改一个文件。

## 4. 里程碑 M3 —— REPL + 持久化 + 发布

**文件**：

```
src/cli/index.ts              # 重写：readline REPL + 流式渲染 + 工具执行展示
src/cli/repl.ts               # 主循环
src/utils/sessionStorage.ts   # JSONL 会话
tests/cli.test.ts             # 更新：--resume / --provider 冒烟
```

**M3 交付**：

- README 补全：三 OS 快速开始、多提供商配置表（Anthropic/DeepSeek/Ollama 示例）、特性、截图（占位）。
- `CHANGELOG.md` 记 `0.1.0`；`package.json` 版本 `0.1.0`；打 tag `v0.1.0`。
- 三 OS CI 全绿 + `npm pack` 检查。
- 端到端：三种模型来源各跑通一次真实调用（本地手动，需 key）。

---

## 5. V1 验收清单（DoD）

> 状态截至 2026-08-10：代码与测试全部完成；带 `(需真实 key)` 的项需用户本地手动验证。

- [x] 代码就绪：`npm install -g run-agent` + README 快速开始即可用（待发版验证）
- [ ] 三种模型来源（Anthropic / DeepSeek / Ollama）都跑通一次 agent loop（需真实 key，本地手动）
- [x] loop 集成测试（mock LLM）绿；Edit/Bash/Glob/Grep 工具单测绿
- [x] `--resume` 能续接会话（sessionStorage 单测）；`--provider/--model/--base-url` 命令行切换生效
- [ ] CI 三 OS × 3 Node 全绿（推送到远端后验证）；`npm pack` tarball 干净（dry-run 已验证）
- [x] CHANGELOG 记 `0.1.0`；package.json 版本 `0.1.0`；`v0.1.0` tag 待推送后打

## 6. 风险与注意

1. **OpenAI 兼容的 tool_use 差异**：DeepSeek 等对 `tools` 参数、`tool_choice`、strict schema 支持不一——先按 OpenAI 官方函数调用格式实现，遇兼容问题逐个绕过（如 DeepSeek 早期不支持并行 tool call，就一次一个）。
2. **流式下的 tool_use**：OpenAI 流式把 tool_calls 按 delta 分片传，需要**跨 chunk 聚合 name/arguments**——这是适配器最容易写错的地方，单测重点。
3. **Windows 路径与编码**：Edit/Write 涉及文件编码（默认 utf8，BOM 处理）；Bash 用 PowerShell 时输出编码坑（`$OutputEncoding`），CI 里用简单命令兜底。
4. **zod→JSONSchema**：模型对 schema 里的 `additionalProperties`/`strict` 敏感；V1 先不引 `zod-to-json-schema`，手写一个 50 行的转换器覆盖常见类型（string/number/boolean/enum/array/object），避免多一个依赖。
5. **token 预算**：loop 无 compact（V3 才有），V1 设 `maxTokens` 默认值和错误恢复即可，不追求长会话。
6. **测试隔离**：loop 测试必须注入 mock LLM（确定性），绝不依赖真实 API key；OpenAI 兼容集成测试用本地 mock HTTP server。

---

## 7. V1 → V2 交接

**V1 结束时的代码状态**：

```
src/core/query.ts          ← 极简 agent loop（工具回填、错误重试预留）
src/tools/                 ← Tool 接口 + 6 个内置工具（写工具不检查权限，V2 加）
src/providers/             ← 4 适配器（统一内部消息格式）
src/config/                ← 配置系统
src/utils/sessionStorage.ts← JSONL 会话
```

**为 V2 预留的扩展点**：

- **权限管线占位**：工具调用处留 `checkPermissions(tool, input)` 调用点（V2 实现为 allow 直通，避免重构）。
- **`isConcurrencySafe`**：Tool 接口已含该字段，V2 的并发调度直接消费。
- **错误恢复**：loop 的 max_tokens/工具异常分支已回填 tool_result，V2 细化重试策略。
- **SECURITY.md / Trust 对话**：V2 新增。
