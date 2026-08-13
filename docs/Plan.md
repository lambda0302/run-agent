# 自建开源 Code Agent：功能清单与迭代路线图

> 调研日期：2026-08-10
> 调研素材：① `F:\CC_Source\claude-code-sourcemap`（Claude Code v2.1.88 反编译源码，1884 个 .ts/.tsx 文件）② GitHub 开源 Code Agent 生态（OpenHands / Cline / Aider / Goose / Gemini CLI / Crush / smolagents / crewAI / LangGraph 等）
>
> **项目名（已定）**：Run Agent —— npm 包名 / CLI 命令：`run-agent`
> **技术选型（已定）**：TypeScript + Node 20+ LTS ｜ 分发方式：npm 包发布 ｜ LLM：多提供商（Anthropic + OpenAI + 本地 Ollama + 各类 OpenAI 兼容模型如 DeepSeek）

---

## 一、项目定位

**这是一个面向公众的开源项目，不是个人工具。** 因此它同时是两样东西：

1. **一个可用的 Code Agent**：终端里用自然语言让 agent 读代码、改代码、跑命令、跑测试、交付。
2. **一个可维护、可被他人安装使用的开源项目**：有文档、有测试、有 CI、有跨平台支持、有许可证、有清晰的发布节奏。

**目标用户**：不满足于 Claude Code 等闭源工具的黑盒、想自选模型（便宜/本地/国产如 DeepSeek）、想二次开发或嵌入自己工作流的开发者。

**定位抓手**（与闭源工具的差异点，贯穿产品始终）：

- **多提供商**：用户的模型自己选——云上贵模型、便宜模型、本地 Ollama 私有部署、DeepSeek 等。
- **透明**：完整开源，行为可审计，权限边界可见。
- **轻量**：核心 loop 保持精简，把复杂度留给可插拔的扩展层。

> 项目名 **Run Agent**，npm 包名与 CLI 命令统一为 `run-agent`（npm 上单独的 `run` 已被占用，故使用全名）。

---

## 二、Code Agent 典型功能清单

综合 Claude Code 源码与生态项目，功能分三层。加粗项为**本项目因"公开、多提供商"定位而必须提前具备的能力**。

### A. 核心必备（V1 必须覆盖）

| #   | 功能                                                                      | Claude Code 参考实现                                                   | 生态佐证                                            |
| --- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------- |
| 1   | **Agent loop**：while 循环，tool_use/tool_result 回填                     | `src/query.ts` 的 `query()`/`queryLoop()`                              | OpenCode、smolagents 均如此                         |
| 2   | **工具调用机制**：名称+描述+JSON Schema+执行逻辑                          | `src/Tool.ts` 的 `Tool` 接口（zod 校验 inputSchema）                   | JSON schema 原生起步，MCP 次之                      |
| 3   | **文件工具**：Read / Write / Edit（精确字符串替换）/ Glob / Grep          | `src/tools/{FileRead,FileWrite,FileEditTool,GrepTool,GlobTool}/`       | 所有项目标配                                        |
| 4   | **命令执行**：Bash/PowerShell（超时+输出截断+后台化）                     | `src/tools/BashTool/BashTool.tsx`（默认 2min 超时、输出 30k 字符落盘） | Aider 默认不跑 shell，Cline/OpenCode 都做 bash tool |
| 5   | **流式输出**                                                              | `services/api/claude.ts` 流式封装                                      | REPL 逐 token 渲染                                  |
| 6   | **会话持久化**：JSONL/SQLite，支持 resume                                 | `src/utils/sessionStorage.ts`（逐行 JSONL 追加）                       | OpenCode 用 SQLite                                  |
| 7   | **只读/全量工具 preset**                                                  | 只读 preset（Read/Glob/Grep/WebFetch）                                 | 探索与执行分离                                      |
| 8   | **多提供商 LLM 抽象层**：统一消息/tool_use 格式，适配器化                 | `services/api/` 各 provider 适配                                       | Aider 三档模型；Cline 多 provider                   |
| 9   | **配置系统**：config 文件 + 环境变量 + `.env`（API key、provider、model） | `utils/auth.ts` + settings                                             | 多提供商的前提                                      |
| 10  | **跨平台**：ShellProvider 抽象、路径规范化                                | BashTool 的 shell 检测                                                 | 公共项目三 OS 基线                                  |

