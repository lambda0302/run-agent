# Plan V6 — 可编程化(Hooks + Skills + 自定义命令 + Headless，交付 0.6.0)

> 上游:`docs/Plan.md` 路线图 V6 段(243-256 行):「用户能定制、CI 能无头跑。**这是公共项目被采纳的关键驱动——可扩展性即产品力。**」
> 上一版本交接:`docs/Plan_V5.md`(0.5.0 Plan 模式 + MCP 客户端 + StreamingToolExecutor)+ `docs/Bug_V5.md`(0.5.1 两处真实使用修复:Plan 拒绝语义、权限弹窗输出缓冲)。**V0–V5 全部已实施并发布**(CHANGELOG 0.1.0 → 0.5.1 全绿,详见 §0)。
> 本版本一句话:**让 run-agent 能被"编程"**——事件钩子(Hooks)让用户挂自定义动作(改完自动跑测试、危险操作自动拦截);技能(Skills)让模型按需加载 run-agent 自有路径下的技能指令;自定义斜杠命令让用户定义自己的 `/` 命令;Headless 让 CI/脚本/IDE 无头跑并拿结构化 JSON。
> 触发:路线图 V6 段为既定范围;2026-08-12 核验 V5 交付(0.5.0 + 0.5.1)与 Bug_V5.md 记录后,确认进入 V6。
> 参考实现:`F:\CC_Source\claude-code-sourcemap\restored-src` —— Hooks(`src/hooks/`、`src/services/hooks/`)、Skills(`src/services/skills/`、`src/services/commands/SkillTool.ts`)、自定义命令(`src/commands/` 数十个内置 + `src/services/commands/prompt.ts`)。本版对齐其语义、裁剪其规模。
> 工期参考:≈ 2 周,交付 `0.6.0`。

## §0 结论速览

**前置核验(V0–V5 实施状态,2026-08-12)**:

- **代码/交付物层面全部实施完毕**:V5(0.5.0 Plan + MCP + StreamingToolExecutor)与 0.5.1(Plan 拒绝语义双保险 + 权限弹窗输出缓冲)已发布;npm latest = 0.5.1,CI 9 job(3 OS × Node 20/22/24)全绿。V5 实施 bug 记录在 `docs/Bug_V5.md`(2 真 bug + 1 误报 + 1 产品缺口)。
- **V5 DoD 仅剩「真实模型手动验证(需 key)」**:Plan 模式工作流、真实 MCP server(stdio/http/sse)接入、流式并行执行——不是代码缺口,是「有 key 的手工验证」,持续列为每个版本验收尾项。
- **CLAUDE.md / CHANGELOG 为唯一进度真相**:历史计划文档 DoD 复选框多为写作时勾选,实际完成度以 CHANGELOG + tag + CI 为准。

**V6 交付什么**:

1. **Hooks**(决策 A):`PreToolUse`(可输出 `permissionDecision` 影响权限判定)/ `PostToolUse` / `SessionStart` / `SessionEnd` / `Stop` 五类事件;`execCommand` + `execHttp` 两种执行方式;配置 `settings.json`(用户级 + Trust 项目级);matcher 按工具名正则挂接。安全底线:内置危险命令 deny 不可被 hook 放行。
2. **Skills**(决策 B):扫描 run-agent **自有路径** `.run-agent/skills/<name>/SKILL.md`(项目,Trust 门控)+ `~/.config/run-agent/skills/`(用户级,始终);**格式对齐 Claude Code**(frontmatter + body,现成技能拷目录即用);解析 frontmatter(name/description/allowed-tools),注册 `SkillTool` 让模型运行时调用(加载指令 + 按 allowed-tools 限制工具);同时注册 `/name` 斜杠命令。**子 agent 化 skill 明确留 V7**(无子 agent 基建)。
3. **自定义命令**(决策 C):slash 命令三形态中的 **prompt(.md 模板)** 与 **local(脚本)** 两形态落地;`local-jsx`(React 组件)因 run-agent 无 TUI/Ink 渲染器**明确推到 V8**(TUI 打磨那版)。
4. **Headless 模式**(决策 D):`run-agent --print "prompt"` + `--json` 结构化输出(最终回复 + 消息 + 工具轨迹含权限判定 + 会话文件);退出码 0/1;CI 用 `--mode acceptEdits` 免弹窗跑写类任务。

**技术栈增量**:

