# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.7.2] - 2026-08-12

### Fixed

- **子 agent 空结论/半截结论**：`runQuery` 迭代上限撞顶时只返回「末轮工具调用前的文本片段」——explore 子 agent 常把全部轮数花在取证上、从没进入「给结论」阶段。修复：预算耗尽且末轮仍调工具（`tool_use`/`max_tokens`/`error`）→ 注入「请给出最终结论」指令 + **无工具**再流一轮（有界，只多一轮），`reply` 即为收尾轮结论；空 completion 重试耗尽后同样做一次收尾轮。收尾轮内再遇截断/出错/空响应直接有界返回，绝不无限循环。`explore` 迭代预算上调：medium 8→12、very thorough 12→16。
- **`--max-turns` 契约微调**：headless 撞顶且模型仍在调工具时多跑一轮纯文本收尾（`turns` 含该轮），保证 `reply` 是结论而非半截话。
- **两行粘贴末行滞留成下一条"待输入"**：末行无换行收尾的粘贴，readline 只发 `n-1` 个完整 line 事件，旧 drain 门槛 `inputBuf.length>=2` 不触发 → 末行滞留在 readline 缓冲，出现在下一条 `run-agent>` 提示符上变成待输入（用户没按回车也显示、甚至被误提交）。修复：line 事件后用 `setImmediate` 查 readline 内部残留（Node ≤22 的 `_line` / Node 24 的 `Symbol(_line_buffer)`，版本容错 helper），同 chunk 有残留则标记 `pasteTailPending`，flush 时并入本 prompt。「提交后新输入」是独立 chunk、事件时刻残留为空 → 不并入（不误收）。

### Added

- **L1 预算提示（治本）**：`runQuery` 把迭代轮数上限注入 system（`## 迭代预算` 段，数值随 `maxIterations` 变化）——模型知情后主动规划收尾，不再被看不见的轮数墙硬切。主循环/子 agent 一律生效；compact 摘要等子请求用原始 system、不受影响。
- **权限弹窗来源标签**：前台子 agent 的权限申请在弹窗文本前缀 `[子 agent: <类型>]`（如 `[子 agent: general-purpose] 允许 run_bash …?`），一眼分辨"是谁在向我要权限"。实现：`resolveAsk`/`makeCheckPermission` 加可选 `source` 参数，agent 工具在**继承**父级 `checkPermission` 时包一层注入来源标签（类型级策略如 verification 不受影响、永不 ask）；主循环请求不带标签。后台子 agent 照旧永不弹窗。行为零变化（y/n/a、允许规则记忆、回车方式全不变）。
- **`agent` 工具描述动态列出全部可委派类型**：模型直接看到 `agentType` 可选值（内置 general-purpose / explore / verification + 全部自定义 frontmatter 类型，如 `qa`）——不必去文件系统搜 `.run-agent/agents/`（该目录对搜索工具不可见）猜类型，更不会试图自己创建类型文件（写 `.run-agent/` 被引擎硬拒）。工具创建时从 registry 快照类型名列表注入描述。

## [0.7.1] - 2026-08-12

### Added

- **verification 子 agent**（V7 决策 D）：对抗性验证专家——非平凡改动（3+ 文件 / 后端 / API / 基础设施）完成前委派它跑构建 / 测试 / 检查，出具带命令证据的 `VERDICT: PASS|FAIL|PARTIAL`。工具集**强制只读**（repo_map/glob/grep/read_file/verify/run_bash，无 write/edit）；专门权限策略：safe bash 自动放行（构建测试 lint 不弹窗）、risky/dangerous 命令 deny、项目内写重定向 deny、`/tmp` 临时脚本放行；`maxIterations: 12` 硬顶。证据契约：每条 check 必须含 `Command run:` + 实际输出；解析器校验「PASS 但无命令证据」判拒（主 agent 据此重新委派）。`agent` 工具 `agentType: "verification"` 调用。
- **后台记忆提取双轨**（V7 决策 E）：交互 REPL 每轮 query loop 结束后台提取子 agent（`extractMemories` 内置类型，独立执行路径、不入后台任务汇总），分析**本轮增量消息**把稳定的跨会话结论用 `remember` 落库——弥补主 agent 主动写对快模型触发不可靠。游标增量（只分析新增，<4 条跳过）、主/后台互斥（增量含 `remember` 则跳过并推进游标）、成功才推进游标、失败静默重试；fire-and-forget 不阻断下一轮。仅 Trust 且非 `--bare` 触发；headless 不触发；`RUN_AGENT_DISABLE_MEMORY_EXTRACT=1` 关闭。详见 [docs/memory.md](docs/memory.md)。