### B. 进阶功能（V2+ 逐步加入）

| #   | 功能                                                                                                           | Claude Code 参考实现                                                                         | 生态佐证                                                    |
| --- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 11  | **权限审批系统**：模式（default/acceptEdits/plan/dontAsk/bypass）+ 规则级 allow/ask/deny + 首次运行 Trust 对话 | `src/utils/permissions/`（`hasPermissionsToUseTool` 逐级短路；`PermissionRequest` 确认队列） | OpenCode 的 a/A/d、Crush `--yolo`、Gemini `--approval-mode` |
| 12  | **上下文工程**：系统提示组装（git 状态、日期）+ **compact 自动压缩**（fork-agent 摘要+文件 attachments 重建）  | `src/services/compact/`（`autoCompactIfNeeded`，阈值=窗口−13000）                            | OpenCode 95% 触发 autoCompact；Amp 用 TurnMemory            |
| 13  | **项目记忆文件**：CLAUDE.md / AGENTS.md 四级层级                                                               | `src/context.ts` 的 `getUserContext()` + `utils/claudemd.ts`                                 | 生态标准                                                    |
| 14  | **代码理解**：repo map（tree-sitter+PageRank）/ 符号索引 / LSP 诊断反馈                                        | ——（Claude Code 走 grep/glob + 只读子 agent）                                                | Aider repo map；OpenCode/Crush 接 LSP                       |
| 15  | **Plan 模式**：只读探索 + 计划文件 + 审批后执行                                                                | `EnterPlanModeTool` / `ExitPlanModeV2Tool` + `planAgent.ts`                                  | Cline Plan/Act、Plandex 全 Plan-first                       |
| 16  | **MCP 集成**：stdio/SSE/HTTP 传输、工具发现+权限、延迟加载                                                     | `src/services/mcp/`（`mcp__server__tool` 命名；Tool Search 省 token）                        | 行业事实标准                                                |
| 17  | **工具并发执行**：只读并行/写串行 + 流式边跑工具                                                               | `isConcurrencySafe()` + `toolOrchestration.ts` 的 `partitionToolCalls()`                     | ——                                                          |
| 18  | **Hooks / 生命周期**：PreToolUse/PostToolUse/SessionStart 等                                                   | `src/utils/hooks.ts`（execCommand/execHttp/execPrompt）                                      | Gemini extensions、Cline plugins                            |
| 19  | **Skills / Plugins**：SKILL.md 技能包、插件贡献命令/agent/skill/MCP                                            | `src/skills/` + `src/plugins/`                                                               | Crush、Gemini Agent Skills                                  |
| 20  | **自定义命令**：slash command 三形态（prompt/local/local-jsx）                                                 | `src/commands.ts` + `src/utils/processUserInput/`                                            | OpenCode markdown 命令                                      |
| 21  | **Headless / CI 模式**：`--print` + JSON 输出                                                                  | QueryEngine 无头路径                                                                         | Cline `--json`、Amp `-x`                                    |

### C. 生态功能（V8+）

TUI 打磨（Ink/React）· IDE 插件（VS Code/Neovim）· 远程/沙箱（Docker）· 评测（SWE-bench 子集）· 可观测（token 统计、成本、轨迹回放）· 消息平台接入（Slack/Telegram/Discord）· 定时任务（cron）

---

## 三、开源项目的硬性基线（贯穿所有版本的红线）

**这些不是"最后补"，是"从 V0 一直有"。** 每个版本的验收都同时包含功能目标 + 下述基线项：

| 基线                       | 内容                                                                                  | 起始版本             |
| -------------------------- | ------------------------------------------------------------------------------------- | -------------------- |
| **许可证**                 | MIT 或 Apache-2.0，`LICENSE` 文件 + 各文件头或仓库级声明                              | V0                   |
| **测试**                   | Vitest；agent loop 单测、工具单测、集成测试（golden 场景）                            | V0 框架，V1 首批用例 |
| **CI**                     | GitHub Actions：`test + lint + typecheck + build` 跑 Windows/macOS/Linux 三 OS matrix | V0                   |
| **文档**                   | `README.md`（快速开始/特性/截图/FAQ）+ `docs/` 目录（架构、配置、权限、FAQ）          | V0 骨架，随版本填充  |
| **安全政策**               | `SECURITY.md`（漏洞上报流程）+ `code of conduct`                                      | V2（有权限系统后）   |
| **社区模板**               | issue 模板（bug/feature）、`CONTRIBUTING.md`、changelog                               | V0                   |
| **语义化版本 + CHANGELOG** | `0.x` 起步，破坏性变更进 minor；每次发布更新 CHANGELOG                                | V1 首次 release 起   |
| **跨平台**                 | 每个合并的 PR 都必须过三 OS 测试                                                      | V0 起                |
| **可观测埋点**             | 日志分级、`--verbose`、错误堆栈可定位                                                 | V1 起                |