- **零新依赖**:hooks 执行用 `node:child_process` spawn + `node:http/https`;skills/commands 用 `node:fs` 扫描 + 简单 frontmatter 解析(可复用现有 zod 做 schema 校验);headless 用 `JSON.stringify`。
- 新增目录:`src/services/hooks/`、`src/services/skills/`、`src/services/commands/`;新增文档 `docs/hooks.md` / `docs/skills.md` / `docs/commands.md` + headless 契约进 `docs/usage.md`。
- 复用现有:`Tool` 接口 / checkPermission 管线 / system 动态段注入 / REPL readline / Trust 门控 / `loadConfig` 配置层级。

**不做的事(留待后续,诚实标注)**:

- **`local-jsx` 命令形态**:需要 React/Ink 渲染器,run-agent 的 REPL 是纯 readline 文本,无渲染面 → **V8**(TUI 打磨,roadmap V8「Ink/React 渲染」同版)。
- **子 agent 化 Skill**:Claude Code 的 SkillTool spawn 子 agent(独立 context + allowed-tools 限制);run-agent 无子 agent 基建 → V6 用「主循环内加载指令 + 工具列表过滤」近似,**V7 随 Agent 工具泛化升级**。
- **更多 hook 事件**:Notification / PreCompact / SubagentStop / PreCompact 等 → 后续;V6 只交 roadmap 点名的 5 类。
- **hook stdout 注入 system(除 Stop 外)**:Claude Code 的 Stop hook stdout 注入下一轮系统上下文;V6 只做 **Stop 注入**,PostToolUse/Session* 的 stdout 仅展示/记录,不注入(防第三方 hook 输出污染上下文)。
- **hook 的 `json` 输出字段完整版 / 分支(if/else)**:V6 只做 matcher + permissionDecision + 超时/退出码契约;分支与更多 hook 能力 → 后续。

---

## §1 架构决策

### 决策 A:Hooks(五类事件 + 两种执行 + 权限整合)

**动机**:「改完自动跑测试」「危险操作自动拦」这类用户脚本化需求是公共项目被采纳的核心驱动;roadmap 点名。

**A1. 事件与触发点(五类)**

| 事件 | 触发点 | 行为 |
| ---- | ------ | ---- |
| `PreToolUse` | `makeCheckPermission` 内,engine 判定之后、最终决策之前 | 可返回 `permissionDecision` 覆盖判定(见 A4) |
| `PostToolUse` | `execute.ts` settle 之后 | stdout 展示;带 tool_use + tool_result |
| `SessionStart` | `runRepl` / `runOneShot` 入口 | stdout 展示 |
| `SessionEnd` | REPL 退出 / one-shot 结束 | stdout 展示 |
| `Stop` | 每轮 `runQuery` 结束(最终回复产出) | **stdout 注入下一轮 system 动态段** |

- 触发点选择:**PreToolUse 挂在 `makeCheckPermission`**(REPL 与 one-shot 共用此入口,`runOneShot` 以 `ask=undefined` 调它,`index.ts` 的 `exploreCheckPermission` 是子查询通道不走 hook)——单点接线,不改 execute 主路径。
- **PostToolUse 挂 execute settle**:`ExecuteOptions` 新增可选 `onPostToolUse?(item)`;`StreamingToolExecutor.settle` 里触发(未知工具/权限 deny 的 settle 也触发,带 result 为提示串)。MCP 工具与 plan 导航工具天然覆盖。
- **Stop 注入**:`query.ts` 的 `onStop` 回调(或复用在 `onCompact` 同层),stdout 非空时并入下一轮 `buildSystemPrompt` 的动态段(前缀 `--- hook output ---`,标记来源防与稳定段混)。

**A2. 执行方式(`execCommand` + `execHttp`)**

- `execCommand`:spawn(win32 用 `resolveShell()` 现有壳,与 run_bash 同源),`{ command, timeout(ms) }`;捕获 stdout/stderr(各 64KB 上限,防 hook 灌爆);退出码非 0 → 把 stderr 尾部并入 hook 输出。超时 → kill(沿用 run_bash 的 kill 逻辑)。
- `execHttp`:`POST` 到 `{ url, headers?, body? }`,60s 超时,`Content-Type: application/json`(body 为结构化 JSON)。
- **输出解析**:优先 `JSON.parse(stdout)`(hook 返回 `{ json: true }` 标记则必须为合法 JSON,否则报错);否则原样字符串。
- 进程回收:与 run_bash 同款 SIGINT→SIGTERM→SIGKILL 升级 + 兜底超时;所有 hook 执行有总超时(默认 30s),超时视为「hook 失败,不阻断主流程」。

