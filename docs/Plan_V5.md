# Plan V5 — Plan and Execute + MCP 客户端 + 并发强化(交付 0.5.0)

> 上游:`docs/Plan.md` 路线图 V5 段(227-239 行):「复杂任务先出计划再执行;接入标准协议生态;并行上台阶。**用户点名功能集中落地。**」
> 上一版本交接:`docs/Plan_V4.5.md`(0.4.2 权限模型重构 + 0.4.3 修复)与 `docs/Plan_V4.md`(0.4.0 主动记忆 / 0.4.1 代码理解)。**V0–V4.5 全部已实施并发布**(CHANGELOG 0.1.0 → 0.4.3 全绿,详见 §0)。
> 本版本一句话:三个此前刻意留给 V5 的能力一起交付——**Plan 模式**(只读探索 → 计划落盘 → 用户审批 → 恢复权限模式)、**MCP 客户端**(按需连接标准生态、`mcp__server__tool` 命名、同一权限管线)、**StreamingToolExecutor**(模型边流式边并行执行工具)。
> 触发:路线图 V5 段为既定范围;2026-08-11 核验 V0–V4.5 DoD 后确认实施完毕,仅剩「真实模型手动验证(需 key)」一类待 key 条目(见 §0)。
> 参考实现:`F:\CC_Source\claude-code-sourcemap\restored-src` —— Plan 模式(`src/tools/EnterPlanModeTool/`、`src/tools/ExitPlanModeTool/`)、MCP 客户端(`src/services/mcp/client.ts`、`src/tools/MCPTool/MCPTool.ts`)、并发(`src/services/tools/StreamingToolExecutor.ts`)。本版对齐其语义、裁剪其规模。
> 工期参考:≈ 2~3 周,交付 `0.5.0`。

## §0 结论速览

**前置核验(V0–V4.5 实施状态,2026-08-11)**:

- **代码/交付物层面全部实施完毕**:`src/` 结构与各版计划一一对应(V1 6 工具 + V2 权限引擎/Trust/并发/重试 + V3 上下文/compact/remember + V4 记忆/repo_map/explore/verify + V4.5 权限三层模型);V0 开源交付物(LICENSE / CONTRIBUTING / CODE_OF_CONDUCT / SECURITY / ISSUE_TEMPLATE / PR template / 三 OS CI)齐全;CHANGELOG 记录 0.1.0 → 0.4.3 全部发布,npm latest = 0.4.3,CI 9 job(3 OS × Node 20/22/24)全绿。
- **历史计划文档的 DoD 复选框多为未勾**:这是「计划写作时」的勾选,实际完成度以 CHANGELOG + 已发布 tag + CI 为准(各版 DoD 在发布流程中由「版本发布」项覆盖)。
- **唯一未完成类别 =「真实模型手动验证(需 key)」**:V1/V2/V3 DoD 里的此类条目需要真实 API key 才能跑(如 `--resume` 续接压缩会话、DeepSeek/Ollama 下压缩、多 provider 端到端)。它们不是代码缺口,是「有 key 的手工验证」,持续列为每个版本的验收尾项。
- **V4 的 LSP 客户端是显式可选**(`docs/Plan_V4.md` 行 338:「不做也满足 DoD」),roadmap 也把它排在 V5+;本版不碰。

**V5 交付什么**:

1. **Plan 模式**(决策 A):`PermissionMode` 新增 `"plan"`;**入口 = 模型驱动为主(`enter_plan_mode` 工具)+ `/plan` 手动兜底**(REPL 斜杠命令);plan 下写/执行工具一律 deny、只读工具放行;`exit_plan_mode` 把计划写入 `.run-agent/plans/` 并经 REPL 弹窗审批;批准后恢复进入 plan 前的权限模式。复杂任务先展示计划再动手。
2. **MCP 客户端**(决策 B):唯一新依赖 `@modelcontextprotocol/sdk`(stdio / SSE / Streamable HTTP 三种传输);用户级 `~/.config/run-agent/mcp.json` + 项目级 `.run-agent/mcp.json`(仅 Trust 加载);**按需连接**(默认不预连,`mcp_connect <server>` 连接 → listTools → 包装成标准 `Tool` 进池,名 `mcp__<server>__<tool>`);连接状态机 connected/failed/needs-auth/disabled;MCP 工具走**同一权限管线**;**懒 schema**(`passthrough` 通配,不传 server 完整 schema)省 token;`/mcp` REPL 命令管理。
3. **并发强化**(决策 C):`executeToolCalls` 演进为 **StreamingToolExecutor**——流式回调中 tool_use block 一完整就入队执行(不必等整批收齐),只读并行 / 写串行规则不变,结果仍按原始调用顺序重排回填。**任务级多查询并行/后台任务明确留给 V7**(与子 agent / task 基础设施同版)。