**关键态度**：一个"别人要用的工具"，README 写不清楚、装不上、在某个 OS 上崩，都会直接杀死项目。文档和测试与功能是同一个版本的验收标准，不是分开的两条线。

---

## 四、迭代路线图总览

**原则**：① 先做"可演示的端到端闭环 + 可安装的 npm 包"，再补 UI；② 权限安全不可晚于上下文管理（V2 与 V3 顺序不能调换）；③ 上下文工程决定可用性上限，越早越好；④ 多 agent 放最后——先保证单个 agent 可靠再谈协作；⑤ 每个版本都带着"开源交付物"交付（文档/测试/CI 同步更新）。

```
V0 项目地基 ─→ V1 ReAct MVP + 多提供商 + 首个release ─→ V2 安全并发 + Trust ─→ V3 记忆上下文
                                                                                      │
V9 发布与生态 ←─ V8 系统能力完善 ←─ V7 多Agent ←─ V6 可编程化 ←─ V5 Plan+MCP+并发强化 ←─ V4 代码理解
```

| 版本 | 主题                  | 核心目标                              | 用户点名功能                          |
| ---- | --------------------- | ------------------------------------- | ------------------------------------- |
| V0   | 项目地基              | 开源脚手架 + 技术栈落定               | ——                                    |
| V1   | ReAct MVP + 多提供商  | 端到端闭环 + 首个公开 release `0.1.0` | **ReAct**                             |
| V2   | 安全与并发 + Trust    | 权限引擎 + 工具并发 + 安全文档        | **并发（工具层）**                    |
| V3   | 记忆与上下文          | 不爆上下文、能续跑                    | **记忆管理**                          |
| V4   | 代码理解 + 主动记忆   | 大仓库定位准、跨会话记得住            | ——                                    |
| V5   | Plan + MCP + 并发强化 | 计划先行 + 标准协议 + 并行            | **Plan and Execute + MCP + 并发强化** |
| V6   | 可编程化              | Hooks/Skills/命令/Headless            | ——                                    |
| V7   | 多 Agent              | coordinator+specialist 编排           | **multiAgent**                        |
| V8   | 系统能力完善          | 权限加固 + 可靠性 + 真实模型验证      | **权限重构（expected-permissions.md）** |
| V9   | 发布与生态            | 评测公开、TUI/IDE、社区运营           | ——                                    |

---

## 五、各版本详细规划

### V0 —— 项目地基（1 周）

**目标**：一个"别人也能跑起来"的仓库骨架，技术栈落定。

- **仓库初始化**：GitHub 仓库、`.gitignore`、`LICENSE`（MIT）、`README.md` 骨架、`CONTRIBUTING.md`、issue 模板、`CODE_OF_CONDUCT.md`、`CHANGELOG.md`。
- **技术栈**：Node 20+ LTS + TypeScript（strict 模式）+ Vitest + tsup（ESM 打包成 CLI）。包名 / CLI 命令：`run-agent`。
- **工程骨架**：
  - `package.json`：`bin` 字段（`run-agent` 命令）、`files` 白名单、`engines: node >= 20`。
  - 目录：`src/core/`（loop）`src/tools/` `src/providers/` `src/cli/` `tests/` `docs/`。
  - CI：GitHub Actions 三 OS matrix（test + lint + typecheck + build）。
- **CLI 空壳**：`run-agent --version` / `--help` 可用，`run-agent "hello"` 至少能调用一次模型回复。
- **验收**：clone 后 `npm install && npm test` 三 OS 全绿；`npm install -g` 后 `run-agent --help` 可用。

---

### V1 —— ReAct MVP + 多提供商（2~3 周，交付 `0.1.0`）

**目标**：终端里用自然语言让 agent 改一个真实文件并跑通测试；**这是第一个对外可安装的 release**。

