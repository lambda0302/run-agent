# Run Agent

[![CI](https://github.com/lambda0302/run-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/lambda0302/run-agent/actions/workflows/ci.yml)

A transparent, multi-provider coding agent for your terminal.

> 状态：**V0 项目地基**——工程骨架已就绪。核心编码能力（agent loop、多提供商、内置工具）将从 V1 起逐步交付，见 [Plan.md](https://github.com/lambda0302/run-agent/blob/main/docs/Plan.md)。

## 快速开始（占位，V1 完善）

```bash
npm install -g run-agent
run-agent "你好，请用一句话自我介绍"
```

需要设置模型 API key，例如：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

## 特性（占位，V1 填充）

- **多提供商**：Anthropic / OpenAI / 本地 Ollama / OpenAI 兼容模型（如 DeepSeek）
- **编码 agent**：读代码、改代码、跑命令、跑测试
- 权限审批、上下文管理、MCP、多 Agent 编排

## 文档

- [架构](docs/architecture.md)
- [本地开发](docs/development.md)
- [用法](docs/usage.md)

## 贡献

欢迎参与，见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)
