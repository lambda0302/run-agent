# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

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