**技术栈增量**:

- 新增依赖:`@modelcontextprotocol/sdk`(^1.29.0,对齐参考实现验证版本)。
- 新增目录:`src/services/mcp/`(连接管理)、`docs/plan-mode.md`、`docs/mcp.md`、`examples/mcp-server/`(示例 server)。
- 其余全复用现有:`Tool` 接口 / zodToJsonSchema / 权限引擎 / repl readline 注入 / Trust。

**不做的事(留待后续,诚实标注)**:

- **任务级/后台并发(V5 只做工具级)**:真正并行跑多个 query、后台任务、TaskStop/TaskOutput → **V7**(与 `Agent` 工具、`run_in_background`、子 agent 泛化同版,roadmap V7 决策 1)。V5 的「并发强化」仅指流式执行中工具即时并行。
- **MCP resources / prompts / elicitation / roots 全链路**:roadmap V5 只点名 tools;资源/提示词/授权交互 → 后续版本(参考实现有 ListMcpResourcesTool/ReadMcpResourceTool/elicitation,工程量另算)。
- **MCP 工具参数黑盒解析**:MCP 工具的参数(如 filesystem server 的 `path`)在 server 内部处理,run-agent 的路径白/黑名单够不到 → 靠「非只读 MCP 工具 default 必 ask + 文档信任边界」缓解,不做参数内省(见决策 B5)。
- **专门的只读 planAgent 子 agent**:roadmap 写「可选」;V5 用现有 `explore`(plan 模式放行,它内部只用只读工具)覆盖,专门 plan 子 agent 归 V7 的 Agent 泛化。
- **工具结果图片 / blob 处理、MCP server 分片上传等** → 后续。

---

## §1 架构决策

### 决策 A:Plan 模式(权限模式 `plan` + 两导航工具)

**动机**:复杂任务直接动手容易跑偏;先「只读探索 → 出计划 → 用户批准 → 执行」是 Claude Code 的核心交互之一,roadmap 点名功能。

**A1. `PermissionMode` 新增 `"plan"`,engine 判定对齐「plan 下禁写」**

- `src/permissions/types.ts`:`PermissionMode = "default" | "acceptEdits"` → `"default" | "acceptEdits" | "plan"`。
  **`plan` 不是 CLI 可选项**:`PERMISSION_MODES`(cli/index.ts)保持 `["default", "acceptEdits"]`——`--mode plan` 报非法值。plan 是**会话内动态模式**,只由 `enter_plan_mode` 进入、`exit_plan_mode` 退出。
- `src/permissions/engine.ts`:`hasPermissionsToUseTool` 增加 plan 分支。插入位置:危险命令检查(步骤 1)之后、其余判定之前(plan 是最高优先级的一档状态):

  ```
  mode === "plan" 时:
    工具 ∈ {enter_plan_mode}           → 放行(它自身处理「已在 plan 中」报错)
    工具 ∈ readOnlyNames ∪ {exit_plan_mode}:
      路径参数在 cwd 内 / 记忆读豁免   → allow        # plan 下只读探索(含 cwd 外需 ask,见下)
      cwd 外(无豁免)                  → ask(canPrompt=false 时 deny)
    其余(写类 / run_bash / verify / remember / MCP 非只读)→ deny
      消息:「plan 模式下只读:先调用 exit_plan_mode 呈现计划」
  ```

  - `readOnlyNames` 参数见决策 B4(本版先落 `READ_ONLY_TOOLS ∪ {"explore"}`——explore 内部只用只读工具,plan 下放行;verify 会执行命令,deny)。
  - **exit_plan_mode 放行 + 它自己的 checkPermission 是 ask**(用户审批),两段逻辑互不干扰:engine 放行工具本身,审批由 repl 的 ask 弹窗负责。
  - plan 模式下 `acceptEdits` 语义消失(写一律 deny),`default`/`acceptEdits` 的既有兜底不适用——这是设计意图:plan 是「强制只读」态,不受用户模式影响。

- **进入前模式恢复**:`exit_plan_mode` 记录 `prePlanMode`(进入 plan 前的 mode),退出时 `setMode(prePlanMode)`。参考实现用 `prePlanMode` + 恢复(Claude Code `ExitPlanModeV2Tool`)。

**A2. `enter_plan_mode` 工具(工厂装配)**