**A3. 配置位置与 Trust(与既有配置语义一致)**

- **用户级** `~/.config/run-agent/settings.json`(始终加载,用户自写):
  ```json
  {
    "hooks": {
      "PreToolUse": [
        { "matcher": "Edit|Write|Delete", "hooks": [{ "type": "command", "command": "node ~/.run-agent-hooks/block-write.js" }] }
      ],
      "Stop": [
        { "hooks": [{ "type": "command", "command": "echo done", "timeout": 5000 }] }
      ]
    }
  }
  ```
- **项目级** `.run-agent/settings.json`(**仅 Trust 会话加载**,对齐 permissions.json / mcp.json 的防提示注入——恶意项目的 hook 会执行任意命令,绝不自动加载)。
- `type` = `command` | `http`;`http` 需 `url`。matcher 缺省 = 匹配全部工具。
- hooks、skills、commands 的配置**全部统一在 run-agent 自有路径**(`~/.config/run-agent/` + `.run-agent/`),与既有 permissions.json / mcp.json / CLAUDE.md 记忆一致,不引入 `.claude/` 路径(取舍见决策 B/C 动机)。

**A4. 与权限管线整合(安全底线不可破)**

- 顺序:**engine 判定 `d` → PreToolUse hook → 若 hook 返回 `permissionDecision` 用它,否则用 `d`**。
- **硬底线:hook 不能放行 engine 已 deny 的调用**(`d === "deny"` 时 hook 的 allow 无效,仍 deny)。理由:内置危险命令(`rm -rf /`、`git push --force`、`.run-agent` 路径)是无条件 deny,绝不能被用户脚本绕开。
- 生效矩阵:hook 可把 `ask → allow`(如「test 命令自动放行」)、`allow → deny`(自定义拦截)、`ask → deny`;`deny` 恒保持。
- `permissionDecisionReason` 并入 deny 回填(复用 0.5.1 的 `denyMessage` 机制,`checkPermission` 返回时带上)。

**A5. 装配与生命周期**

- `src/services/hooks/`:`config.ts`(读合配置 + matcher 编译)、`manager.ts`(`HookManager`:`onPreToolUse`/`onPostToolUse`/`onSessionStart`/`onSessionEnd`/`onStop`,内部按 matcher 分组执行)。
- `main()` 创建 `HookManager`(有配置才创建),传入 `runRepl`/`runOneShot`;`makeCheckPermission` 增加可选 `preToolUse` 回调参数(hook 包装)。
- **headless 下 hooks 同样生效**(决策 D4)——CI 集成 hooks 的用例。

**决策 A 配套测试**:

- 配置加载:用户 + 项目合读;未 Trust 项目 hooks 不加载;matcher 编译匹配/不匹配。
- 执行:`execCommand`(mock 脚本:正常输出 / JSON 输出 / 超时 / 非 0 退出码);`execHttp`(本地 mock http server,含 401)。
- 权限矩阵:`ask→allow` / `allow→deny` / `deny→hook allow 无效`;reason 并入回填。
- 事件触发:PreToolUse 在工具执行前、PostToolUse 在 settle 后、SessionStart/End 在 REPL 边界、Stop 注入下一轮 system(可观测)。
- headless 下 hooks 触发。

---

### 决策 B:Skills(扫描 + frontmatter + SkillTool + allowed-tools 限制)

**动机**:roadmap 点名「扫描 `.claude/skills/`」,但 run-agent 的配置约定一贯用**自有路径**(CLAUDE.md 记忆、permissions.json、mcp.json 全部在 `.run-agent/` / `~/.config/run-agent/`),技能沿用自有路径保持一致。额外好处:`.run-agent` 是**内置 deny 段**,loader 直读、模型工具碰不到技能文件,提示注入面比 `.claude/` 更低。SKILL.md 的**格式**(frontmatter + body)仍对齐 Claude Code,现成技能整目录拷进 run-agent 路径即可复用。

**B1. 扫描与解析**

