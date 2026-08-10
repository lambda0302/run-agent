# 用法

> V0 为最小可用形态：单条 prompt 调一次模型。多提供商、配置系统、agent loop 将在 V1 起交付。

## 安装

```bash
npm install -g run-agent
```

## 基本用法

```bash
run-agent --help
run-agent --version
run-agent "你好，请用一句话自我介绍"
run-agent -m claude-sonnet-5 "解释什么是纯函数"
```

## 环境变量

| 变量                | 用途                         |
| ------------------- | ---------------------------- |
| `ANTHROPIC_API_KEY` | Anthropic API key（V0 必填） |

V1 起将支持 `~/.config/run-agent/config.json` 与 `.env`，并支持 OpenAI / Ollama / OpenAI 兼容模型（如 DeepSeek）。
