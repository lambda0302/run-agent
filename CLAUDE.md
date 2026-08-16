# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

`run-agent` — 多提供商的终端编码 agent（npm 包名 `@liyiyong/run-agent`，CLI 命令 `run-agent`）。持续演进中：ReAct agent loop + 16 个内置工具 + 动态 MCP 工具 + Plan 模式 + 配置系统 + JSONL 会话持久化 + readline REPL + 权限引擎 + 工具并发 + Trust + **可编程化（Hooks / Skills / 自定义命令 / Headless）+ 多 Agent 编排（agent 委派 + 协调者三件套 + verification 验证子 agent + 后台记忆提取双轨）**。路线图见 `docs/Plan.md`，各版本计划与 Bug 记录见 `docs/Plan_V*.md` / `docs/Bug_V*.md`。**本文件只记稳定约定；架构细节以 `src/` 为准，勿当成版本快照。**

## 常用命令

> 命令列表见 `package.json` scripts（`npm run build`/`dev`/`typecheck`/`test`/`lint`/`format`/`smoke`；单文件测试 `npx vitest run tests/<file>.test.ts`）。陷阱：`npm test` 会先执行 `npm run build`；CLI 实际运行的是 `dist/cli.js`，改过 `src/` 后本地验证前必须重新构建（或用 `npm run dev` 监听）。

## 架构（稳定事实）

分层数据流：CLI 入口 `src/cli/index.ts` → ReAct loop `src/core/query.ts` → 适配器 `src/providers/` + 工具 `src/tools.ts` + 权限引擎 `src/permissions/` + 并发调度 `src/core/execute.ts`。