**核心功能**：

1. **LLM 抽象层**（多提供商，本项目的立身之本）：
   - `LLMClient` 接口：`stream(messages, {tools})`，统一内部消息格式与 tool_use 解析。
   - 适配器：
     - `AnthropicAdapter`（`@anthropic-ai/sdk`，原生 tool_use）
     - `OpenAIAdapter`（`openai`，function calling）
     - `OpenAICompatibleAdapter`（复用 OpenAI 适配器 + `baseURL` 覆盖 → 一个适配器覆盖 **DeepSeek、Qwen、vLLM、本地推理**等几乎所有兼容服务）
     - `OllamaAdapter`（本地，`baseURL` 指向本地服务）
   - **约 2 个适配器实现 + 配置切换**即可覆盖三大类，工作量可控。
2. **Agent loop**：`while(true)` 状态机（组装 messages → 调模型 → 有 tool_use 执行 → 回填 → 直到无 tool_use），参考 `query.ts`，保持极简（200~400 行）。
3. **内置工具**：`Read / Write / Edit（精确字符串替换）/ Glob / Grep / Bash`。Bash 从第一天就带超时+输出截断+后台化。
4. **跨平台 Bash**：`ShellProvider` 抽象——Windows 走 PowerShell（或检测 git-bash），macOS/Linux 走 bash；路径统一用 `path` 库规范化。
5. **配置系统**：`~/.config/run-agent/config.json` + 环境变量 + `.env`（provider、model、API key）。`run-agent --provider openai --model deepseek-chat` 等。
6. **会话持久化**：JSONL 逐行追加，支持 `--resume`。
7. **极简 REPL**：readline 起步，能敲 prompt、看流式输出、看工具执行。

**开源交付物**：

- README：快速开始（三 OS）、多提供商配置表（含 DeepSeek/Ollama 示例）、特性清单、截图。
- 首批测试：agent loop 单测、Edit 工具单测、OpenAI 兼容适配器集成测试（mock 服务）。
- CHANGELOG 建立；打 tag `v0.1.0`。

**验收**：`npm install -g @liyiyong/run-agent` 后，一个从未见过本项目的用户按 README 能在 5 分钟内用它改一个文件；三种模型来源（Anthropic / DeepSeek / Ollama）都能跑通；三 OS CI 绿。

---

### V2 —— 安全与并发 + Trust 模型（2 周，交付 `0.2.0`）

**目标**：agent 变得可信任。**此版不可跳过、不能与 V3 调换**——没有安全边界，上下文越强越危险。公共项目尤其如此。

**核心功能**：

1. **权限审批系统**：
   - 模式起步：`default`（危险操作询问）/ `acceptEdits`（文件编辑免确认）/ `bypass`（`--dangerously-skip-permissions`）。
   - 规则级 allow/ask/deny 逐级短路管线（参考 `hasPermissionsToUseTool`）；交互确认队列（危险命令如 `npm publish`、`rm -rf` 弹确认）。
   - 安全底线：`.git/`、`.claude/` deny；Bash 命令语义分类。
   - **首次运行 Trust 对话**：是否信任本项目的配置/hooks（防提示注入）。
2. **工具并发执行**：`isConcurrencySafe()` 标注 + `partitionToolCalls()`（只读并发批 / 串行写批，max concurrency 10）。
3. **错误重试**：工具异常回填 tool_result 让模型自愈；`max_output_tokens` 恢复。

**开源交付物**：

- `SECURITY.md`（漏洞上报流程）；README 增加"安全模型"章节（权限模式、Trust 对话怎么工作）。
- 权限引擎测试（allow/ask/deny 判定矩阵、危险命令拦截）。

**验收**：危险命令被拦截；未授权不改文件；一次多文件编辑能并行跑只读搜索；README 讲得清权限模型。

---

### V3 —— 记忆与上下文管理（2~3 周，交付 `0.3.0`）

**目标**：跑长任务不爆上下文，跨会话不"失忆"。**决定可用性上限，多数 agent 翻车在此。**

**核心功能**：

