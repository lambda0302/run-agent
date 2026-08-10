# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.1.0] - 2026-08-10

### Added

- **多提供商 LLM 抽象**：统一内部消息格式（对齐 Anthropic `tool_use`/`tool_result` block），
  4 个适配器——Anthropic / OpenAI / OpenAI 兼容（DeepSeek、Qwen、vLLM 等）/ Ollama，全部支持流式 + 工具调用。
- **ReAct agent loop**（`src/core/query.ts`）：流式收集文本与工具调用、按 stop reason 分流、
  `max_tokens`/`error` 简单恢复、轮数上限兜底。
- **6 个内置工具**：
  - `read_file` / `write_file` / `edit_file`（精确字符串替换，多处匹配保护）
  - `glob`（零依赖迷你 glob：`**`/`*`/`?`/`{a,b}`，默认跳过 `.git`/`node_modules`）
  - `grep`（递归正则搜索，支持 glob 过滤）
  - `run_bash`（跨平台：Windows 用 PowerShell，macOS/Linux 用 bash；默认 120s 超时、30k 输出截断落盘）
- **配置系统**：优先级 `CLI flag > 环境变量 > ~/.config/run-agent/config.json > 默认值`；
  支持 `.env` 加载与按 provider 的默认 API key 环境变量约定。
- **交互式 REPL**（`run-agent` 不带参数进入）：流式渲染、工具执行展示、`/clear` `/help` `/exit`。
- **会话持久化**：JSONL 逐行追加在 `~/.local/share/run-agent/sessions/`，`--resume` 续接最近会话。
- CLI 选项：`--provider` `--model` `--base-url` `--api-key` `--resume`。
- 测试：provider 适配器（mock SDK 流式 + function calling 互转）、配置优先级矩阵、
  agent loop golden 场景、Edit/Glob/Grep/Bash 工具、sessionStorage、CLI 冒烟——共 55 个用例。

### Changed

- CLI 从"单条 prompt 调用 Anthropic"升级为完整的 agent 入口（单次执行 + REPL）。
- 版本号 `0.0.0` → `0.1.0`。

### Fixed

- Anthropic 适配器：流式 `tool_use` 的 `input_json_delta` 跨事件聚合；tool 结果合并进 user 消息的 `tool_result` 块。
- OpenAI 适配器：跨 chunk 聚合分片的 `tool_calls`（name/arguments 增量）。
- 移除对 npm 镜像源（registry.npmmirror.com）的依赖，lockfile 基于官方 registry 重新生成。

## [Unreleased]

### Added

- 初始化项目骨架：TypeScript + Node 20、tsup 打包、Vitest、ESLint/Prettier、三 OS CI。
- CLI 空壳：`--version` / `--help` / 单条 prompt 调用 Anthropic。
- LLM 客户端抽象（`LLMClient`）+ Anthropic 参考适配器。