- **路径(自有路径,与既有配置约定一致)**:项目级 `.run-agent/skills/<name>/SKILL.md`(仅 Trust 会话加载)+ 用户级 `~/.config/run-agent/skills/<name>/SKILL.md`(用户自写,始终加载)。项目级位于 `.run-agent` 内置 deny 段内——loader 用直接 fs 直读(与 CLAUDE.md 记忆同机制),**模型没有任何工具能偷看技能文件**,提示注入面更低。
- frontmatter(YAML 头,`---` 包裹):`name`(必填,slug)/ `description`(必填,给模型的用途说明)/ `allowed-tools`(可选,工具名数组,限制技能可用工具;缺省 = 全部工具)。body = 技能指令文本。
- 解析:读文件剥 BOM → 拆 frontmatter(YAML 子集,只认 name/description/allowed-tools 三键,其余忽略)→ `zod` 校验类型。非法 frontmatter → 跳过该技能并告警(不阻断启动)。
- 大小上限:SKILL.md 单文件 ≤ 100KB(防恶意巨型技能灌爆)。

**B2. `SkillTool`(模型运行时调用)**

- 装配:`buildTools` 增加可选 `skills?` 参数,有技能时追加 `SkillTool`。
- 签名:`z.object({ name: z.string(), args: z.record(z.string(), z.unknown()).optional() })`。
- `call`:
  1. 按 name 找技能;未找到 → 返回提示串「未知技能」+ 可用技能清单。
  2. 把 SKILL.md 全文回填 tool_result(模型接下来按指令执行)。
  3. 按 `allowed-tools` 设置「当前技能工具集」:**本 turn 剩余可用工具 = allowed-tools ∩ 池**(无 allowed-tools 则不限制)。实现:execute 层每轮解析工具池函数时,若存在活跃技能且其 allowed-tools 非空,过滤掉不在集内的工具(内置只读工具保留,防技能把自己关死)。
- **isConcurrencySafe: false**(技能加载改变工具池状态,串行)。
- **子 agent 化留 V7**:Claude Code 的 SkillTool spawn 子 agent(独立 context/transcript + 只给技能工具);run-agent 无子 agent 基建,V6 用「主循环内注入 + 工具过滤」近似,行为差异文档注明(V7 随 Agent 泛化升级,参考实现 `SkillTool.ts`)。

**B3. system 注入 + 用户侧入口**

- system 动态段注入一行:**可用技能清单**(名 + description,一行一个)——让模型知道可调 `SkillTool`。**不塞 body**(token 控制;body 在调用时加载)。
- 每个技能同时注册 **`/name` 斜杠命令**(prompt 形态,内容 = SKILL.md 全文)——用户手动 `/name` 直接加载技能(复用决策 C 的命令注册表)。
- REPL 新增 `/skills` 命令列出可用技能(名 + 描述 + 来源)。

**决策 B 配套测试**:

- 扫描:`.claude/skills/` + 用户级;Trust 门控;frontmatter 解析(合法/缺 name/非法 YAML 跳过);大小上限。
- SkillTool:未知技能提示;加载 body 回填;allowed-tools 过滤(仅技能集内工具可调);无 allowed-tools 不限制;并发安全 false。
- 斜杠:`/name` 加载技能;`/skills` 列出;内置命令与技能名冲突 → 内置优先。
- 与 MCP 工具共存:技能 allowed-tools 含 `mcp__*` 时放行。

---

### 决策 C:自定义命令(两形态落地,local-jsx 推 V8)

**动机**:用户定义自己的 `/` 命令,是「可编程化」最直接的入口;roadmap 点名三形态。

**C1. 路径与形态**

- **项目级** `.run-agent/commands/<name>.md`(prompt)/ `.run-agent/commands/<name>.py|js|ts`(local)+ **用户级** `~/.config/run-agent/commands/`。项目级**仅 Trust 加载**(与技能同语义,统一 Trust 门控;`.run-agent` 段 loader 直读,模型工具碰不到)。
- **prompt 形态**(`.md`):文件内容即命令展开的 prompt 模板。参数:输入行尾追加(`/foo bar` → 模板 + `\nbar`);支持 `@file` 引用(把文件内容内联,复用现有 read_file 约束)。
- **local 形态**(`.py/.js/.ts`):执行脚本,参数经 argv 传入,stdin 无;stdout 作为命令结果展示给用户(如需作为 prompt 喂给模型 → 在 REPL 处理时把 stdout 作为下一条 user 消息?V6 简化为:stdout 直接展示,不自动回喂模型)。超时复用 run_bash 的 120s/30k 上限。
- **local-jsx 形态:明确不落地**。需要 React/Ink 渲染器在 REPL 渲染组件;run-agent 无 TUI 渲染面。**推到 V8**(roadmap V8「TUI 打磨:Ink/React 渲染」同版),方案内诚实标注。