- 新文件 `src/tools/plan_mode.ts`(两工具同文件,工厂注入运行时依赖)。
- 签名:无入参(`z.object({})`)。校验:仅当当前 mode ≠ `plan` 可用(否则返回错误文本「已在 plan 模式」)。
- `call`:`setMode("plan")`;返回指引文本(仿参考实现):探索代码库 → 考虑多方案 → 用 `exit_plan_mode` 呈现计划,**明确 DO NOT 写任何文件**。
- **只读**:`isConcurrencySafe: true`;不入 `readOnlyNames`(它在 engine 的 plan 分支显式处理,default/acceptEdits 下也不该被白名单兜底——它只是导航工具)。

**A3. `exit_plan_mode` 工具 + plan 文件 + 用户审批**

- 入参:`z.object({ plan: z.string() })`(计划全文)。
- 校验(`validateInput` 语义):仅 mode === `"plan"` 可用;否则返回错误「不在 plan 模式,此工具仅用于呈现计划」(参考实现同)。
- **checkPermission = ask**(用户审批):repl 的 `makeCheckPermission` 对非只读工具 default 下本就 ask;`canPrompt=false`(one-shot)时降级 deny。**批准 → allow → call 执行;拒绝 → deny → 模型留在 plan 模式继续探索**。
- `call` 三件事:
  1. **写 plan 文件**:`<cwd>/.run-agent/plans/plan-<ts>.md`(直接 `fs.writeFile`,**不经权限管线**——参考实现 ExitPlanModeV2Tool 同样直写)。`.run-agent` 是危险目录,但这条写入是**系统行为**而非 agent 工具调用,不冲突;模型也不需要 read_file 读它(见下)。
  2. **恢复权限模式**:`setMode(prePlanMode)`。
  3. 返回 `{ plan, filePath }`;`mapToolResultToToolResultBlockParam` 回填「用户已批准」+ **plan 全文** + 文件路径(`/compact` 后的上下文重建也能看到计划,模型无需读盘)。
- **`prePlanMode` 存哪**:工具实例闭包字段(进入 plan 时写,退出时读),单会话单实例,天然安全。

**A4. one-shot 与装配边界**

- **one-shot(`canPrompt=false`)不装配 `enter_plan_mode`/`exit_plan_mode`**(与 explore 同条件装配):没有交互弹窗,`exit_plan_mode` 的 ask 必降级 deny → 模型一旦进 plan 就出不来(死锁)。不装配 = 模型根本没有入口。
- `buildTools` 增加可选 `planMode?: { setMode, ask, canPrompt }` 工厂入参;REPL 传,one-shot 不传。
- system prompt 动态段加一句引导:复杂/多文件/设计型任务先 `enter_plan_mode` 探索,再用 `exit_plan_mode` 呈现计划。(Claude Code 的 EnterPlanModeTool 也有同样引导。)

**A5. 手动兜底入口:`/plan` REPL 斜杠命令(模型驱动为主,手动兜底)**

- 进入方式确认:**模型驱动为主**(`enter_plan_mode` 工具,模型判断任务复杂度)→ `/plan` 手动兜底(用户主动说「这个任务先出计划」)。
- `repl.ts` 新增 `/plan` 命令:直接 `setMode("plan")`,**不经模型判断**。**仅 REPL 有**;one-shot 无 REPL 自然没有此命令。
- 效果:用户敲 `/plan` → 进 plan(只读)→ 模型探索 → `exit_plan_mode` 呈现计划 → 审批 → 恢复。**与模型驱动路径共用同一条 plan 状态机**,只是进入方式不同,`prePlanMode` 记录逻辑完全一致。
- 边界:已在 plan 中敲 `/plan` → 提示「已在 plan 模式,用 exit_plan_mode 呈现计划」;**退出不另设斜杠命令**(统一走 `exit_plan_mode`,用户批准是必经的一步,不能跳过);`/help` 命令列表补 `/plan`。
- 定位:弥补模型判断力不足(快模型可能忘记进 plan);入口可控,想纯 ReAct 就不敲。

**决策 A 配套测试**:

- engine:plan 分支矩阵(plan 下 write/run_bash/verify/remember deny;read/glob/grep/repo_map/explore cwd 内 allow;cwd 外 ask;exit_plan_mode allow;default 下 exit_plan_mode 报错语义由工具层测)。
- plan_mode 工具:enter 后 mode 变 plan / 已在 plan 报错;exit 校验非 plan 不可用 / plan 落盘 + 恢复 prePlanMode / 拒绝时 mode 不变;one-shot 不装配(工具不在列表)。
- `/plan` 命令:REPL 敲 `/plan` 直接进 plan(不经模型判断);已在 plan 提示;退出统一走 `exit_plan_mode`;one-shot 无此命令。
- REPL 集成:两条进入路径(模型 `enter_plan_mode` / 用户 `/plan`)各跑一轮 enter → 工具全 deny → exit(ask y)→ 恢复 default 写 allow。

---