1. **上下文组装升级**：system prompt 动态注入日期、git 状态（分支/status/最近 commit）、git user。
2. **项目记忆文件（CLAUDE.md 机制）**：自动发现 managed→user→project→local 四级；自动注入；`--bare` 禁用。
3. **上下文压缩（compact）**——最硬核：
   - token 估算 + 自动压缩阈值（窗口 − 13000 buffer）。
   - **fork-agent 摘要**：压缩时启动子请求生成摘要（`querySource='compact'` 防递归）。
   - **消息重建**：compact boundary + 摘要 + 重新 attach 读过的文件（否则压缩后模型"失忆"）。
   - prompt_too_long 的 reactive compact + 截断重试。
4. **会话操作**：`--resume`、`/clear`、`/compact`。

**开源交付物**：`docs/context-management.md`（压缩策略、CLAUDE.md 约定）；压缩的集成测试（长对话→摘要→续跑正确性）。

**验收**：连续 10+ 轮工具调用不爆上下文；压缩后已读文件仍可恢复；resume 后能续接任务；多提供商下压缩都正常。

---

### V4 —— 代码理解 + 主动记忆（2~3 周，交付 `0.4.0`）

**目标**：大型仓库里"定位要改的文件"更准，跨会话"记得住教训"——定位准 + 学得进。

**核心功能**：

1. **Repo map（可选高价值）**：tree-sitter 提取符号 → 引用 PageRank → 二分塞进 token 预算。可用简单版替代（git 索引 + 符号表）。
2. **LSP 诊断反馈**：接入 LSP 读 diagnostics，agent 改完自见 lint/编译错误并自修（Cline/OpenCode 核心体验）。
3. **探索型只读子 agent**：代替主 agent 深读（为 V7 铺路）。
4. **主动记忆管理**：从"被动读 CLAUDE.md"升级为"agent 自动学习"——
   - **写入**：任务收尾时把稳定结论（测试命令、文件定位、踩过的坑、关键决策）以结构化条目写进项目记忆文件（零依赖、人类可读，如 `.run-agent/memory/`）；写入走权限管线 + Trust 门控（需用户确认，防提示注入）。
   - **检索**：启动 / `--resume` 时按关键词 / 最近命中把相关记忆注入 system，而非全量塞（复用 V3 的 compact 摘要与 `collectClaudeFiles` 四级结构）。
   - **生命周期**：条目可查、可删、可过期（`run-agent memory` 子命令）。

**开源交付物**：`docs/architecture.md`（架构说明）；`docs/memory.md`（记忆格式约定 + 检索策略）；LSP 接入测试；记忆写入/检索集成测试；大仓库 demo 用例。

**验收**：10k+ 文件仓库里 1-2 步定位真正要改的文件；改动后能读回 lint 错误；**两次会话间，第二次能引用第一次沉淀的结论（如"测试跑法是 npm test"）**。

---

### V5 —— Plan and Execute + MCP + 并发强化（2~3 周，交付 `0.5.0`）

**目标**：复杂任务先出计划再执行；接入标准协议生态；并行上台阶。**用户点名功能集中落地。**

**核心功能**：

1. **Plan 模式**：只读探索（plan 下禁写工具）→ 计划写入 plan 文件 → 用户审批 → 退出恢复权限模式。`EnterPlanMode` / `ExitPlanMode` 两工具。可选只读 planAgent 子 agent。
2. **MCP 客户端**：基于 `@modelcontextprotocol/sdk`，stdio / SSE / Streamable HTTP；`listTools` → `mcp__server__tool` 命名 → 包装成标准 Tool 进池（内置优先）；连接状态机（connected/failed/needs-auth/disabled）；MCP 工具走同一权限管线；**延迟加载工具 schema 省 token**。
3. **并发强化**：StreamingToolExecutor（模型边流式边并行执行工具）；后台任务/任务级并发。

**开源交付物**：`docs/mcp.md`（接入指南、示例 server）；`docs/plan-mode.md`；MCP 集成测试（mock server）；MCP server 使用示例。

**验收**：能接 1 个真实 MCP server（如 filesystem/GitHub）并调其工具；复杂任务先展示计划再动手；长时间任务工具并行执行。

---

### V6 —— 可编程化（2 周，交付 `0.6.0`）

**目标**：用户能定制、CI 能无头跑。**这是公共项目被采纳的关键驱动**——可扩展性即产品力。

**核心功能**：