**C2. REPL 命令解析改造**

- 现状 `src/cli/repl.ts`:`switch(input)` 严格匹配内置命令。改为:**内置命令优先 + 扫描注册表**——`input` 首 token 查注册表(内置 → 走原分支;自定义 → 按形态处理);未命中 → 未知命令。
- `/help` 列出内置 + 自定义命令。冲突:**内置优先**(自定义不能覆盖内置,与 MCP 工具「内置优先」同语义)。

**C3. 命令上下文**

- local 命令执行时注入环境:`RUN_AGENT_CWD`(cwd)/ `RUN_AGENT_PROMPT`(当前 prompt)/ 参数作 argv——让脚本能感知会话。权限:命令执行**不经工具权限管线**(是用户显式发起,同 `/plan` 的手动命令语义);但脚本本身走 shell 的 run_bash 级超时/截断防护。

**决策 C 配套测试**:

- prompt 形态:模板展开 / 参数追加 / `@file` 内联;缺文件 → 报错。
- local 形态:脚本执行 + argv + stdout 截断;`.py/.js/.ts` 三种;超时。
- 注册表:内置优先;自定义命令可跑;`/help` 列出;Trust 门控。
- 冲突与边界:命令名非法字符过滤(`/` 内不允许 `/`);空文件。

---

### 决策 D:Headless 模式(`--print` + JSON 契约)

**动机**:CI/脚本/IDE 集成需要无头、可解析、有退出码的执行通道;roadmap 验收「CI 里无头跑一个任务拿到 JSON」。

**D1. 入口与 flag**

- `run-agent --print <prompt>`(长 flag;`-p` 已被 provider 占用,不设短旗标)+ 保留现有「位置参数 = one-shot」。`--print` 与位置参数互斥(都给了 → 报错)。
- `--json`(`--output-format json` 的别名):结构化输出到 stdout,人类可读日志去 stderr(会话文件路径等)。
- `--max-turns <n>`(可选):ReAct 循环上限,防 CI 失控(不传 = 现有默认轮数)。
- 复用 `runOneShot`:headless = runOneShot + JSON 序列化 + 退出码 + hooks 生命周期。

**D2. JSON 输出契约**(稳定字段,CI 依赖,改动需 bump version 字段)

```json
{
  "version": "0.6.0",
  "provider": "anthropic",
  "model": "claude-sonnet-5",
  "session": "2026-08-12T...-xxx.jsonl",
  "reply": "最终回复全文",
  "messages": 12,
  "turns": 3,
  "tools": [
    { "name": "read_file", "input": { "file_path": "a.ts" }, "result": "…", "permission": "allow" }
  ],
  "errors": []
}
```

- `tools`:每次工具调用的轨迹(名 + 入参 + 结果 + 权限判定 `allow/deny/ask`),CI 审计/调试用。`result` 截断到 2000 字符(全量在会话 JSONL 里)。
- `errors`:捕获的错误文本数组(非 0 退出时也返回)。
- `--json` 下 stdout **只输出这个 JSON**(不混任何日志),供脚本 `jq` 直取。

**D3. 退出码与权限策略**

- 退出码:`0` 正常完成 / `1` RunAgentError 或未捕获错误(`process.exit(e.exitCode ?? 1)`);CI 据此判失败。
- **无交互保证**:headless `canPrompt = isTTY && !prompt` 天然为 false(有 prompt)→ `ask` 降级 `deny`,绝不弹窗(不与 stdin 争读)。
- **CI 跑写类任务**:用 `--mode acceptEdits`(写免确认)+ `--json`。文档给出模板:
  `run-agent --print "修复所有 lint 错误" --mode acceptEdits --json | jq .reply`
- hooks(SessionStart/Stop/PreToolUse)在 headless 同样触发——CI 里挂自定义动作的用例。

**D4. 与既有 one-shot 的关系**

- `runOneShot` 已是「单 prompt → 循环 → 最终回复」;headless 只是在其上:JSON 序列化(需 runQuery 结果暴露工具轨迹——`RunQueryResult` 补 `toolCalls?: {name, input, result, permission}[]`,execute 层已有点位)+ 退出码 + `--print` 入口。**对外行为不变**,现有 one-shot 测试全量回归。