### 决策 B:MCP 客户端(唯一新依赖 + 连接管理 + 懒 schema 包装)

**动机**:标准协议生态(MCP)是 2025-26 年工具接入的既定轨道,roadmap 点名;「能接 1 个真实 MCP server 并调其工具」是验收项。参考实现 `src/services/mcp/client.ts`(3349 行)是完整蓝本,本版**只做 tools 链路**,裁剪到可维护规模。

**B1. 依赖与配置**

- `package.json` 新增 `"@modelcontextprotocol/sdk": "^1.29.0"`(对齐参考实现验证版本;npm latest 1.30,^1.29 兼容区间,CI 会锁 lockfile)。
- **配置两处合读**(复用现有配置层级):用户级 `~/.config/run-agent/mcp.json`(始终加载)+ 项目级 `<cwd>/.run-agent/mcp.json`(**仅 Trust 会话加载**,对齐 permissions.json 的防提示注入)。**为什么放 `.run-agent/`**:项目级私有配置目录已在那里(记忆);配置是用户写的、agent 工具读不到(危险目录 deny)。
- 格式:

  ```json
  {
    "servers": {
      "filesystem": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
        "env": {}
      },
      "github": { "type": "http", "url": "https://api.githubcopilot.com/mcp/" },
      "example-sse": { "type": "sse", "url": "https://example.com/mcp" },
      "off": { "type": "stdio", "command": "x", "args": [], "enabled": false }
    }
  }
  ```

  `type` = `stdio` | `http`(Streamable HTTP)| `sse`;`enabled:false` → disabled 态(不连接、不注入)。

**B2. 连接管理器 + 状态机**

- 新目录 `src/services/mcp/`:
  - `config.ts` — 读合配置(用户 + Trust 项目)、server 名规范化。
  - `manager.ts` — `McpManager` 类:**持有 server 配置、连接 map、已注册工具、每 server 状态**。
  - `tool.ts` — MCP 工具 → 标准 `Tool` 的包装器。
  - `mcp_connect.ts` 工具工厂。
- **状态机 4 态**(roadmap 点名):`connected` / `failed` / `needs-auth` / `disabled`。`/mcp` REPL 命令列出每 server 状态;`/mcp connect <name>` 手动重连。
  - `connect(server)` memoized:连接对象按 `name+config` 缓存;`onclose` 清缓存(下次自动重连)。连接超时 30s;stdio spawn 失败 / http 连不上 → `failed`(带错误消息);http/sse 401 → `needs-auth`(工具不注册)。
  - **stdio 细节**(学参考实现):`StdioClientTransport({ command, args, env })`,`stderr: 'pipe'` 收集到 64KB 上限(连接失败时把 stderr 回填错误消息,否则 server 报错用户看不到);进程回收:退出时 `SIGINT → SIGTERM → SIGKILL` 升级 + 600ms 兜底。
  - **http/sse 细节**:`StreamableHTTPClientTransport` / `SSEClientTransport`;给 fetch 包一层 60s 超时(长连接 SSE 的 GET 不设超时);`Accept: application/json, text/event-stream`。
- `McpManager` 生命周期:main() 创建单例,传 REPL 与 one-shot;进程退出清理所有连接(注册 cleanup)。

**B3. 按需连接 + `mcp_connect` + 懒 schema(省 token)**

- **默认不预连**:启动不 spawn 任何 MCP server 进程、不 listTools。system 动态段注入一行:`MCP servers 已配置: filesystem(stdio), github(http) — 调 mcp_connect <name> 连接`。
  - 理由:stdio server 是子进程(启动开销 + 资源);全量注入所有 MCP 工具名/desc 会爆 token;参考实现虽批量预连,但它有 deferred-tool list + 每工具 desc 截断的复杂机制兜底。run-agent 用「按需连接」达成同样的 token 节省,机制简单得多。
  - 可选配置 `"mcp": { "preconnect": true }` 走启动全量连接(高级用户;默认 false)。
