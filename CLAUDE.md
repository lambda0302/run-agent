# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

`run-agent` — 多提供商的终端编码 agent（npm 包 / CLI 命令都是 `run-agent`）。持续演进中：ReAct agent loop + 6 个内置工具 + 配置系统 + JSONL 会话持久化 + readline REPL + 权限引擎 + 工具并发 + Trust。路线图见 `docs/Plan.md`，各版本计划与 Bug 记录见 `docs/Plan_V*.md` / `docs/Bug_V*.md`。**本文件只记稳定约定；架构细节以 `src/` 为准，勿当成版本快照。**

## 常用命令

```bash
npm run build        # tsup 打包 → dist/cli.js（单文件 ESM，自带 shebang）
npm run dev          # tsup --watch
npm run typecheck    # tsc --noEmit（strict + exactOptionalPropertyTypes）
npm run test         # 先 build 再 vitest run（15 文件 / 105 用例）
npx vitest run tests/tools/edit.test.ts   # 跑单个测试文件
npm run lint / npm run lint:fix
npm run format / npm run format:check     # prettier
npm run smoke        # 构建后验证 --version / --help
```

> `npm test` 会先执行 `npm run build`。CLI 实际运行的是 `dist/cli.js`，改过 `src/` 后本地验证前必须重新构建（或用 `npm run dev` 监听）。

## 架构（稳定事实）

分层数据流：CLI 入口 `src/cli/index.ts` → ReAct loop `src/core/query.ts` → 适配器 `src/providers/` + 工具 `src/tools.ts` + 权限引擎 `src/permissions/` + 并发调度 `src/core/execute.ts`。

- **统一内部消息格式 `LLMMessage` 是全项目唯一真相**（对齐 Anthropic `tool_use`/`tool_result` block）。OpenAI 的 `tool_calls`/`tool` role 互转只发生在适配器层，loop 层只见统一格式。改消息格式必须同步 4 个适配器。流式是唯一形态；OpenAI 流式把 tool_calls 按 chunk 分片，适配器按 `index` 跨 chunk 聚合。
- **工具即函数**：`Tool = { name, description, inputSchema: z.ZodType, call, isConcurrencySafe? }`。zod schema 经手写 `zodToJsonSchema`（零依赖）转 JSON Schema。**写类工具必须显式 `isConcurrencySafe: false`**（read/glob/grep 显式 `true`）；`src/core/execute.ts` 据此分区执行（只读并行上限 10、写串行），结果**按原始调用顺序**重排回填。
- **权限管线**：判定是纯函数 `hasPermissionsToUseTool`（`src/permissions/engine.ts`：bypass → 内置底线 → 用户规则首条命中 → 模式兜底）。`ask` 的弹窗由 `src/permissions/prompt.ts` 的 `resolveAsk` 处理；`checkPermission` 在 `src/cli/repl.ts` 的 `makeCheckPermission(ctx, out, ask)` 组装。**铁律：stdin 只能有一个读者**——权限弹窗复用 REPL 的 readline（注入 `ask`），绝不在同一 stdin 上另建 readline（会导致输入回显成多个字符）。
- **配置优先级**：CLI flag > 环境变量（`RUN_AGENT_*`）> `~/.config/run-agent/config.json` > 默认值。`apiKeyEnv` 字段存的是**环境变量名**、不是 key 值；`resolveApiKey()` 解析：显式 `apiKey` > `apiKeyEnv` 指向的变量 > provider 默认约定（如 `ANTHROPIC_API_KEY`）。
- **Bash 工具跨平台**：`resolveShell()` 在 win32 用 `powershell.exe -NoProfile -NonInteractive`，POSIX 用 `/bin/bash -lc`；`RUN_AGENT_SHELL` 可覆盖。默认 120s 超时 + 输出 30k 截断。
- **会话持久化**：`~/.local/share/run-agent/sessions/<ts>-<id>.jsonl`，逐行 JSONL 追加。`--resume` 读最新会话回放 messages。

## 非显而易见的约束（踩过的坑）

- **`exactOptionalPropertyTypes`**：可选属性只能用条件 spread：`...(val !== undefined ? { key: val } : {})`，不能写 `{ key: undefined }`。
- **`verbatimModuleSyntax`**：类型导入必须 `import type`。
- **zod v4 双类型系统**：运行时只有经典 `z.Zod*` 类。内省 schema 时参数声明为 `unknown`，用 `instanceof` 缩小；`.element`/`.options`/`.shape` 访问器返回 new-style `$ZodType`（与经典类型结构不兼容）。`z.number()` 无界时 `minValue/maxValue` 是 `±Infinity`，用 `Number.isFinite` 守卫。
- **UTF-8 BOM**：读文件用 `/^﻿/` 剥离 BOM，防精确匹配类工具（Edit/Grep）找不到内容。

## 安全纪律

- **API key 永不进仓库**；`.gitignore` 覆盖 `.env` / `dist/` / `node_modules/`；`apiKeyEnv` 存环境变量名。
- **内置底线不可被用户规则解除**：`.git` / `.claude` / `.run-agent` 路径段 + 危险命令（`rm -rf /`、`mkfs`、`git push --force`、`npm publish` 等）无条件 deny。
- **测试必须 hermetic**：loop 集成测试注入确定性 mock LLM / 本地 mock HTTP server，绝不发真实 API 请求；涉及配置/会话路径的测试要沙箱子进程环境（`USERPROFILE`/`HOME` 指向临时目录）。

## 测试

- Vitest，`tests/` 镜像 `src/` 结构。验收基线 = CI（`.github/workflows/ci.yml`）：typecheck + lint + test + CLI 冒烟，Windows/macOS/Linux × Node 20/22/24 全绿。
