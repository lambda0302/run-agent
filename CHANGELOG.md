# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

### Fixed

- **权限确认多 y 回显 bug**（V2-11）：`resolveAsk` 不再在同一 stdin 上自建 readline，改为
  **复用 REPL 的唯一 readline**（注入 `ask` 函数）——输入一个 `y` 不再回显成 `yy`/`yyy`，
  且 `yy`/`yyy` 纯 y 串也判为允许。`checkPermission` 的构造移入 `repl.ts` 的
  `makeCheckPermission(ctx, out, ask)`。新增 `tests/permissions/prompt.test.ts` 回归锁定。

### Added

- **REPL 任务完成分隔线**：每轮任务结束输出清晰的 `✔ 任务完成` 标记，明确一轮已结束，
  消除「任务完成后输入 `y` 被当成新 prompt 又跑一遍」的困惑（后者本身是 REPL 语义）。

## [0.2.0] - 2026-08-11

### Added

- **权限审批引擎**（`src/permissions/`，V2 M1）：`default` / `acceptEdits` / `bypass` 三模式；
  逐级短路判定（bypass → 内置底线 → 用户规则首条命中 → 模式兜底）；`run_bash` 命令按
  危险/风险/安全分级。
- **内置安全底线**：危险命令（`rm -rf /`、`mkfs`/`fdisk`、`dd` 写裸设备、`git push --force`、
  `npm publish`、`shutdown` 等）与敏感路径（`.git` / `.claude` / `.run-agent` 段）无条件拒绝，
  用户规则无法解除。
- **用户规则**：全局 `~/.config/run-agent/permissions.json` + 项目级 `.run-agent/permissions.json`，
  `tool`/`path`(glob)/`command`(正则)/`action` 维度，首条命中短路。
- **Trust 信任边界**：`run-agent trust [path] [--list|--remove]`、`-t/--trust` 启动信任；
  只有受信任项目的项目级规则才被加载（防提示注入）。
- **只读并行 / 写串行**（V2 M2）：`isConcurrencySafe` 声明 + 信号量并发（上限 10），
  结果重排回原顺序回填 `tool_result`；副作用工具绝不并行。
- **流式错误重试**（V2 M3）：transient 错误（429/5xx/网络）指数退避重试，`maxRetries` 可配
  （默认 2，`RUN_AGENT_MAX_RETRIES` 覆盖）；重试丢弃已收集增量整轮重来。
- CLI 选项：`--mode` / `--dangerously-skip-permissions` / `--trust`，以及 `trust` 子命令。
- 测试：权限决策矩阵、规则持久化、并发执行（并行/串行/上限/顺序）、错误重试、权限集成、
  CLI 沙箱化冒烟——共 95 个用例。

### Changed

- 版本号 `0.1.0` → `0.2.0`。
- 6 个工具标记并发安全属性；`config.json` 新增 `permissionMode`；`.env` 加载在启动时生效。
- 文档：新增 `docs/permissions.md`、`SECURITY.md`；README 增加"安全模型"章节。

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