- **`mcp_connect(server)` 工具**:入参 `z.object({ server: z.string() })`。
  - `call`:连接该 server → `tools/list` → 把每个工具包装成标准 `Tool` 注册进 manager → 返回工具清单(名 + 描述,一行一个)。
  - 权限:`mcp_connect` 免确认(用户写好配置 = 已授权;项目级配置仅 Trust 加载是第二道门)。**与参考实现的连接语义一致**(连接是配置动作,不是逐次工具调用)。
  - **包装规则**(`src/services/mcp/tool.ts`,对齐参考实现 `fetchToolsForClient`):
    - 名:`mcp__<normalizedServerName>__<toolName>`(`normalizeNameForMCP`:小写、非 `[a-z0-9_]` → `_`;roadmap 的 `mcp__server__tool` 命名)。
    - desc:截断到 **2048** 字符(参考实现 `MAX_MCP_DESCRIPTION_LENGTH`,防 OpenAPI 生成 server 的 15-60KB desc 灌爆上下文)。
    - **inputSchema = `z.record(z.string(), z.unknown())`(passthrough 通配)**——**懒 schema**:不为每个 MCP 工具传输/维护完整 zod schema(那往往是 server inputSchema 的完整 JSON Schema,体积大),入参校验完全交给 server 自身。`zodToJsonSchema` 输出 `{ type: "object" }`,几乎零 token。这就是 roadmap 的「延迟加载工具 schema 省 token」。
    - `isConcurrencySafe = annotations?.readOnlyHint === true`(MCP 标注;只读工具可并行,其余串行)。
  - **内置优先**:MCP 工具全限定名 `mcp__server__tool` 与内置 `read_file` 等天然不撞;装配顺序「内置 + remember/explore + MCP 追加在后」,同名不覆盖(内置永远赢)。若两个 server 规范化后撞名 → 装配时告警并跳过后者。
  - **注入时机**:REPL/one-shot 每轮 `tools = buildTools(...) ++ manager.getConnectedTools()`;`mcp_connect` 注册后,**下一轮请求**起模型就能调 `mcp__server__tool`(工具列表是每轮从池里重建的,天然动态)。

**B4. MCP 工具走同一权限管线**

- `hasPermissionsToUseTool` 增加第 7 参 `readOnlyNames?: (name: string) => boolean`(缺省 = `READ_ONLY_TOOLS.has`)。**改纯函数签名但不改既有判定语义**(缺省行为不变),REPL 装配时传合并闭包:内置只读名 → READ_ONLY_TOOLS;MCP 名 → 查 manager 的 readOnlyHint 注册表。
- 判定结果:MCP **只读 hint** 工具 → 当只读(read cwd 内 allow);MCP **非只读**工具 → default 下 **ask**、acceptEdits 下 allow、**plan 下 deny**。`mcp_connect` 免确认(见 B3)。
- **路径白/黑名单对 MCP 工具不生效**(参数是 server 内部黑盒)——见 B5 风险,这正是「非只读 MCP 工具 default 必 ask」的原因。

**B5. MCP 工具参数黑盒 — 诚实标注的边界**

- run-agent 的 `inputPath`/`pathInCwd`/危险目录检查都建立在「工具入参里能认出路径参数」上;MCP 工具的参数 schema 是 server 定义的,run-agent 不解析。filesystem server 的 `read_file` 到 `~/.ssh/id_rsa`,run-agent 的管线看不见这个 `path`。
- **缓解(与参考实现一致)**:① 非只读 MCP 工具 default 必 ask(用户逐次确认);② 只读 hint 才免确认;③ 文档(`docs/mcp.md`)写明信任边界:用户只连可信 server,MCP server 的权限语义 = server 自身语义 + run-agent 工具级确认;④ 项目级 `mcp.json` 仅 Trust 加载。
- 这不是缺陷,是 MCP 协议分层下工具接入的固有形态(参考实现同样不解析 MCP 工具参数)。

**B6. 明确不做(resources/prompts/...)** 见 §0。

**决策 B 配套测试**:

- **mock server(hermetic,不连真实网络)**:用 MCP SDK 的 `InMemoryTransport`(SDK 自带,参考实现 `InProcessTransport.ts` 同思路)在测试进程内起一个最小 server(暴露 2-3 个工具,含一个 `readOnlyHint` 标注),验证:listTools → 包装(命名/desc 截断/懒 schema)→ `mcp_connect` 返回清单 → 调 `mcp__server__tool` 拿到结果 → 断开重连。
- 状态机:stdio 命令不存在 → failed;disabled 不连接;401 的 http mock → needs-auth(不发真请求,mock 返回 401)。
- 权限:只读 hint MCP 工具 default allow;非只读 default ask / acceptEdits allow / plan deny;`mcp_connect` 免确认。
- 配置:用户级 + 项目级合读;未 Trust 的项目级 mcp.json 不加载。
- CLI/REPL:`/mcp` 列状态;`/mcp connect` 重连;one-shot 装配 MCP 工具。

---

### 决策 C:并发强化 — StreamingToolExecutor(工具级)

**动机**:现在 query.ts 是「流式收完一整批 tool_use → `executeToolCalls` 全批执行」,工具要等整个响应完结才开始;长时间任务里模型输出的最后一行文本会无谓地延迟第一批工具。参考实现 `StreamingToolExecutor.ts` 把执行前移到**流式期间**:block 一完整就执行。CLAUDE.md 已注明 `partitionToolCalls` 是它的前身。