## [0.7.0] - 2026-08-12

### Added

- **多 Agent 编排**（V7 决策 A/B/C）：`agent` 工具委派子任务，支持前台阻塞与后台
  （`run_in_background: true`，独立上下文/transcript，轮末自动汇总）。子 agent 复用父级权限
  （用户 deny / 内置 deny 底线全部生效），**子 agent 永远不能获得超过父级的权限**。
- **协调者三件套**（V7 决策 C，只装配主 agent）：`send_message`（向运行中后台子 agent 注入
  user 消息，子查询**迭代边界**送达）/ `task_stop`（AbortController 传播 → 适配器中断
  in-flight 请求，保留部分文本）。`--coordinator` 注入协调者 system 段落（拆解→并行委派→
  反馈→止损→汇总核对）。REPL `/tasks` 列出后台任务。
- **agent 类型**（V7 决策 B）：内置 `general-purpose`（父级全部工具、不含三件套防递归）与
  `explore`（只读四件套，0.4.1 迁移）；自定义 frontmatter 类型 `.run-agent/agents/<name>.md`
  （仅 Trust）/ `~/.config/run-agent/agents/<name>.md`（始终），支持 `tools` 白名单 /
  `system` / `maxIterations` / `model`，同名内置 > 用户 > 项目，非法定义启动告警跳过。
- **后台永不弹窗**：后台子查询权限 `ask` 一律降级 `deny`（后台轮末汇总时 REPL 不空闲，
  弹窗会死锁）。详见 [docs/agents.md](docs/agents.md)。

## [0.6.0] - 2026-08-12

### Added

- **Hooks**（V6 决策 A）：五类事件自动化——`PreToolUse`（工具执行前，engine 判定后，可返回
  `permissionDecision` 覆盖判定，**engine deny 硬底线不可被 hook 放行**）/ `PostToolUse`
  （工具执行后，成功失败都触发，tool_result 截断 2k 传入）/ `SessionStart` / `SessionEnd` /
  `Stop`（每轮结束，stdout 注入**下一轮** system，限 2KB）。每条 hook 支持 `command`（shell 跑，
  输入走 stdin）或 `http`（POST JSON，可带 headers），默认 30s 超时、失败/超时绝不阻断主流程。
  配置 `settings.json`：用户级 `~/.config/run-agent/settings.json`（始终）+ 项目级
  `.run-agent/settings.json`（仅 Trust，hook 会执行任意命令，防提示注入），同事件用户级在前、
  项目级在后合并。REPL 与 headless 都生效。详见 [docs/hooks.md](docs/hooks.md)。
- **Skills**（V6 决策 B）：预写专业工作流。`.run-agent/skills/<name>/SKILL.md`（Trust）或
  `~/.config/run-agent/skills/`，frontmatter `name`/`description`/`allowed-tools` + body；
  装配 **`SkillTool`**（第 13 个内置工具，**归内置只读**——default/headless 免确认）——按 name
  加载、body 全文回填 tool_result，激活后本 turn 工具 = `allowed-tools ∩ 池`（内置只读始终保留，
  支持 `mcp__*` 通配），无限制则原样。**body 惰性加载（渐进式披露）**：registry 只持
  「名 + 描述 + 文件路径」，启动不读 body；`SkillTool` 调用 / `/技能名` 时 `readSkillBody` 从
  磁盘现读——内存不膨胀，改 SKILL.md 无需重启即热更新；system 只注入「名 + 描述」清单
  （body 不塞 token，对齐 Claude Code）。REPL `/skills` 列清单、`/<技能名>` 手动触发；同名去重
  用户级优先。详见 [docs/skills.md](docs/skills.md)。