**决策 D 配套测试**:

- JSON 契约字段完整 / stdout 纯净(无日志混入)/ `jq` 可解析。
- 工具轨迹含权限判定(allow/deny);result 截断。
- 退出码:正常 0 / 无 key 1 / 循环上限 1。
- `--mode acceptEdits` 下写工具免弹窗执行成功(无 TTY 环境,注入 mock 流)。
- hooks 在 headless 触发(SessionStart/Stop 可观测)。

---

### 决策 E:共享基建(配置加载 + system 注入 + 命令注册表)

**动机**:Hooks/Skills/Commands 共享三块基建,先立稳再叠功能。

**E1. 配置加载统一**

- 新增 `src/services/hooks/config.ts` + `src/services/skills/loader.ts` + `src/services/commands/loader.ts` 三个 loader,都走「用户级 + 项目级(Trust 门控)」两源合读,复用 `loadConfig` 的路径解析(用户级 = `~/.config/run-agent/`,项目级 = `<cwd>/.run-agent/`,全部自有路径、无 `.claude/`)。Trust 判定复用 `isProjectTrusted`。
- `main()` 按「有内容才创建」原则:`HookManager`(有 hooks 配置)、`SkillRegistry`(有技能)、`CommandRegistry`(有命令)——零配置时零开销(与 MCP 的 `if (Object.keys(...).length > 0)` 同款)。

**E2. system 动态段扩展**

- `buildSystemPrompt` 的 `SystemContext` 增加可选:`skills?: string`(技能清单一行一列)/ `hookOutput?: string`(Stop hook 注入,决策 A1)。
- 全部放**动态段**(在稳定段之后),不破坏 prompt cache 前缀。
- 有 SkillTool 时 system 注入技能清单;技能 body 只在调用时加载。

**E3. REPL 命令注册表**

- `repl.ts` 的 `/` 解析从 `switch` 改为「注册表 + 内置优先」;SkillRegistry(技能即命令)与 CommandRegistry(自定义命令)向注册表登记。`/help` 汇总。
- 重构回归风险:内置命令(clear/compact/plan/mcp/help/exit)行为一字不改,全量回归锁定。

---

## §2 里程碑

### M1 — Hooks(决策 A)

**文件**:

- `src/services/hooks/config.ts`(新):读合 settings.json、matcher 编译。
- `src/services/hooks/manager.ts`(新):`HookManager` + execCommand/execHttp 执行 + 输出解析。
- `src/cli/index.ts`:创建 HookManager(有配置才建),传 REPL/one-shot;`makeCheckPermission` 注入 `preToolUse`。
- `src/cli/repl.ts`:`makeCheckPermission` 增加可选 `preToolUse` 参数;SessionStart/End 触发;`RunQueryOptions` 加 `onStop`。
- `src/core/execute.ts`:`ExecuteOptions` 加 `onPostToolUse?`;settle 触发。
- `src/core/query.ts`:Stop hook 输出并入下一轮 system(经 onStop → repl 存 state → 下轮 buildSystemPrompt)。
- `src/core/context.ts`:`SystemContext.hookOutput?` + 注入。

**测试**:A1–A5 全部用例 + 全量回归。

**验收**:REPL 里配一条「PreToolUse matcher=run_bash → permissionDecision=deny」的 hook,模型调 run_bash 被拦且 reason 回填;「改完自动跑测试」的 PostToolUse 场景 stdout 可见;Stop hook 输出注入下一轮(可观测);未 Trust 项目 hooks 不加载。

### M2 — Skills(决策 B)

**文件**:

- `src/services/skills/loader.ts`(新):扫描 + frontmatter 解析 + Trust 门控。
- `src/services/skills/skill_tool.ts`(新):`SkillTool` 工厂。
- `src/tools.ts`:`BuildToolsOptions` 加 `skills?`;追加 SkillTool。
- `src/core/context.ts`:`SystemContext.skills?` + 注入。
- `src/cli/index.ts`:创建 SkillRegistry;注册技能为斜杠命令(决策 C 注册表)。
- `src/cli/repl.ts`:`/skills` 命令。

**测试**:B1–B3 全部用例 + 全量回归。

**验收**:放一个技能到 `.run-agent/skills/demo/SKILL.md`(带 allowed-tools: read_file),模型被提示可用 `SkillTool`;调用后 body 加载、工具被限制在 allowed-tools;`/demo` 手动加载;Trust 外项目不加载。