**C1. 执行器演进(`src/core/execute.ts`)**

- 新增 `class StreamingToolExecutor`:
  - `addTool(tu: ToolUseBlock, index: number)`:权限校验(复用 runOne 的 checkPermission 段)→ 入队 → `processQueue()`。
  - `processQueue()`:队列按 `canExecuteTool` 规则推进——**所有 executing 工具都是 concurrency-safe 才允许并入新的 safe 工具;非 safe(写类)工具一次只跑一个且不打断**。与现规则同源(`isConcurrencySafe === true` 并行,其余串行)。
  - `getResults(): Promise<string[]>`:等全部完成,结果按 index 重排回填(保持 CLAUDE.md 关键约定:「返回的 result 数组顺序必须与传入 calls 一致」)。
  - `addTool` 的权限失败/参数失败/执行异常 → 与 runOne 相同的字符串回填(不 throw),保证 loop 语义不变。
- **query.ts 流式回调改造**:适配器 emit 一个完整 tool_use block(anthropic 已按 `input_json_delta` 跨事件聚齐)时 → 立即 `executor.addTool(block, index)`(不必等 stop reason / 文本结束);流结束(`stop_reason=tool_use` / max_tokens / error)后 `const results = await executor.getResults()`,回填 `tool_result` 构造下一轮消息。
- **兼容**:老 `executeToolCalls` 保留(内部实现可改为「一次性 addTool 全部 + getResults」)或被替换;对外行为契约(结果顺序/错误文本/并发上限 10)不变,全量回归锁定。
- **并发上限**:沿用 `MAX_CONCURRENCY = 10`,plan 分支/只读集合判定不涉执行层。

**C2. 兄弟 abort(加分项,不阻塞 DoD)**

- 参考实现:一个 Bash 工具 error 时 abort 同批兄弟子进程。run-agent 的工具错误是**字符串回填非 throw**,无「错误信号」可挂;V5 **不引入 throw 语义**。→ 兄弟 abort 标注为加分项:若执行层引入「工具执行抛错」的统一出口再补。DoD 不依赖它。

**C3. 任务级/后台并发 → 明确留给 V7**

- roadmap 的「后台任务/任务级并发」在 V5 只交付**工具级流式执行**(本决策);真正的多查询并行、后台任务、TaskStop/TaskOutput 与子 agent(`run_in_background`、Agent 工具)强耦合,归 **V7 多 Agent 编排**(roadmap V7 决策 1,explore 泛化那版)。V5 方案内诚实标注此边界,不偷偷砍需求。

**决策 C 配套测试**:

- execute:流式边执行(先到先跑)、只读并行上限/写串行、结果按 index 重排、错误/权限失败回填、`getResults` 等待语义。
- query 集成:mock LLM 流式分片 emit 两个工具(第一个立即跑、第二个延迟),断言第一个工具在流式结束前已执行(用可观测副作用计时);`tool_result` 顺序与消息构造正确。
- 回归:原「并行/串行/上限/顺序」用例全量保留。

---

## §2 里程碑

### M1 — Plan 模式(决策 A)

**文件**:

- `src/permissions/types.ts`:`PermissionMode` 加 `"plan"`。
- `src/permissions/engine.ts`:加 `readOnlyNames?` 参数(第 7 参,缺省 `READ_ONLY_TOOLS.has`);加 plan 分支(A1)。
- `src/tools/plan_mode.ts`(新):`enter_plan_mode` / `exit_plan_mode` 工厂。
- `src/tools.ts`:`BuildToolsOptions` 加 `planMode?: { setMode: (m: PermissionMode) => void; ask?: (msg: string) => Promise<Decision>; canPrompt: boolean }`;`buildTools` 条件装配。
- `src/cli/repl.ts`:装配时注入 `setMode`(闭包改 `ctx.mode`)与 `ask`(复用现有 readline);每轮 mode 变化后下一轮生效;**新增 `/plan` 斜杠命令(A5)**,`/help` 列表同步。
- `src/cli/index.ts`:PERMISSION_MODES 不变(`--mode plan` 报非法值);one-shot 不传 planMode(也无 `/plan` 命令)。
- system prompt 引导 + `docs/plan-mode.md`(`/plan` 手动入口 + `enter_plan_mode` 模型入口都写入)。

**测试**:engine plan 矩阵、plan_mode 工具、`/plan` 命令(两条进入路径)、REPL 集成(模型 enter / 用户 `/plan` → 禁写 → exit 审批 → 恢复)。全量回归。

**验收**:REPL 里让模型跑「重构模块」,模型先 enter_plan_mode → write/run_bash 返回 deny → exit_plan_mode 弹 y/n → 批准后恢复原模式;**用户敲 `/plan` 同样进 plan(不经模型判断)**;plan 文件落在 `.run-agent/plans/`;one-shot 无 plan 工具与 `/plan`。

