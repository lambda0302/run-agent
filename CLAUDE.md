# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

`run-agent` 是一个多提供商的终端编码 agent(npm 包 / CLI 命令都是 `run-agent`)。当前 V1(0.1.0)交付:ReAct agent loop + 6 个内置工具 + 配置系统 + JSONL 会话持久化 + readline REPL。完整路线图见 `docs/Plan.md` 与 `docs/Plan_V1.md`(V2 起做权限审批 / 工具并发 / Trust)。

## 常用命令

```bash
npm run build        # tsup 打包 → dist/cli.js(单文件 ESM,自带 shebang)
npm run dev          # tsup --watch
npm run typecheck    # tsc --noEmit(strict + exactOptionalPropertyTypes)
npm run test         # 先 build 再 vitest run(11 文件 / 58 用例)
npx vitest run tests/tools/edit.test.ts   # 跑单个测试文件
npm run lint / npm run lint:fix
npm run format / npm run format:check     # prettier
npm run smoke        # 构建后验证 --version / --help
```

> `npm test` 会先执行 `npm run build`。CLI 实际运行的是 `dist/cli.js`,改过 `src/` 后本地验证前必须重新构建(或用 `npm run dev` 监听)。

## 架构

分层数据流:CLI 入口 → `src/core/query.ts`(ReAct loop)→ `src/providers/`(LLM 适配器)+ `src/tools.ts`(工具注册)。

- **统一内部消息格式 `LLMMessage`(见 `src/providers/types.ts`)是全项目唯一真相**:对齐 Anthropic 的 `tool_use` / `tool_result` block。OpenAI 的 `tool_calls` / `tool` role 互转只发生在适配器层,loop 层只见统一格式。改消息格式必须同步 4 个适配器。
- **流式是唯一形态**:`LLMClient.stream()` 发射 `text` / `tool_use` / `done` 事件。OpenAI 流式把 tool_calls 按 chunk 分片,适配器要按 `index` 跨 chunk 聚合 id/name/arguments——这是适配器最容易写错的地方,有专门单测。
- **工具即函数**:`Tool = { name, description, inputSchema: z.ZodType, call, isConcurrencySafe? }`。zod schema 经手写 `zodToJsonSchema`(零依赖,~50 行)转 JSON Schema 暴露给模型。V2 起 MCP / skill / 子 agent 工具全部复用此接口,扩展点在这里。
- **配置优先级**:CLI flag > 环境变量(`RUN_AGENT_*`)> `~/.config/run-agent/config.json` > 默认值。注意 `apiKeyEnv` 字段存的是**环境变量名**、不是 key 值;`resolveApiKey()` 解析顺序:显式 `apiKey` > `apiKeyEnv` 指向的变量 > provider 默认约定(如 `ANTHROPIC_API_KEY`)。
- **会话持久化**:`~/.local/share/run-agent/sessions/<ts>-<id>.jsonl`,逐行 JSONL 追加。`createSessionFile()` 只算文件名、**不建文件**(首次 `appendMessage` 才创建);`latestSessionFile()` 按文件名(ISO 时间戳)字典序倒排找最新。
- **Bash 工具跨平台**:`resolveShell()` 在 win32 用 `powershell.exe -NoProfile -NonInteractive`,POSIX 用 `/bin/bash -lc`;`RUN_AGENT_SHELL` 环境变量可覆盖。默认 120s 超时 + 输出 30k 截断(超长落盘为 artifact)。
- **打包**:tsup 单入口 `src/cli/index.ts` → `dist/cli.js`,运行时依赖全部 external(由 npm install 提供),banner 加 shebang。

## 非显而易见的约束(踩过的坑)

- **`exactOptionalPropertyTypes`**:可选属性只能用条件 spread 加入对象:`...(val !== undefined ? { key: val } : {})`,不能直接写 `{ key: undefined }`。
- **`verbatimModuleSyntax`**:类型导入必须 `import type`,否则 typecheck 报错。
- **zod v4 双类型系统**:运行时只有经典 `z.Zod*` 类,不存在 `z.ZodEffects`。内省 schema 时把参数声明为 `unknown`,用 `instanceof z.ZodString` 等缩小;`.element` / `.options` / `.shape` 访问器返回的是 new-style `$ZodType` 类型(与经典 `z.ZodType` 结构不兼容),需断言或再缩小。`z.number()` 无界时 `minValue/maxValue` 是 `±Infinity`,用 `Number.isFinite` 守卫。
- **UTF-8 BOM**:读文件时用 `/^﻿/` 剥离 BOM,防止精确匹配类工具(Edit/Grep)找不到内容。

## 测试

- Vitest,`tests/` 镜像 `src/` 结构。loop 集成测试注入**确定性 mock LLM**(如脚本化事件的 `FakeClient`),绝不依赖真实 API key;OpenAI 兼容集成测试用本地 mock HTTP server。
- 验收基线 = CI(`.github/workflows/ci.yml`):typecheck + lint + test + CLI 冒烟,在 Windows/macOS/Linux × Node 20/22/24 上必须全绿。