- **统一内部消息格式 `LLMMessage` 是全项目唯一真相**（对齐 Anthropic `tool_use`/`tool_result` block）。OpenAI 的 `tool_calls`/`tool` role 互转只发生在适配器层，loop 层只见统一格式。改消息格式必须同步 4 个适配器。流式是唯一形态；OpenAI 流式把 tool_calls 按 chunk 分片，适配器按 `index` 跨 chunk 聚合。
- **工具即函数**：`Tool = { name, description, inputSchema: z.ZodType, call, isConcurrencySafe? }`。zod schema 经手写 `zodToJsonSchema`（零依赖）转 JSON Schema。**写类工具必须显式 `isConcurrencySafe: false`**（read/glob/grep 显式 `true`）；`src/core/execute.ts` 的 `StreamingToolExecutor` 据此调度——tool_use block 一完整即入队执行（流式边执行），只读并行（上限 10）/ 写串行且不打断，结果**按 index 重排**回填。
- **权限管线**：判定是纯函数 `hasPermissionsToUseTool`（`src/permissions/engine.ts`，**收口前置单线**：用户 deny → 内置危险命令 → 命令文本危险段 → 记忆读专属通道 → 路径危险段 → plan 分支 → 导航工具 → 用户 allow → 白名单兜底；**无 bypass 模式**）。`run_bash` 经 `classifyBashCommand` 按影响半径分**六类**（`BashDanger`：dangerous 硬拒 / readonly R0 闭集自动 allow / network·local-exec·http-get·write 兜底 ask）；命令文本危险段 `DENY_BASH_SEGMENTS_RE` 收口 `.git`/`.claude`/`.run-agent` 三目录段。`ask` 的弹窗由 `src/permissions/prompt.ts` 的 `resolveAsk` 处理（0.8.1 起为方向键菜单 `promptSelect`）；`checkPermission` 在 `src/cli/repl.ts` 的 `makeCheckPermission(ctx, out, ask)` 组装。**铁律：stdin 只能有一个读者**——权限弹窗复用 REPL 的 readline（注入 `ask`），绝不在同一 stdin 上另建 readline（会导致输入回显成多个字符）；`promptSelect`（`src/ui/select.ts`）进入时 `rl.pause()` + 临时移除 line 监听（readline 完全静音）、结束恢复，`input` 缺省回退 `rl.input`（显式 `input` 优先）。
- **Plan 模式（0.5.0）**：`PermissionMode` 含 `"plan"`（**会话内动态模式**，非 CLI 可选项——`--mode plan` 报非法值）。plan 分支在判定顺序最前：写/执行类工具一律 deny、只读 cwd 内放行 / cwd 外 ask、`enter_plan_mode` 放行、`exit_plan_mode` 放行（审批在 REPL 弹窗）；`exit_plan_mode` 把计划直写 `.run-agent/plans/` 并恢复进入前模式。**one-shot 不装配 plan 工具、无 `/plan`**（无审批弹窗，防死锁）。
- **MCP 客户端（0.5.0）**：`src/services/mcp/`（config / manager / tool）。配置用户级 + Trust 项目级 `mcp.json`；**启动预连**所有 enabled server（配置驱动，无 `preconnect` 字段、无 `mcp_connect` 工具）；连接失败/401 各自进 `failed`/`needs-auth` 态、不阻断启动，`/mcp connect <name>` 手动重连。MCP 工具名 `mcp__server__tool`、desc 截断 2048、连接时保留 server 全量 JSON Schema（`Tool.jsonSchema`，spec 生成优先直发，缺省回退 zod）、`isConcurrencySafe = readOnlyHint`，走同一权限管线——**三模式一律 ask**（default/acceptEdits 由 CLI 装配闭包落地、plan 由引擎层硬保证，`readOnlyHint` 只影响并发调度、不进权限判定）。工具池是函数型（`() => Tool[]`，每轮重建）——预连注册的工具**第一轮请求**即可调用。详见 `docs/mcp.md` / `docs/plan-mode.md`。
- **可编程化（0.6.0，一律 run-agent 自有路径、无 `.claude/`）**：
  - **Hooks**（`src/services/hooks/`）：五类事件 PreToolUse/PostToolUse/SessionStart/SessionEnd/Stop × command/http 执行。配置 `settings.json`：用户级 `~/.config/run-agent/` 始终 + 项目级 `.run-agent/` 仅 Trust（hook 执行任意命令，防提示注入）。`PreToolUse` 经 `makeCheckPermission` 可返回 permissionDecision 覆盖判定，**engine deny 是硬底线、hook allow 不可放行**；`Stop` 输出注入下一轮 system（限 2KB）。失败/超时（默认 30s）不阻断。
  - **Skills**（`src/services/skills/`）：`.run-agent/skills/<name>/SKILL.md`（Trust）+ 用户级；frontmatter `name`/`description`/`allowed-tools` + body。装配 **`SkillTool`**（第 16 个内置工具，**归内置只读** → default/headless 免确认）：激活后本 turn 工具 = `allowed-tools ∩ 池`（内置只读始终保留、`mcp__*` 通配）；**body 惰性加载**——registry 只持「名 + 描述 + 路径」，启动不读 body，`SkillTool` 调用 / `/技能名` 时 `readSkillBody` 从磁盘现读（热更新，body 不塞 token）；system 只注入名+描述清单；REPL `/skills` + `/<技能名>`。
  - **多 Agent 编排（0.7.0，`src/services/agents/` + `src/core/run_agent.ts`）**：`agent` 工具委派子任务（`src/tools/agent.ts`）——**工具描述在创建时从 registry 动态列出全部可委派类型**（内置 + 自定义，模型直接见 `agentType` 取值，不必去文件系统猜/创建）；前台阻塞回填 `[<类型> 结论]`，后台 `BackgroundTaskManager.spawn`（`src/services/agents/team/registry.ts`）返回 `task-<n>` 可寻址占位、轮末 `awaitAll` 汇总（仅汇总 `!reported` 任务防跨 end_turn 重复注入）。**协调者三件套 `CORE_TEAM_TOOLS` = {agent, send_message, task_stop} 只装配主 agent**；子 agent 工具池由 `AgentTypeDef.resolveTools` 解析（内置 general-purpose = 父级池过滤三件套防递归；explore = 只读四件套；verification[0.7.1] = 只读 + run_bash 带专门权限；自定义 frontmatter 类型 `.run-agent/agents/<name>.md` Trust / `~/.config/run-agent/agents/` 始终，同名内置 > 用户 > 项目，非法启动告警跳过）。**权限继承**：子查询走 `PermissionBridge`（`src/cli/repl.ts` 构造完 checkPermission 后写入，agent 工具读取）；类型级 `checkPermission` 字段替换父级继承（`AgentTypeDef.checkPermission`，见 verification）；**后台永不弹窗**——ask 降级 deny（轮末 REPL 不空闲，弹窗会死锁）；**前台子 agent 权限弹窗带 `[子 agent: <类型>]` 来源标签**（agent 工具继承父级 checkPermission 时包 wrap 注入 source，`resolveAsk`/`makeCheckPermission` 透传渲染；主循环无标签）。**runQuery 三个挂点**（`src/core/query.ts`）：while 顶部 `pollExternal`（SendMessage 迭代边界送达）+ `signal.aborted` 检查；catch 分支 `isAbortError`（TaskStop 中断 in-flight 不重试）；end_turn `onBackgroundDone`（后台汇总注入）。`--coordinator` 注入协调者 system 段落（`src/core/context.ts`）。详见 `docs/agents.md`。
  - **verification 验证子 agent（0.7.1，`src/services/agents/builtin/verification.ts`）**：对抗性验证专家——证据式 `VERDICT: PASS|FAIL|PARTIAL` 契约。工具集无写工具；专门权限策略 `makeVerificationCheckPermission(cwd)`（`classifyBashCommand` 六分类：dangerous 与命令文本危险段 deny；**readonly/local-exec/http-get 自动放行**（构建/测试/lint/curl 采样不弹窗）；network/write deny 但允许 `/tmp`·`$TMPDIR` 重定向写临时脚本、项目内写重定向 deny；write·edit 兜底 deny / 未知 deny）；`parseVerdict` 校验「PASS 但无 Command run: 证据」判拒。`maxIterations: 12`。
  - **后台记忆提取双轨（0.7.1，`src/services/extract/` + `src/services/agents/builtin/extractMemories.ts`）**：REPL 轮末 `void trigger(result.messages)` fire-and-forget。`ExtractMemoriesEngine`（游标增量 + 互斥 `hasMemoryWrite` + 成功才推进游标 + `MIN_EXTRACT_INCREMENT=4` 成本守卫 + 并发合并）；仅 Trust 且非 bare 装配、headless 不触发、`RUN_AGENT_DISABLE_MEMORY_EXTRACT` 可关。提取子 agent = `extractMemoriesDef`（read_file/glob/grep + remember；`remember→allow` 仅 Trust、其余 deny；`maxIterations: 5`；`querySource: 'extract_memories'`），直接 `runAgent` 不入 task registry / awaitAll。详见 `docs/memory.md`。
  - **自定义命令**（`src/services/commands/`）：`.run-agent/commands/<name>.md`（prompt 模板，`@file` 内联 + 参数追加，走 agent 循环）或 `.py/.js/.ts`（local 脚本，解释器直跑、argv 参数、注入 `RUN_AGENT_CWD`/`RUN_AGENT_PROMPT`、stdout 展示不回喂模型）；REPL `/commands` + `/<命令名>`。
  - **Headless**（`src/cli/index.ts` `runHeadless`）：`--print <prompt>` + `--json` → stdout 纯 JSON（人类日志去 stderr），契约 `{version,provider,model,session,reply,messages,turns,tools[],errors}`，`tools[].result` 记录时截断 2000 字符，退出码 0/1。**headless 收尾必须 `process.exitCode` + 自然退出**（`process.exit()` 在 Windows 触发 libuv 断言，见 `docs/Bug_V6.md`）。
