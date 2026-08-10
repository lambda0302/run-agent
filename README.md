# Run Agent

[![CI](https://github.com/lambda0302/run-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/lambda0302/run-agent/actions/workflows/ci.yml)

一个透明、多提供商的**终端编码 agent**：用自然语言让它读代码、改文件、跑命令、跑测试，并把每一步做了什么展示给你看。

> 当前版本：**0.2.0**（V2 · 权限审批 + Trust + 工具并发 + 错误重试）。路线图见 [Plan.md](docs/Plan.md)。

## 快速开始

```bash
# 全局安装
npm install -g run-agent

# 设置模型 API key（以 Anthropic 为例）
export ANTHROPIC_API_KEY=sk-ant-...

# 单条 prompt：agent 会自动读文件 → 改文件 → 跑测试 → 汇报
run-agent "把 README 里的大标题改成 'Run Agent'"

# 不带 prompt 进入交互式 REPL
run-agent
```

在 Windows（PowerShell）下等价写法：

```powershell
$env:ANTHROPIC_API_KEY="sk-ant-..."
run-agent "把 README 里的大标题改成 'Run Agent'"
```

macOS / Linux 支持 bash/zsh；Windows 使用 PowerShell（无需额外安装）。

## 多提供商

`run-agent` 用一个内部统一的消息格式对接多家模型，配置优先级：**CLI flag > 环境变量 > 配置文件 > 默认值**。

| Provider            | 覆盖模型                          | 设置方式                                   |
| ------------------- | --------------------------------- | ------------------------------------------ |
| `anthropic`（默认） | Claude                            | `ANTHROPIC_API_KEY`                        |
| `openai`            | GPT                               | `OPENAI_API_KEY`                           |
| `openai-compatible` | DeepSeek / Qwen / vLLM / 本地推理 | `--base-url` + `DEEPSEEK_API_KEY` 等       |
| `ollama`            | 本地 Ollama                       | 无需 key，默认 `http://localhost:11434/v1` |

### 示例

**Anthropic（默认）**

```bash
run-agent --provider anthropic --model claude-sonnet-5 "修复这个仓库的测试"
```

**DeepSeek（OpenAI 兼容）**

```bash
export DEEPSEEK_API_KEY=sk-...
run-agent --provider openai-compatible --base-url https://api.deepseek.com/v1 --model deepseek-chat "给函数加注释"
```

**本地 Ollama**

```bash
ollama pull qwen2.5
run-agent --provider ollama --model qwen2.5 "介绍一下这个项目"
```

### 配置文件

也可以把偏好写进 `~/.config/run-agent/config.json`：

```json
{
  "provider": "openai-compatible",
  "model": "deepseek-chat",
  "baseURL": "https://api.deepseek.com/v1",
  "apiKeyEnv": "DEEPSEEK_API_KEY"
}
```

支持 `.env`：在项目根放 `.env`，`run-agent` 会自动加载。

### 续接会话

```bash
run-agent --resume          # 续接最近一次会话（进入 REPL）
run-agent --resume "继续"   # 在最近会话上下文上执行
```

会话以 JSONL 逐行追加在 `~/.local/share/run-agent/sessions/`。

## 特性

- **ReAct agent loop**：流式输出 + 工具调用循环，停止条件 / 截断恢复 / **transient 错误指数退避重试**
- **权限审批引擎**（V2）：`default` / `acceptEdits` / `bypass` 三模式，内置危险命令与敏感路径底线，支持全局 + 项目级规则
- **Trust 信任边界**（V2）：只有受信任的项目才加载 `.run-agent/permissions.json`，防提示注入
- **只读并行 / 写串行**（V2）：并发读取加速，副作用工具保持串行，结果按原顺序回填
- **6 个内置工具**：`read_file` · `write_file` · `edit_file`（精确替换）· `glob` · `grep` · `run_bash`（跨平台，超时+输出截断）
- **多提供商**：一套抽象对接 Anthropic / OpenAI / OpenAI 兼容 / Ollama
- **透明**：REPL 里实时看到模型文本增量与每次工具调用及结果
- **会话持久化**：JSONL 追加、`--resume` 原样回放

V2 暂不包含（路线图 V3+）：上下文压缩、CLAUDE.md、repo map、MCP、Hooks、多 agent、TUI。

## 安全模型

`run-agent` 默认拦得多、放行得少：所有 shell 命令执行都需确认，写/改工具在 `default` 模式需确认，
且存在不可被规则解除的安全底线（`rm -rf /`、`git push --force`、`.git` 等敏感路径）。
交互 REPL 内按 `y/n/a` 授权（`a` 记入永久规则）；**one-shot 不弹确认，一律拒绝**。

```bash
run-agent -t "帮我看一下这段代码"                     # -t 信任当前项目
run-agent --mode acceptEdits "重构 src/utils.ts"      # 写/改免确认，命令仍询问
run-agent --dangerously-skip-permissions "..."        # 不推荐：完全放行
run-agent trust --list                                # 查看受信任项目
```

详见 [docs/permissions.md](docs/permissions.md) 与 [SECURITY.md](SECURITY.md)。

## 文档

- [架构](docs/architecture.md)
- [权限与 Trust](docs/permissions.md)
- [本地开发](docs/development.md)
- [用法](docs/usage.md)
- [路线图](docs/Plan.md) · [V0 交付](docs/Plan_V0.md) · [V1 实施方案](docs/Plan_V1.md) · [V2 实施方案](docs/Plan_V2.md)
- [安全说明](SECURITY.md)

## 贡献

欢迎参与，见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)