- **自定义命令**（V6 决策 C）：两种形态——`prompt`（`.md` 模板，`@file` 内联 + 参数行尾追加，
  展开后走 agent 循环）与 `local`（`.py`/`.js`/`.ts` 脚本，解释器直跑、参数走 argv、注入
  `RUN_AGENT_CWD`/`RUN_AGENT_PROMPT`，stdout 展示不回喂模型，120s 超时 + 30k 截断复用 run_bash）。
  路径 `.run-agent/commands/`（Trust）+ `~/.config/run-agent/commands/`；REPL `/commands` 列清单、
  `/<命令名>` 执行；local-jsx 形态明确推 V8。详见 [docs/commands.md](docs/commands.md)。
- **Headless**（V6 决策 D）：`--print <prompt>` 跑一次即退（与位置参数互斥），`--json` 输出
  结构化结果到 stdout（人类日志去 stderr，stdout 纯 JSON），`--max-turns <n>` 限 ReAct 轮数。
  JSON 契约：`version/provider/model/session/reply/messages/turns/tools[]/errors`——`tools[]` 每项
  含 `name/input/result/permission`，result 记录时截断 2000 字符（`TOOL_TRACE_RESULT_LIMIT`）；
  `model` 报告实际生效值（未显式指定 → 适配器默认，openai-compatible 即 gpt-4o-mini）；
  退出码 0 成功 / 1 出错；无 key / flag 冲突 → stderr 报错 + 退出码 1。headless 下 hooks 同样触发。
  详见 [docs/usage.md](docs/usage.md#headlessprint--json)。
- **openai-compatible 默认模型对齐**：`resolveModelName` 对 `openai-compatible` 未显式指定时
  返回 gpt-4o-mini（与适配器内部默认一致），headless JSON 报告与实跑一致。

### Fixed

- **headless 工具轨迹为空**（V6-1）：`toolCalls.push(...attemptCalls)` 从 getResults 之前移到
  **之后**——`onToolTrace` 在工具 settle 时才触发，先合并会漏掉仍在执行中的轨迹。详见
  [docs/Bug_V6.md](docs/Bug_V6.md)。
- **Windows headless 收尾崩溃**（V6-2）：`process.exit()` 在 stdout 写回调里触发 libuv
  `UV_HANDLE_CLOSING` 断言（0xC0000409）。改 `closeAll()` 回收 MCP 子进程句柄 +
  `process.exitCode` 自然退出（确定性 0/1）。详见 [docs/Bug_V6.md](docs/Bug_V6.md)。

## [0.5.1] - 2026-08-12

### Fixed

- **权限弹窗显示交错**（0.5.1）：流式并行下，弹窗前已入队的后台只读工具会在权限确认
  `y/n` 弹窗等待期间完成，`└ 工具结果` 直接打印在提示行上——看起来像"卡住"或"输入被吞"。
  新增输出缓冲门 `createOutputGate`：弹窗开始前缓冲 agent 输出，答完按序刷出，提示行保持干净。

### Changed

- **Plan 模式拒绝语义**（0.5.1）：系统提示在装配 plan 工具的会话注入「计划被拒 → 立即停止并等待
  用户下一条指令，不输出实现内容、不重复尝试执行」（参考 Claude Code 的"停下等命令"）。`Tool` 新增
  可选 `denyMessage`，`exit_plan_mode` 装配专属拒绝消息——用户按 `n` 后模型收到的是
  「用户拒绝了你的计划…等待用户下一条指令」，不再误读为自身状态错误而反复重进 plan 模式。修复用户
  拒绝 `exit_plan_mode` 后模型把实现内容当文本 dump / 循环重试的问题。

## [0.5.0] - 2026-08-11

### Added

- **Plan 模式**（V5 决策 A）：`PermissionMode` 新增 `"plan"`（会话内动态模式，非 CLI 可选项）。
  `enter_plan_mode` 进入强制只读态——写/执行/verify/remember/MCP 非只读工具一律 deny，只读工具
  （cwd 内）放行；`exit_plan_mode` 把计划直写 `.run-agent/plans/plan-<ts>.md` 并经 REPL `y/n` 弹窗
  审批，批准后恢复进入前的权限模式（`prePlanMode`）。`/plan` 手动兜底入口（不经模型判断），
  两条进入路径共用同一状态机。one-shot 不装配 plan 工具、无 `/plan`（无审批弹窗，防死锁）。
  详见 [docs/plan-mode.md](docs/plan-mode.md)。
- **MCP 客户端**（V5 决策 B）：接入标准协议生态。唯一新依赖 `@modelcontextprotocol/sdk`，
  支持 stdio / Streamable HTTP / SSE 三种传输；配置用户级 `~/.config/run-agent/mcp.json` +
  项目级 `.run-agent/mcp.json`（仅 Trust 加载）。**按需连接**：默认不预连，`mcp_connect <server>`
  连接 → `tools/list` → 包装成标准 `Tool`（名 `mcp__<server>__<tool>`、desc 截断 2048、懒 schema
  `{type:"object"}`、`isConcurrencySafe = readOnlyHint`）进池；连接状态机 4 态
  connected / failed / needs-auth / disabled；`/mcp` 列状态、`/mcp connect <name>` 手动重连。
  MCP 工具走**同一权限管线**（新增 `readOnlyNames` 参数，缺省语义不变）。详见
  [docs/mcp.md](docs/mcp.md) 与 [examples/mcp-server/](examples/mcp-server/)。
- **StreamingToolExecutor 并发强化**（V5 决策 C）：`src/core/execute.ts` 演进——tool_use block
  一完整就 `addTool` 入队执行（不再等响应完结），只读并行（上限 10）/ 写串行且不打断，流结束
  统一 `getResults` 按 index 重排回填；transient 错误/反应式压缩路径先 drain 已启动的工具再重试。
  对外契约（结果顺序 / 错误文本 / 并发上限）不变，原并发用例全量回归锁定。

### Changed

- 权限引擎 `hasPermissionsToUseTool` 新增第 7 参 `readOnlyNames`（缺省 = 内置只读 ∪ explore，
  语义不变）；plan 分支插入统一判定顺序（plan 下 enter_plan_mode 放行、只读 cwd 内放行 /
  cwd 外 ask、其余 deny）。
- 内置工具 10 → 12：新增 `enter_plan_mode` / `exit_plan_mode`；`mcp_connect` 在配置了 MCP server
  时装配（第 13 个）；MCP 工具动态追加在最后、内置优先不覆盖。
- REPL 新增斜杠命令：`/plan`（进入只读计划模式）、`/mcp`、`/mcp connect <name>`。

## [0.4.3] - 2026-08-11

### Fixed

- **cwd 位于 8.3 短名路径下时 cwd 内访问误判 ask**（V4.5-9，CI 全平台暴露）：`hasPermissionsToUseTool`
  第 7 步的 Windows 可疑路径检查（决策 E）原来作用于「整个解析后路径」——GitHub Actions Windows runner
  的 `os.tmpdir()` 落在 `...\RUNNER~1\...`（8.3 短名）下时，cwd 前缀里的环境短名也命中 `~\d` 规则，
  导致 cwd 内一切读/写/改都被误判 ask（白名单决策 B 失效）。修复：新增 `suspiciousOutsideCwd`，
  可疑检查只作用于「cwd 之外的用户输入部分」（cwd 内 → 只查相对部分；cwd 外含 symlink 逃逸 real
  形态 → 全路径），纯函数 `hasSuspiciousPathPattern` 不改。真实场景：任何把工作目录建在含 8.3 短名
  路径下（CI runner / 部分企业镜像）的用户都会遇到过度询问。
- 测试扩充：新增「cwd 在 `~1` 短名路径下 → cwd 内不误判 ask」回归用例 → 共 **236 个用例**。

## [0.4.2] - 2026-08-11

### Removed

- **bypass 模式删除**（V4.5 决策 A）：`PermissionMode` 只剩 `default` / `acceptEdits`；
  `--mode bypass` 与 `--dangerously-skip-permissions` 两个入口移除（`--mode bypass` 由 commander 报非法值）。
  旧配置 / 环境变量里的 `"bypass"` 回退 `default` 并在启动时打印警告（温和降级，不崩溃）。

### Added

- **工作目录白名单（cwd 边界，决策 B）**：路径以 cwd 为界——cwd 内按模式兜底（只读免确认 /
  `default` 写询问 / `acceptEdits` 写免确认）；**cwd 外只读工具也询问确认**（修缺口：`read_file ~/.ssh/id_rsa`
  不再静默放行），`acceptEdits` 的免确认收窄到 cwd 内，越界访问唯一合法通道是用户 allow 规则。
- **危险目录黑名单（决策 C）**：`.git` / `.claude` / `.run-agent` 路径段**小写化逐段比较**无条件 deny
  （`read_file` 等任意路径工具，大小写变体同拦）；`run_bash` 命令文本引用 `.run-agent` 同样收口。
- **记忆读专属通道（决策 C）**：Trust 会话内 `read_file` / `glob` / `grep` 对 `.run-agent/memory/**`
  只读放行（判定在危险目录 deny **之前**）；写记忆仍只能走 `remember`。
- **Windows 路径模式检测（决策 E）**：UNC / 长路径前缀 / NTFS ADS / 8.3 短名 / 尾随点空格 / DOS 设备名 /
  三连点 → ask（不归一化，全平台跑）。
- **realpath 双形态硬化（决策 E）**：路径判定同时看 resolve 后与 realpath 后两种形态（含父目录回退），
  拦截 symlink 换名逃逸（`alias → .run-agent` / `alias → cwd 外`）。
- 测试扩充：权限引擎决策矩阵（白名单内外分流 / symlink 逃逸 / 大小写 / Windows 模式 / 专属通道顺序 /
  deny 优先于 allow）→ 共 **235 个用例**；CLI 冒烟覆盖非法 mode 回退与已删 flag 报错。

### Changed

- **统一判定顺序（决策 D）**：`hasPermissionsToUseTool` 重排为「内置危险命令 → 用户 deny → 专属通道 →
  危险目录 → bash 正则 → 用户 allow → 白名单(cwd) → 兜底 ask」，与 Claude Code「deny 先于一切 allow」对齐；
  用户 deny 规则不再与 allow 按"首条命中"短路，显式 deny 优先。
- 文档：`docs/permissions.md` 重写为三层模型 + 判定顺序；README / SECURITY / context-management /
  Plan_V4 / CLAUDE.md 同步移除 bypass 表述；新增 `docs/Bug_V4.md`、`docs/Bug_V4.5.md`（V4 / V4.5 开发期
  Bug 记录，含最关键的 symlink 逃逸修复 V4.5-3）。

## [0.4.1] - 2026-08-11

### Added

- **`repo_map` 定位工具**（决策 8.1）：两遍排序定位候选文件——第一遍 `git ls-files`
  （按 cwd+HEAD sha 缓存 60s）→ 段/扩展名过滤 → 按 文件名>路径段>其他 打分取 top-30；
  第二遍只对 top-N 做符号正则扫描（ts/js/py/go 顶层声明行），按 maxBytes 预算返回
  「候选文件 + 符号行」。`.git`/`.run-agent`/`node_modules`/`dist`/`coverage` 与二进制扩展名
  永不进候选；非 git 仓库退化为 readdir（上限 5000 文件），git 缺失/超时返回提示。
  只读、并发安全。
- **`explore` 只读探索子 agent**（决策 8.2）：嵌套 `runQuery`，只给 repo_map/glob/grep/read_file
  四件只读工具；thoroughness → 4/8/12 轮；上下文独立（超长自动压缩，不污染主会话）；复用主
  system（含记忆索引）；结论回填 tool_result。权限继承父级，ask 降级 deny 不另建 readline；
  子查询错误转为 tool_result 文本，不抛出。
- **`verify` 检查工具**（决策 8.3）：对改动文件跑项目脚本、把错误读回给模型自修。toolchain
  识别优先级 eslint 配置 > tsconfig.json（npx tsc --noEmit）> scripts.test（npm test）；
  命令模板白名单（只许 tsc/eslint/test 派生命令，拒绝任意命令）；120s 超时 + 30k 截断。
- 测试：repo_map（符号/文件名/路径段排序、黑名单排除、maxBytes 截断、readdir 降级）、
  explore（只读工具集、system 透传、轮数映射、超长触发压缩、异常兜底）、verify（toolchain
  矩阵、命令白名单、超时文本透传、30k 截断）——共 215 个用例。

### Changed

- 版本号 `0.4.0` → `0.4.1`；内置工具 7 个 → 10 个（新增 repo_map / explore / verify）。

## [0.4.0] - 2026-08-11

### Added

- **主动记忆（V4，Claude Code 式）**：`<cwd>/.run-agent/memory/` 下每条记忆一个独立 md 文件
  （frontmatter `name`/`description`/`type` + 正文），`MEMORY.md` 索引页（上限 200 行 / 25KB）
  在 Trust 会话注入 system 稳定段，模型按需 `read_file`/`grep` 读全文；记忆是快照，冲突以现状为准。
- **`remember` 工具工厂化 + `scope`**：默认 `scope="project"` 写项目级记忆（写 topic 文件 + 更新索引
  一步完成，按 `name` 去重更新，正文文件 16KB / 索引 200 行 / 25KB 守卫，索引超限先预检后写并回滚）；
  新增 `type`/`name`/`description` 参数；`scope="user"` 保留 0.3.2 用户级行为（仅用户明确要求时用）。
  项目级写入受 Trust 门控。
- **记忆读取豁免**：独立纯函数 `isMemoryReadExempt(tool, path, isTrusted)`——Trust 会话内
  `read_file`/`glob`/`grep` 对 `.run-agent/memory/**` 只读放行（判定在内置 deny 之前，V4.5 移专属通道时纯移动）；
  其余 `.run-agent` 访问与写工具/`run_bash` 命令仍全禁。
- **遍历层对齐（前拉 V4.5 决策 F）**：`glob`/`grep` 的 `ALWAYS_IGNORE` 加入 `.run-agent`，整目录扫不会带出记忆。
- **`run-agent memory` 子命令**：`list [query]` / `show <name>` / `rm <name>` / `prune [--days N]`（用户维护记忆，CLI 直读直写）。
- 文档 `docs/memory.md`（内容规范：条目类型 / 不存什么 / 何时读 / 生命周期 / 安全边界）。
- 测试：memory 模块、remember 工厂、权限豁免矩阵、MEMORY.md 注入、CLI 冒烟——共 192 个用例。

### Changed

- 版本号 `0.3.2` → `0.4.0`；`remember` 默认写入位置由用户级改为项目级（用户级仅显式 `scope="user"`）。

## [0.3.2] - 2026-08-11

### Added

- **`remember` 工具**（写入长期记忆）：把「用户明确要求记住 / 跨会话值得保留」的结论追加进
  用户级 `~/.config/run-agent/CLAUDE.md`（自动去重、超 32KB 拒绝写入），下次会话即被注入。
  只写用户级，`.run-agent` 对 agent 保持只读；走权限引擎（default ask / acceptEdits 免确认，
  可被用户规则 deny）。system prompt 增加记忆写入指引。
- 测试：remember 工具单测（首写/追加/去重/无换行追加/超限拒绝/空入参）+ 权限决策矩阵
  （default ask / acceptEdits allow / bypass allow / 用户规则 deny）——共 166 个用例。

### Changed

- 版本号 `0.3.1` → `0.3.2`；内置工具 6 个 → 7 个。

## [0.3.1] - 2026-08-11

### Added

- **反应式压缩**（0.3.1）：模型返回上下文超长错误（Anthropic `type=prompt_too_long` / OpenAI
  `code=context_length_exceeded` / 消息正则）时，在流式请求的 catch 分支**强制压缩**后重试
  （`force: true` 忽略估算阈值；每轮至多恢复一次，`reactiveStage` 守卫防死循环）；
  未配 `contextWindow` 时不做反应式压缩，直接抛原错误。
- **硬截断兜底**（0.3.1）：强制压缩后仍超长 → `hardTruncateToFit` 反复丢最老消息直到 fit；
  `normalizeToolPairing` 修复硬截断产生的孤儿 tool 消息（无配对 `tool_use` 的 `tool` 结果、
  无后续 `tool_result` 的 `tool_use` 块均被清理）；裁不动才抛原错误（有界，不无限循环）。
- 测试：errors（`isPromptTooLong` 各 provider 形态）、compact（force 压缩 / 硬截断 / 孤儿修复）、
  query（反应式压缩集成 / 硬截断兜底 / 无窗口直接抛）——共 157 个用例。

### Fixed

- **`.run-agent` 记忆目录对 agent 完全只读**：`run_bash` 命令文本里引用 `.run-agent` 路径段现在同样
  被内置 deny 收口（此前可经 shell 在用户批准下读/改记忆文件），与 `read_file`/`write_file`/`edit_file`
  的路径 deny 对齐；只收 `.run-agent`，不误伤 `.git` / `.claude` / 相似目录名。

### Changed

- 版本号 `0.3.0` → `0.3.1`。

## [0.3.0] - 2026-08-11

### Added

- **CLAUDE.md 四级记忆**（V3）：managed → user → project → local 自有路径自动发现并注入 system
  稳定段；project/local 级仅受信任项目注入（防提示注入）；`--bare` 全禁。
- **system 动态注入**（V3）：日期 + git 状态（分支/sha/最近 commit/git user/status，并发 execFile +
  3s TTL + 失败静默），稳定/动态分段保住 prompt cache 前缀。
- **token 估算 + 上下文自动压缩**（V3）：零依赖启发式（CJK 加权）；`contextWindow` 按 provider
  映射可配（`--context-window` / `RUN_AGENT_CONTEXT_WINDOW` / config）；超阈值整段摘要 → 单边界消息，
  已读文件本地重挂，`--resume` 从最后边界续起；REPL `/compact` 手动触发。
- **超大工具结果指针化**（V3 决策 8）：超 8192 token 的工具结果落盘到 session 同目录，
  消息列表只留指针，模型需要时自己 `read_file`。
- **`added` 持久化契约**（V3）：`runQuery` 经 `pushConversation(m)` 统一入队，compact 边界消息也走
  `added`；REPL / one-shot 改为 `messages = result.messages` + 逐条持久化 `result.added`。
- CLI 选项：`--bare`、`--context-window <n>`。
- **REPL 任务完成分隔线**：每轮任务结束输出清晰的 `✔ 任务完成` 标记，明确一轮已结束。
- 文档：新增 `docs/context-management.md`；`docs/architecture.md` 目录树与扩展点更新。
- 测试：context（估算/CLAUDE.md/system/git）、compact（阈值/边界/重挂/指针化）、query（主动压缩/
  递归守卫/指针化）、sessionStorage（边界加载）——共 141 个用例。

### Fixed

- **REPL 跨轮只喂 user 消息**（V1 遗留）：`added` 契约 + 数组替换修复，跨轮历史完整包含
  assistant/tool 消息。
- **权限确认多 y 回显 bug**（V2-11）：`resolveAsk` 复用 REPL 唯一 readline（注入 `ask` 函数），
  输入一个 `y` 不再回显成 `yy`/`yyy`；`checkPermission` 构造移入 `repl.ts` 的
  `makeCheckPermission(ctx, out, ask)`。

### Changed

- 版本号 `0.2.0` → `0.3.0`。
- `.prettierignore` / `vitest.config.ts` / eslint 全局 ignore 排除 `.claude/`（本地遗留 worktree
  不再污染测试与静态检查）。

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

- **项目骨架**：TypeScript + Node 20、tsup 打包、Vitest、ESLint/Prettier、三 OS CI。
- **CLI 空壳**：`--version` / `--help` / 单条 prompt 调用 Anthropic。
- **LLM 客户端抽象**（`LLMClient`）+ Anthropic 参考适配器。
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