### M3 — 自定义命令(决策 C)

**文件**:

- `src/services/commands/loader.ts`(新):扫描 + 形态识别(prompt/local)。
- `src/services/commands/exec.ts`(新):prompt 模板展开 / local 脚本执行。
- `src/cli/repl.ts`:命令解析 switch → 注册表;`/help` 汇总。

**测试**:C1–C3 全部用例 + 内置命令回归。

**验收**:用户写 `.run-agent/commands/ts.md`(prompt 形态)与 `.run-agent/commands/echo.py`(local 形态),REPL 里 `/ts a.ts` 展开模板、`/echo hello` 跑脚本出结果;内置命令不受影响。

### M4 — Headless(决策 D)

**文件**:

- `src/cli/index.ts`:`--print` / `--json` / `--max-turns` flag;headless 分支(调 runOneShot + 序列化 + 退出码)。
- `src/core/query.ts`:`RunQueryResult` 补 `toolCalls` 轨迹。
- `src/cli/repl.ts`:`runOneShot` 返回结构补轨迹;JSON 组装。

**测试**:D1–D4 全部用例 + one-shot 回归。

**验收**:`echo "读一下当前目录" | run-agent --print - --mode acceptEdits --json` 输出合法 JSON(含 reply + tools 轨迹 + 退出码 0);无 key 时退出码 1。

### M5 — 0.6.0 发布

- 文档:`docs/hooks.md`(事件/执行方式/配置/matcher/permissionDecision 安全边界)、`docs/skills.md`(SKILL.md 格式/frontmatter/allowed-tools)、`docs/commands.md`(三形态说明 + local-jsx 标注 V8)、`docs/usage.md` 补 headless JSON 契约;`docs/architecture.md` 目录树更新;README 补「Hooks / Skills / 自定义命令 / Headless」特性 + 二次开发入口;`CHANGELOG.md [0.6.0]`;`package.json` 0.6.0。
- `CLAUDE.md`:工具数(12 → 13:SkillTool 条件装配;hooks 不入工具表)、架构段(新增三个 services 目录)、测试用例数。
- CI 三 OS × Node 20/22/24 全绿(重点:execCommand 在 Windows 的 PowerShell 路径、local 脚本 .py 在无 python 环境的 OS 用 .js/.ts 兜底测试、headless JSON 在无 TTY 下)。
- tag `v0.6.0` → push 等 CI 全绿 → `npm pack` 检查 → `npm publish --access=public` → `npm view` 验证(复用 0.5.1 流程)。

---

## §3 DoD 验收清单

- [ ] `settings.json` 用户级 + 项目级(Trust 门控)合读;零配置零开销(单测)
- [ ] 五类事件触发点正确:PreToolUse(engine 判定后)/ PostToolUse(settle 后)/ SessionStart / SessionEnd / Stop(下一轮 system 注入)(集成测试)
- [ ] execCommand + execHttp 执行:正常 / JSON 输出 / 超时 kill / 非 0 退出码;stderr 64KB 上限(单测)
- [ ] PreToolUse permissionDecision 生效矩阵:ask→allow / allow→deny / deny 不可被 hook 放行;reason 并入回填(单测)
- [ ] `.run-agent/skills/<name>/SKILL.md`(项目,Trust)+ `~/.config/run-agent/skills/`(用户)扫描 + frontmatter(name/description/allowed-tools)解析;非法 frontmatter 跳过告警(单测)
- [ ] SkillTool:加载 body 回填;allowed-tools 过滤工具集;无 allowed-tools 不限制;未知技能提示(单测)
- [ ] 技能注册 `/name` 斜杠命令 + `/skills` 列出 + system 注入技能清单(单测 + 冒烟)
- [ ] 自定义命令:prompt(.md 模板 + 参数 + @file)/ local(.py/.js/.ts 脚本 + argv + stdout 截断)两形态;内置命令优先;`/help` 汇总(单测 + 冒烟)
- [ ] `--print <prompt>` + `--json`:JSON 契约字段完整、stdout 纯净、`jq` 可解析;`--max-turns` 生效(单测)
- [ ] JSON 工具轨迹含权限判定;result 截断;退出码 0/1(headless 集成测试)
- [ ] `--mode acceptEdits` 下 headless 写工具免弹窗;hooks 在 headless 触发(集成测试)
- [ ] REPL 命令解析重构后内置命令全量回归不破(回归)
- [ ] 文档:hooks.md / skills.md / commands.md / usage(Headless)/ README / architecture / CHANGELOG;版本 0.6.0
- [ ] 0.6.0 发布:CI 3 OS × Node 20/22/24 全绿 / tag / `npm pack` / `npm publish` / `npm view` 验证
- [ ] **真实模型手动验证(需 key)**:配一条 hook 触发自动动作(改完自动跑测试);模型调一个技能(带 allowed-tools 限制)正确执行;CI 里无头跑一个任务拿 JSON

