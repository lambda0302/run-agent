# 用法

> V6（0.6.0）：单条 prompt / 交互式 REPL + **headless（`--print` + `--json`）** + Hooks / Skills / 自定义命令。

## 安装

```bash
npm install -g @liyiyong/run-agent
```

需要 Node ≥ 20。

## 基本用法

```bash
run-agent --help
run-agent --version

# 单条 prompt（一次性执行）
run-agent "给 src/core/query.ts 加注释"

# 交互式 REPL（不带参数）
run-agent
```

## CLI 选项

| 选项                 | 说明                                                                              |
| -------------------- | --------------------------------------------------------------------------------- |
| `-p, --provider <p>` | `anthropic`（默认）/ `openai` / `openai-compatible` / `ollama`                    |
| `-m, --model <m>`    | 模型名，如 `claude-sonnet-5`、`deepseek-chat`、`gpt-4o-mini`                      |
| `-b, --base-url <u>` | API 端点（`openai-compatible` 必填；Ollama 默认指向 `http://localhost:11434/v1`） |
| `-k, --api-key <k>`  | 显式 API key（优先级最高）                                                        |
| `-r, --resume`       | 续接最近一次会话                                                                  |
| `--print <p>`        | headless：跑完这条 prompt 一次就退出（与位置参数 prompt 互斥）                    |
| `--json`             | headless 结构化输出：stdout 只出 JSON，人类日志去 stderr（需 `--print`）          |
| `--max-turns <n>`    | headless 的 ReAct 循环轮数上限（默认 25）                                         |

## 配置优先级

`CLI flag > 环境变量 > 配置文件 > 默认值`

### 环境变量

| 变量                                                                                                                                     | 用途         |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `ANTHROPIC_API_KEY`                                                                                                                      | Anthropic    |
| `OPENAI_API_KEY`                                                                                                                         | OpenAI       |
| `RUN_AGENT_PROVIDER` / `RUN_AGENT_MODEL` / `RUN_AGENT_BASE_URL` / `RUN_AGENT_API_KEY` / `RUN_AGENT_API_KEY_ENV` / `RUN_AGENT_MAX_TOKENS` | 覆盖对应配置 |

### 配置文件

`~/.config/run-agent/config.json`：

```json
{
  "provider": "openai-compatible",
  "model": "deepseek-chat",
  "baseURL": "https://api.deepseek.com/v1",
  "apiKeyEnv": "DEEPSEEK_API_KEY"
}
```

### `.env`

项目根目录的 `.env` 会被自动加载（极简 loader，支持 `KEY=VALUE` 行与 `#` 注释）。

## 提供商示例

```bash
# Anthropic
export ANTHROPIC_API_KEY=sk-ant-...
run-agent --provider anthropic --model claude-sonnet-5 "修复这个仓库的测试"

# DeepSeek（OpenAI 兼容）——无默认 key 变量，须指明 key 来源
run-agent --provider openai-compatible --base-url https://api.deepseek.com/v1 --model deepseek-chat --api-key sk-... "给函数加注释"
# 或配置 apiKeyEnv: "DEEPSEEK_API_KEY" 后 export DEEPSEEK_API_KEY=sk-...（见 README「设置 API key」）

# 本地 Ollama
ollama pull qwen2.5
run-agent --provider ollama --model qwen2.5 "介绍一下这个项目"
```

## REPL

不带参数运行 `run-agent` 进入交互式 REPL：

```
run-agent> 把 README 里 Hello 改成 Hi
⚡ read_file {"file_path":"README.md"}
└ read_file: ——— F:/MyClaudeCode/run-agent/README.md · 90 行 1-31 ———
📝 …（模型流式输出）…
run-agent> /help
```

- `/clear`：清空上下文 · `/compact`：压缩上下文
- `/plan`：进入只读计划模式 · `/mcp`：查看/连接 MCP server
- `/skills`：列出技能 · `/commands`：列出自定义命令（`/技能名`、`/命令名` 直接触发）
- `/help`：帮助 · `/exit` / `/quit`：退出

## 会话与续接

每次运行都会把内部消息逐行追加到 `~/.local/share/run-agent/sessions/<ts>-<id>.jsonl`。

```bash
run-agent --resume            # 续接最近会话进入 REPL
run-agent --resume "继续"      # 在最近会话上下文中追加一条 prompt
```

## Headless（`--print` + `--json`）

无需交互地让 agent 跑完一条 prompt 并退出，供脚本 / CI / 其它程序调用：

```bash
run-agent --print "重构 src/utils.ts"                    # 跑一次，人类日志在终端
run-agent --print "读 README.md" --json > out.json        # 结构化 JSON，人类日志去 stderr
run-agent --print "…" --json --max-turns 5               # 限制 ReAct 循环轮数
```

- `--print <prompt>` 与位置参数 prompt **互斥**（二选一，同时给 → 报错退出）。
- 退出码：成功 `0`，出错（无 API key、flag 冲突、运行期错误）`1`。

### JSON 契约

`--json` 时 stdout **只有** JSON（人类日志全去 stderr），字段：

```jsonc
{
  "version": "0.6.0", // 包版本
  "provider": "openai-compatible",
  "model": "gpt-4o-mini", // 实际生效模型（未显式指定 → 适配器默认）
  "session": "20260812-…-xxxx.jsonl", // 会话文件名（basename）
  "reply": "模型最终回复",
  "messages": 4, // 本次会话消息总数（含 system 之外的所有轮）
  "turns": 2, // ReAct 循环轮数（默认上限 25）
  "tools": [
    // 工具执行轨迹（按调用顺序）
    {
      "name": "read_file",
      "input": { "file_path": "…" },
      "result": "——— …———", // 截断到 2000 字符 + "…（已截断）"
      "permission": "allow", // 本次判定的最终结果：allow / deny
    },
  ],
  "errors": [], // 运行期错误（非空 → 退出码 1）
}
```

- 工具轨迹在**记录时**截断到 2000 字符（`TOOL_TRACE_RESULT_LIMIT`），完整结果在会话 JSONL 里。
- one-shot 无交互确认：写/执行类工具在 `default` 模式降级 `deny`，`--mode acceptEdits` 时
  cwd 内写免确认 `allow`。
- Hooks 在 headless 下同样触发（`SessionStart`/`Stop`/`PreToolUse` 等）。

## 可编程化（0.6.0）

- **Hooks**：五类事件（`PreToolUse`/`PostToolUse`/`SessionStart`/`SessionEnd`/`Stop`）挂命令或
  HTTP 回调，配置 `~/.config/run-agent/settings.json` + `.run-agent/settings.json`（Trust）。
  见 [hooks.md](hooks.md)。
- **Skills**：`.run-agent/skills/<name>/SKILL.md`（Trust）或 `~/.config/run-agent/skills/`，
  模型用 `SkillTool` 加载执行，或 REPL 里 `/技能名`。见 [skills.md](skills.md)。
- **自定义命令**：`.run-agent/commands/<name>.md|.py|.js|.ts`（Trust）或
  `~/.config/run-agent/commands/`，REPL 里 `/命令名`。见 [commands.md](commands.md)。