- **配置优先级**：CLI flag > 环境变量（`RUN_AGENT_*`）> `~/.config/run-agent/config.json` > 默认值。`apiKeyEnv` 字段存的是**环境变量名**、不是 key 值；`resolveApiKey()` 解析：显式 `apiKey` > `apiKeyEnv` 指向的变量 > provider 默认约定（如 `ANTHROPIC_API_KEY`）。
- **Bash 工具跨平台**：`resolveShell()` 在 win32 用 `powershell.exe -NoProfile -NonInteractive`，POSIX 用 `/bin/bash -lc`；`RUN_AGENT_SHELL` 可覆盖。默认 120s 超时 + 输出 30k 截断。
- **会话持久化（0.8.1）**：`~/.local/share/run-agent/sessions/<sanitized-cwd>/<ts>-<id>.jsonl`，按 cwd 分目录
  （`sanitizePath` 非字母数字 → `-`、超长截断 200 + hash）；新建会话首行写 `{ ts, meta: {cwd, model, provider, version} }`
  元数据，第 2 行起才是消息行；目录 `0o700` / 文件 `0o600`。`--list`（当前项目会话列表，预览 = 首条 prompt 截断 60）、
  `--resume [id]`（无 id 续当前项目最新，带 id 按 `sessionsDir` + `findSessionFile` 定位）、REPL `/sessions`
  （promptSelect 方向键菜单切入 = 加载历史替换 messages + 更新 sessionFile 指针）。`loadSession` 跳过 meta 行、
  按 compact 哨兵重置加载点。

## 非显而易见的约束（踩过的坑）

- **`exactOptionalPropertyTypes`**：可选属性只能用条件 spread：`...(val !== undefined ? { key: val } : {})`，不能写 `{ key: undefined }`。
- **`verbatimModuleSyntax`**：类型导入必须 `import type`。
- **zod v4 双类型系统**：运行时只有经典 `z.Zod*` 类。内省 schema 时参数声明为 `unknown`，用 `instanceof` 缩小；`.element`/`.options`/`.shape` 访问器返回 new-style `$ZodType`（与经典类型结构不兼容）。`z.number()` 无界时 `minValue/maxValue` 是 `±Infinity`，用 `Number.isFinite` 守卫。
- **UTF-8 BOM**：读文件用 `/^﻿/` 剥离 BOM，防精确匹配类工具（Edit/Grep）找不到内容。

## 安全纪律

- **API key 永不进仓库**；`.gitignore` 覆盖 `.env` / `dist/` / `node_modules/`；`apiKeyEnv` 存环境变量名。
- **内置底线不可被用户规则解除**：`.git` / `.claude` / `.run-agent` 路径段（`run_bash` 命令文本引用任一目录段同样收口，`DENY_BASH_SEGMENTS_RE`）+ 危险命令（`rm -rf /`、`mkfs`、`git push --force`、`npm publish` 等，`classifyBashCommand` = `dangerous`）无条件 deny。
- **测试必须 hermetic**：loop 集成测试注入确定性 mock LLM / 本地 mock HTTP server，绝不发真实 API 请求；涉及配置/会话路径的测试要沙箱子进程环境（`USERPROFILE`/`HOME` 指向临时目录）。

## 测试

- Vitest，`tests/` 镜像 `src/` 结构。验收基线 = CI（`.github/workflows/ci.yml`）：typecheck + lint + test + CLI 冒烟，Windows/macOS/Linux × Node 20/22/24 全绿。