### M2 — MCP 客户端(决策 B)

**文件**:

- `package.json` + lockfile:`@modelcontextprotocol/sdk`。
- `src/services/mcp/config.ts` / `manager.ts` / `tool.ts`(新目录)。
- `src/tools/mcp_connect.ts`(或并入 mcp 目录的工厂)。
- `src/cli/index.ts`:创建 `McpManager`,传 REPL / one-shot;`buildTools` 每轮 `++ manager.getConnectedTools()`。
- `src/cli/repl.ts`:`/mcp`、`/mcp connect <name>` 命令;每轮 tools 重建。
- `src/permissions/engine.ts`:readOnlyNames 缺省(与 M1 共用的参数,REPL 装配时传合并闭包)。
- `docs/mcp.md` + `examples/mcp-server/`(示例:一个最小 stdio server,供本地验证)。
- `docs/architecture.md` 目录树更新。

**测试**:mock server(InMemoryTransport)集成、状态机 4 态、权限、配置 Trust 门控、CLI/REPL。全量回归。

**验收**:`/mcp` 列出已配置 server;`mcp_connect filesystem` 返回工具清单;模型能调 `mcp__filesystem__read_file` 读到文件(本地 mock);http/sse 各连一遍;断线后重连成功。

### M3 — StreamingToolExecutor(决策 C)

**文件**:

- `src/core/execute.ts`:新增 executor;`executeToolCalls` 改薄封装或保留。
- `src/core/query.ts`:流式回调改 `addTool` 即时入队;流结束后 `getResults` 回填。

**测试**:execute 单测 + query 集成 + 原并发用例回归。

**验收**:长时间任务里模型边输出边跑工具(观测到工具先于响应完结启动);只读并行/写串行/结果顺序回归不破;全部 236+ 用例绿。

### M4 — 0.5.0 发布

- `docs/context-management.md` 无影响;`docs/permissions.md` 补 plan 模式与 readOnlyNames;README 补「Plan 模式 / MCP / 并发强化」特性 + 当前版本 0.5.0 + MCP 接入指引;`CHANGELOG.md [0.5.0]`;`package.json` 0.5.0。
- `CLAUDE.md`:工具数(10 → 12:enter_plan_mode/exit_plan_mode/mcp_connect;MCP 工具动态)、测试用例数、架构段(新增 mcp 服务目录)。
- CI 三 OS × Node 20/22/24 全绿(重点验证:SDK 打包后 CLI 冒烟、stdio server spawn 在三平台、mock server 测试无网络依赖)。
- tag `v0.5.0` → push 等 CI 全绿 → `npm pack` 检查 → `npm publish --access=public` → `npm view` 验证(复用 0.4.3 流程)。

---

## §3 DoD 验收清单

- [ ] `PermissionMode` 含 `"plan"`;`--mode plan` 报非法值(CLI 冒烟)
- [ ] plan 下:写/run_bash/verify/remember/MCP 非只读 → deny;read/glob/grep/repo_map/explore cwd 内 → allow;cwd 外 → ask(单测矩阵)
- [ ] `enter_plan_mode`:default/acceptEdits 下可进入;已 plan 报错;返回只读指引(单测)
- [ ] `exit_plan_mode`:非 plan 报错;写 plan 文件到 `.run-agent/plans/`(直写);恢复 prePlanMode;批准/拒绝两条路径(单测)
- [ ] `/plan` REPL 命令:手动进入 plan(不经模型判断);已在 plan 提示;两条进入路径共用同一状态机(单测 + CLI 冒烟)
- [ ] one-shot 不装配 plan 工具、无 `/plan`;REPL 完整走通 enter(模型或 `/plan`)→ 禁写 → exit(审批)→ 恢复(集成测试)
- [ ] MCP 依赖引入;`mcp.json` 用户级 + 项目级合读;项目级仅 Trust 加载(单测)
- [ ] 连接状态机 4 态:connected / failed / needs-auth / disabled;`/mcp` 列出、`/mcp connect` 重连(集成测试)
- [ ] `mcp_connect` 按需连接 + listTools;包装 `mcp__server__tool`:desc 截断 2048 / 懒 schema(`{type:"object"}`) / `isConcurrencySafe=readOnlyHint`(单测)
- [ ] MCP 工具走同一权限管线:`readOnlyNames` 参数缺省语义不变;只读 hint allow / 非只读 default ask / acceptEdits allow / plan deny;`mcp_connect` 免确认(单测)
- [ ] mock server(InMemoryTransport)集成:连接 → listTools → 调用 → 断开 → 重连(单测)
- [ ] StreamingToolExecutor:流式期间 block 完整即执行(可观测早于响应完结);结果按 index 重排;只读并行上限/写串行回归(单测 + 集成)
- [ ] 原「并行/串行/上限/顺序」并发用例全量回归不破(回归)
- [ ] 文档:plan-mode.md / mcp.md / 示例 server / README / permissions.md / CHANGELOG / architecture;版本 0.5.0
- [ ] 0.5.0 发布:CI 3 OS × Node 20/22/24 全绿 / tag / `npm pack` / `npm publish` / `npm view` 验证
- [ ] **真实模型手动验证(需 key)**:接 1 个真实 MCP server(如 filesystem/GitHub)并调其工具;复杂任务先展示计划再动手;长时间任务工具并行执行