1. **Hooks**：PreToolUse（可输出 permissionDecision）/ PostToolUse / SessionStart / SessionEnd / Stop；execCommand + execHttp 两种执行方式。
2. **Skills**：扫描 `.claude/skills/`，解析 frontmatter（name/description/allowed-tools）转可调用命令；SkillTool 让模型运行时调用。
3. **自定义命令**：slash command 三形态（prompt / local / local-jsx）。
4. **Headless 模式**：`--print` + JSON 输出，供 CI/脚本/IDE 集成。

**开源交付物**：`docs/hooks.md`、`docs/skills.md`、`docs/commands.md`；hooks 集成测试；无头模式 JSON 输出契约。

**验收**：CI 里无头跑一个任务拿到 JSON；一个 hook 触发自动动作（改完自动跑测试）；用户自定义一条斜杠命令；README 有二次开发入口。

---

### V7 —— 多 Agent 编排（2~3 周，交付 `0.7.0`）

**目标**：coordinator + specialist 团队分工完成跨模块任务。**放最后：单 agent 不可靠时，多 agent 只会放大问题。**

**核心功能**：

1. **子 agent（Task/subagent）**：`Agent` 工具（subagent_type / model / run_in_background）；`runAgent` 对 `query()` 递归复用 + 独立 context/abort/transcript；内置类型 general-purpose / explore（只读）/ plan / verification；权限继承与覆盖。**0.4.1 的 `explore` 在此泛化**：补 `run_in_background` 后台运行与 `model` 选择（外部用户可换低成本模型）；`thoroughness`（quick/medium/very thorough）已在 0.4.1 落地。
2. **Coordinator 模式**：主 agent 换"协调者" system prompt，只用 Agent/SendMessage/TaskStop 三件套拆解委派 worker。
3. **验证专家子 agent**（蓝本：Claude Code `verificationAgent.ts`，与 0.4.1 `verify` 工具的关系：verify 是单文件基线——跑 tsc/eslint/test 读回错误；本项是子 agent 级对抗性验证，0.4.1 不替代）：按改动类型分策略（前端起 dev server+浏览器自动化、后端 curl+边界值、bug fix 复现原始 bug+回归、重构要求既有测试原样通过）+ 强制步骤（构建→测试→lint→回归）+ 反合理化清单（"代码看着对"→ 跑起来；实现者测试过了 → 独立验证）+ 对抗探针（并发/边界/幂等/孤儿）。**输出契约**：每条 check 必须带 `Command run`+实际输出，收尾 `VERDICT: PASS/FAIL/PARTIAL`，无命令输出的 PASS 判拒。**强制只读**：禁写项目文件，临时脚本只许 /tmp。**主 agent 契约**：非平凡改动（3+ 文件/后端/API/基础设施）完成前必须 spawn 验证 agent——FAIL → 修 → resume 验证 → 直到 PASS；PASS → 主 agent 自行 spot-check 2-3 条命令复核。
4. **后台记忆提取子 agent**（0.4.0 记忆只做单轨，双轨在此落地；蓝本：Claude Code `extractMemories.ts`）：每个完整 query loop 结束（模型产出无工具调用的最终回复）触发一次提取——作为 `Agent` 工具的一个 background 子 agent（独立 transcript + `run_in_background`），fork 主对话上下文（共享 prompt cache）分析最近 N 条消息 → 更新 `.run-agent/memory/`。**保存策略**：有限 turn 预算（第一轮并行 read、第二轮并行 write）；四类 frontmatter + WHAT_NOT_TO_SAVE 规范 + 先查现有记忆再更新（防重复）；**主 agent 本轮已写过（hasMemoryWritesSince）则跳过**，避免重复。**触发开关**：仅 Trust + 非 `--bare`（可选）。**成本**：每 user turn 一次额外 LLM 调用——V7 阶段用低成本模型跑（同 explore 的模型选择）。**目标**：补上"主 agent 专注任务时忘了沉淀"的可靠性缺口。
5. **团队状态持久化**：跨会话保留 agent 定义。

**开源交付物**：`docs/agents.md`（子 agent 类型、如何自定义 agent frontmatter）；多 agent 集成测试。

**验收**：一个跨模块任务由多个 specialist 分工完成、结果汇总正确。

---

### V8 —— 系统能力完善（权限重构后正式启动）

