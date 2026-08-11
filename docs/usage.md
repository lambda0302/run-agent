# 用法

> V1（0.1.0）：完整的 ReAct agent——单条 prompt 或交互式 REPL，可自动读/写/改文件、搜索、执行命令。

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

- `/clear`：清空上下文
- `/help`：帮助
- `/exit` / `/quit`：退出

## 会话与续接

每次运行都会把内部消息逐行追加到 `~/.local/share/run-agent/sessions/<ts>-<id>.jsonl`。

```bash
run-agent --resume            # 续接最近会话进入 REPL
run-agent --resume "继续"      # 在最近会话上下文中追加一条 prompt
```