## §4 风险与注意

1. **MCP SDK 打包与 Node 版本**:SDK 较大、涉及传输层(`ws` 等可选依赖);tsup 单文件 bundle 需验证 tree-shaking 与 Node ≥20 兼容。缓解:CI 三 OS 冒烟锁死;若 bundle 过大,`external` 化 SDK 走 node_modules 运行时依赖。
2. **MCP 工具参数黑盒**:路径白/黑名单够不到 MCP 工具参数 → 非只读 MCP 工具 default 必 ask + 文档信任边界。这是协议分层的固有形态,不是可修 bug。
3. **plan 模式死锁**:one-shot 不装配 plan 工具、无 `/plan`(无审批弹窗,纯 ReAct);`exit_plan_mode` 校验非 plan 不可用;`/plan` 仅 REPL 存在;REPL 下 ask 复用唯一 readline(沿用多 y 修复的注入模式)。
4. **执行器改动是 loop 主路径**:StreamingToolExecutor 替换 batch 执行是 0.4.3 全绿后的核心变更,回归风险高。缓解:对外契约(结果顺序/错误文本/并发上限)一字不改,单测先锁定原 batch 语义再改,`getResults` 幂等。
5. **stdio server 进程生命周期**:子进程泄漏会拖垮长会话。缓解:`onclose` 清缓存自动重连 + 退出时 SIGINT→SIGTERM→SIGKILL 升级回收 + 600ms 兜底(学参考实现);stderr 收集上限防内存增长。
6. **MCP 工具注入的 token 成本**:desc 截断 2048 + 懒 schema(`{type:"object"}`)是双保险;默认按需连接,未连接 server 零 token。`preconnect:true` 用户自担。
7. **懒 schema 的副作用**:模型没有字段约束,可能传错参数 → server 校验错误回填 tool_result,模型自行修正(与参考实现一致,代价是偶发一次错误往返)。
8. **计划文件在危险目录下**:`.run-agent/plans/` 由 `exit_plan_mode` 直写(系统行为),agent 工具读不到也不该读(plan 全文在 tool_result 回填);`docs/plan-mode.md` 注明。
9. **任务级并发边界**(见决策 C3):V5 只交工具级;若用户预期「同时跑多个查询」,需 V7。方案内已诚实标注。
10. **发布纪律**(0.4.2 教训):全平台 CI 转绿再 publish;`npm pack` 检查无源码/`.run-agent` 泄漏。工程纪律沿用(exactOptionalPropertyTypes / verbatimModuleSyntax / zod v4 instanceof / BOM)。

## §5 交接(V4.5 → V5 → 后续)

**V4.5 → V5 依赖**:

- 权限三层模型(决策 A-F)是 plan 模式与 MCP 权限管线的地基:plan 分支建在统一判定顺序上;`readOnlyNames` 参数扩展不破坏现有语义;记忆读豁免(专属通道)在 plan 模式保持放行(只读白名单内)。
- 0.4.1 `explore`(只读工具集)复用为 plan 下探索通道,不新增 planAgent 子 agent(V7 再泛化)。
- `.run-agent/mcp.json` 与 `.run-agent/permissions.json` 同受 Trust 门控,防注入语义一致。

**V5 → V6(Hooks / Skills / Headless)**:MCP 工具与 plan 导航工具给 `PreToolUse`/`PostToolUse` 提供事件源;`mcp_connect` 的按需连接为 headless `--print` 的 JSON 状态输出铺路(resources/prompts 可在此补)。

**V5 → V7(多 Agent)**:**任务级/后台并发、`run_in_background`、Agent 工具泛化(explore 泛化)依赖本版的 StreamingToolExecutor 与连接管理心智模型**;专门的 planAgent 子 agent(只读 plan 模式,roadmap「可选」项)在 V7 与 Agent 工具一起落地;V7 后台记忆提取子 agent 复用 MCP 的 mock server 测试基建。