> **状态（2026-08-13）：0.8.0 已发布。** 原 V8「发布与生态」整体顺延为 V9，V8 号专做**系统能力完善**——
> 权限加固、可靠性、真实模型验证、性能稳定性等工程强化，后续此类条目一律归本桶。本次权限重构
> （`docs/expected-permissions.md` 实现）即 V8 首个交付，已随 **0.8.0** 发布（`docs/permissions.md`、
> SECURITY.md、CLAUDE.md、README、CHANGELOG 已同步）。

- **权限重构（`expected-permissions.md`，已实现）**：`run_bash` 从「一律问」改为**六分类影响半径判定**
  （`BashDanger`：`dangerous` 硬拒 / `readonly` R0 闭集自动 allow / `network`·`local-exec`·`http-get`·`write`
  兜底 ask）；判定链**收口前置单线**（用户 deny → 内置危险命令 → 命令文本危险段 → 记忆豁免 → 路径危险段
  → plan 分支 → 导航工具 → 用户 allow → 白名单兜底）；P1 堵 plan 绕过、P2 acceptEdits 只预授权
  `write_file`/`edit_file`、P3 用户 deny 最前、P4 危险命令变体（`git -C` 强推 / `dd of=//dev` / 管道 rm）、
  P5 三目录段命令文本收口（`.git`/`.claude`/`.run-agent`）；同步 verification / verify 的 classify 语义。
  测试 530 用例 + typecheck + lint 全绿；`docs/permissions.md`、CLAUDE.md 已同步。
- **V7 权限遗留（`docs/Bug_V7.md` 待修，P1/P3 优先）**：修完并入 V8。
- **真实模型手动验证（需 key）**：六分类下 REPL 实际弹窗行为、verification 放行/拒绝、R0 自动放行、
  plan 下危险段 deny。
- **后续系统能力完善桶**：权限 / 可靠性 / Bug 修复 / 性能稳定性等工程强化条目在此积累。

### V9 —— 发布与生态（持续）

> **状态（2026-08-13）：顺延。** 原 V8「发布与生态」整体顺延为 V9，V8 号让给系统能力完善（权限重构）。
> 会话切换 / select UI（V2.5 推迟项）归本桶。

**目标**：从"能用"到"好用、有社区、有第三方信任"。

- **发布流水线**：`npm publish` 自动化（GitHub Actions release 触发）、版本 tag 自动 CHANGELOG、`0.x → 1.0.0` 稳定性声明。
- **TUI 打磨**：Ink/React 渲染、工具执行可视化、权限确认框、进度条。
- **评测公开**：跑 SWE-bench 子集 / GitTaskBench 建立客观基线并写进 README（如 "SWE-bench 子集 X%"），用 benchmark 驱动迭代。
- **IDE 集成**：VS Code 扩展（或先做 MCP client / ACP 接入）。
- **沙箱**：Docker 沙箱隔离执行（参考 OpenHands）。
- **可观测**：token/成本统计、`--verbose` 轨迹导出。
- **社区运营**：Issue 标签体系、讨论区、Good First Issue、发布说明、用户案例。

---

## 六、关键架构决策与陷阱

1. **工具接口从 V1 就定对**：`Tool` = name + description + zod schema + call + isConcurrencySafe。MCP 工具、skill 工具、子 agent 工具全部复用此接口——这是 Claude Code 可扩展性的根基。
2. **LLM 抽象层是 V1 的核心工作而非附带**：不同 provider 的 tool_use 消息格式不同（Anthropic 的 `tool_use`/`tool_result` block vs OpenAI 的 `tool_calls`/`tool` role），必须统一成内部消息格式。**prompt caching 各 provider 机制不同**，缓存分界标记（`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`）要放进适配层而非各适配器重复实现。OpenAI 兼容适配器（一个 + baseURL）是覆盖 DeepSeek/Qwen/本地推理的最大杠杆。
3. **上下文压缩 ≠ 简单截断**：必须做「fork-agent 摘要 + 文件 attachments 重建」，否则压缩后模型"失忆"。这是 V1 就要预留的抽象。
4. **权限是功能不是附加**：`checkPermissions` 从第一天就存在于工具调用管线（哪怕初版直接 allow），避免后期重构。公开项目还要做 Trust 对话（防提示注入）与 `SECURITY.md`。
5. **跨平台是公共项目的硬约束**：Bash 工具的 ShellProvider、Windows 的 UNC/大小写/反斜杠、进程 kill/后台任务，全部从 V1 按三 OS 设计，靠 CI matrix 兜底。
6. **MCP 的时机**：V5 接入而不是 V1——先稳定自己的工具 schema，但 V1 的工具抽象按"MCP 是一种工具来源"设计。
7. **并发分两层**：工具级并发（V2，只读并行/写串行）与 agent/任务级并发（V5-V7，后台子 agent）。别把并发当单点功能堆。
8. **System prompt 动态边界**：把每轮变化的部分（git 状态、日期、token 统计）与稳定部分分开，避免破坏 prompt cache 前缀、控制成本。
9. **测试是产品的镜子**：agent loop 要能注入 mock LLM（确定性 golden 场景）；权限判定做矩阵测试；多提供商集成测试用本地 mock server，不依赖真实 API 密钥。
10. **发布节奏**：每个版本都打 tag、更新 CHANGELOG、发 `0.x.0`——让用户能追踪演进，也让你的迭代有据可查。