## §4 风险与注意

1. **hooks 是安全面**:execCommand 任意命令执行。缓解:项目级 hooks 仅 Trust 加载(对齐 permissions.json);**engine deny 不可被 hook 放行**(硬底线);hook stdout 除 Stop 外不注入上下文(防第三方输出污染);文档写明「只挂可信命令」。
2. **`local-jsx` 落地 vs 路线图**:roadmap 列三形态,V6 只交两形态——因无 TUI/Ink 渲染器。方案内诚实标注推到 V8;DoD 不依赖它。
3. **路径与格式的取舍**:自有路径保证一致性 + `.run-agent` deny 段安全,但用户从 Claude Code 拷技能要自己改目录。缓解:SKILL.md 格式仍对齐,`docs/skills.md` 开头写「把现成技能目录拷进 `.run-agent/skills/` 即可用」降低迁移成本;全项目配置统一在 `.run-agent/` + `~/.config/run-agent/`,文档一张表列清各配置归属。
4. **技能提示注入**:SKILL.md body 注入模型上下文。缓解:项目级技能仅 Trust 加载;SKILL.md ≤ 100KB;技能内容视作第三方指令,文档提醒用户只装可信技能(与 CLAUDE.md 记忆注入同信任模型)。
5. **REPL 命令解析重构回归**:`switch` → 注册表是 REPL 主路径改动。缓解:内置命令行为一字不改,回归用例先锁死再改;`/help` 汇总同步。
6. **headless JSON 契约稳定性**:CI 依赖的字段(version/reply/tools/退出码)一旦发布不可随意改。缓解:契约加 `version` 字段;`docs/usage.md` 写死契约并注明改动需 bump。
7. **Stop hook 注入的上下文污染**:hook stdout 进 system,可能是垃圾。缓解:只注入 Stop 一类(用户显式选该行为);前缀标注 `--- hook output ---`;超长截断(2KB)。
8. **execCommand 跨平台**:Windows 走 `resolveShell()`(PowerShell),local 命令脚本 `.py` 需 python 环境——CI 三 OS 冒烟锁死;测试用 `.js` 脚本兜底(Node 必有)。
9. **发布纪律**(沿用):全平台 CI 转绿再 publish;`npm pack` 检查无源码泄漏;工程纪律(exactOptionalPropertyTypes / verbatimModuleSyntax / zod v4 / BOM)沿用。

## §5 交接(V5 → V6 → V7)

**V5 → V6 依赖**:

- V5 的权限管线(`makeCheckPermission` / `readOnlyNames` 闭包)是 PreToolUse hook 的单点整合口;V5 的 `denyMessage`(0.5.1)被 permissionDecisionReason 复用。
- V5 的 StreamingToolExecutor 的 settle 是 PostToolUse 触发点;MCP 工具 / plan 导航工具自动覆盖。
- V5 的 system 动态段注入(hookOutput / skills 清单)复用现有稳定/动态边界,不破坏 cache 前缀。
- V5 的 Trust 门控语义直接套用到项目级 settings/skills/commands。

**V6 → V7(多 Agent)**:

- **Skill 子 agent 化**:V6 的主循环内加载是近似;V7 的 `Agent` 工具泛化(roadmap V7 决策 1)升级 SkillTool 为 spawn 子 agent + allowed-tools 限制(参考实现 `SkillTool.ts`)。
- **后台记忆提取子 agent**(roadmap V7)可复用 Stop hook 的「轮末触发点」与 hooks 基建(mock server 测试)。
- **更多 hook 事件**(PreCompact/SubagentStop/Notification)与 **local-jsx** 随 V7 子 agent / V8 TUI 落地。
- V7 的 `run_in_background` / 任务级并发在 headless JSON 契约的 tools 轨迹上加字段即可向后兼容。