---

## 七、参考项目清单

**源码参考（逆向架构）**：

- `F:\CC_Source\claude-code-sourcemap\restored-src` —— Claude Code v2.1.88 反编译源码，重点文件：
  - `src/query.ts`（agent loop）、`src/Tool.ts`（工具接口）、`src/tools.ts`（工具注册）
  - `src/services/compact/`（上下文压缩）、`src/utils/sessionStorage.ts`（会话）
  - `src/utils/permissions/`（权限引擎）、`src/tools/AgentTool/`（子 agent）、`src/coordinator/`（多 agent）
  - `src/services/mcp/`（MCP 客户端）、`src/utils/hooks.ts`（hooks）、`src/skills/` + `src/plugins/`
  - `src/constants/prompts.ts`（system prompt 分区）

**开源项目**：

- OpenHands（83.6k）—— 通用 AI 软件工程师，Agent Server + Canvas + Software Agent SDK，SWE-bench 77.6%
- Cline（66k）—— IDE 插件 + SDK + CLI，Plan/Act、多 agent 团队、cron，**多 provider 参考**
- Aider（48k）—— repo map（tree-sitter+PageRank）、git 集成、Architect/Editor 双模型，**多模型架构参考**
- Goose（~52k，Linux 基金会 AAIF）—— 通用本地 agent，70+ 扩展全走 MCP
- Gemini CLI / Crush（原 OpenCode）/ Amp —— 终端 TUI agent，LSP、Agent Skills
- smolagents（28.7k）—— 核心 loop <1000 行，动作即 Python 代码
- crewAI（57k）/ LangGraph（39k）+ deepagents —— 多 agent 编排框架

**文档**：

- Claude Code 官方文档（code.claude.com/docs）：Agent Loop / Tools 参考 / Glossary
- Aider repo map 技术博客、OpenHands Software Agent SDK 技术报告

---

## 附：版本节奏总表（复盘用）

| 版本 | 版本号 | 交付物                                             | 关键验收一句话                              |
| ---- | ------ | -------------------------------------------------- | ------------------------------------------- |
| V0   | ——     | 开源脚手架 + CI + 空壳 CLI                         | clone 后三 OS 测试全绿                      |
| V1   | 0.1.0  | ReAct MVP + 多提供商 + 配置 + 跨平台 + README/测试 | 陌生用户 5 分钟上手改文件；三种模型来源跑通 |
| V2   | 0.2.0  | 权限引擎 + Trust + 工具并发 + SECURITY.md          | 危险命令被拦截，只读并行执行                |
| V3   | 0.3.0  | compact + CLAUDE.md + resume                       | 10+ 轮不爆上下文                            |
| V4   | 0.4.0  | repo map / LSP / 探索子 agent / 主动记忆           | 大仓库 1-2 步定位文件；跨会话引用教训       |
| V5   | 0.5.0  | Plan 模式 + MCP + 流式并发                         | 接上 1 个 MCP server                        |
| V6   | 0.6.0  | Hooks + Skills + 命令 + Headless                   | CI 无头跑通出 JSON                          |
| V7   | 0.7.0  | 子 agent + coordinator                             | 多 agent 分工完成跨模块任务                 |
| V8   | 0.8.0  | 权限重构（六分类）+ 系统能力完善 + 真实模型验证      | 六分类稳定、Bug_V7 待修清零                  |
| V9   | 1.0.0+ | TUI + IDE + 沙箱 + 评测 + 发布流水线               | 过 benchmark，可远程部署                    |
