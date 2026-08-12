# Plan V7 — 多 Agent 编排(子 agent 基建 + 协调者三件套 + 验证专家 + 后台记忆,交付 0.7.0 + 0.7.1)

> 上游:`docs/Plan.md` 路线图 V7 段(260-274 行):「coordinator + specialist 团队分工完成跨模块任务。**放最后:单 agent 不可靠时,多 agent 只会放大问题。**」
> 上一版本交接:`docs/Plan_V6.md`(0.6.0 Hooks + Skills + 自定义命令 + Headless)+ `docs/Bug_V6.md`(3 条:轨迹并入过早 / Windows `process.exit` libuv 崩溃 / macOS `/var→/private/var` pathInCwd 误判)。**V0–V6 全部已实施并发布**(CHANGELOG 0.1.0 → 0.6.0,CI 9 job 全绿,详见 §0)。
> 本版本一句话:让 run-agent 能**组织并指挥一个 agent 团队**——`agent` 工具把子查询递归化(可后台并行、可换低成本模型、权限继承父级、**可寻址**),内置 general-purpose / explore / verification 三种 agent 类型 + 用户自定义 frontmatter;**协调者三件套**(Agent + SendMessage + TaskStop)让主 agent 以项目经理身份拆解委派、运行时补充需求、止损失控任务;非平凡改动由验证专家子 agent 出具证据化 `VERDICT`;每轮对话结束后台提取跨会话记忆(双轨补上 V4 单轨对快模型触发不可靠的缺口)。
> 触发:路线图 V7 段为既定范围;**2026-08-12 用户拍板:SendMessage / TaskStop 从 V8 拉回本版**,coordinator 完整落地三件套;V4 记忆「后台提取双轨推迟到子 agent 基建」在此落地。
> 参考实现:`F:\CC_Source\claude-code-sourcemap\restored-src` —— `src/tools/AgentTool/`(AgentTool.tsx + runAgent.ts + forkSubagent.ts + built-in/verificationAgent.ts)、`src/coordinator/coordinatorMode.ts`、`src/tools/SendMessageTool/`、`src/tools/TaskStopTool/`、`src/services/extractMemories/extractMemories.ts`。本版对齐其语义、裁剪其规模(单循环递归架构,无常驻独立进程)。
> 工期参考:≈ 4 周,拆两版交付 **0.7.0**(子 agent 基建 + 协调者三件套,≈3 周)+ **0.7.1**(验证专家 + 后台记忆,≈1 周)。

## §0 结论速览

**前置核验(V0–V6 实施状态,2026-08-12)**:

- **V7 0.7.0 已发布**:npm latest = 0.7.0;commit(见 git log)+ tag `v0.7.0`;CI 3 OS × Node 20/22/24 全绿。多 Agent 编排落地——`agent` 工具 + 协调者三件套(send_message/task_stop)+ `--coordinator` + 自定义 agent 类型(frontmatter)。文档 `docs/agents.md`;Bug 记录无(V7-0.x 未发现,如有归入 `docs/Bug_V7.md`)。
- **V6(0.6.0)已发布**:npm latest = 0.6.0;commit `19d0195`(V6 主体)+ `59dd636`(V6-3 macOS pathInCwd 修复);tag `v0.6.0`;CI 3 OS × Node 20/22/24 9 job 全绿。Bug 记录 `docs/Bug_V6.md`(3 条)。
- **V6 DoD 仅剩「真实模型手动验证(需 key)」**:hooks 触发 / skill 激活 / headless 全链路——不是代码缺口,同 V4/V5 列为每个版本验收尾项。
- **0.4.1 `explore` 子 agent 是 V7 的种子**:已实现「嵌套 runQuery + 只读工具集 + 权限继承 + 上下文独立 + thoroughness」,注释明确「**后台运行与模型选择留到 V7(泛化为 Agent 工具)**」;`docs/Plan_V6.md` §5 交接段同义标注。V7 把它泛化成 `agent` 工具 + 类型注册表。
- **runQuery 注入点已核验**(2026-08-12,`src/core/query.ts`):while 迭代顶部是外部消息注入点;catch 分支的 transient 重试与 `prompt_too_long` 反应式压缩需要为 AbortError 让路(AbortError 必须直接上抛不重试);`end_turn` 分支(282-285 行)是轮末后台收集的挂点——三者本版都要动。

**V7 交付什么(拆两版)**:

**0.7.0「子 agent 基建 + 协调者三件套」**:

1. **runAgent + `agent` 工具**(决策 A):递归复用 `runQuery`(独立上下文 / 独立 transcript);`run_in_background` 后台并行、**任务可寻址**(task id,轮末自动收集汇总进最终回复);`model` 覆盖(工厂注入,低成本模型跑后台任务);权限继承父级(background 下 ask→deny)。`explore` 工具保留为兼容别名(内部走 explore 类型)。
2. **agent 类型 + frontmatter**(决策 B):内置 general-purpose / explore / verification 三型 + 用户自定义 `.run-agent/agents/<name>.md` / `~/.config/run-agent/agents/<name>.md`(frontmatter: name / description / model / tools / system / maxIterations)→ **团队状态跨会话持久化**(定义即文件)。
3. **协调者三件套**(决策 C):`--coordinator` 换协调者 system prompt;**`SendMessage`**(向运行中后台子 agent 注入补充消息,迭代边界送达)+ **`TaskStop`**(abort 传播、止损失控任务、部分结果保留)——主 agent 以项目经理身份完整指挥团队。

**0.7.1「验证专家 + 后台记忆」**:

4. **verification 子 agent**(决策 D):对抗性验证专家——按改动类型分策略 + 强制步骤(构建→测试→lint→回归)+ 反合理化清单 + 对抗探针 + **证据化输出契约**(每条 check 必须 `Command run:` + `Result:`;收尾字面量 `VERDICT: PASS/FAIL/PARTIAL`);强制只读(禁写项目文件,临时脚本只许 /tmp);主 agent 契约(非平凡改动完成前必须 spawn)。
5. **后台记忆提取双轨**(决策 E):每个完整 query loop 结束触发一次后台提取子 agent(独立 transcript + 低成本模型),**游标增量**分析最近消息 → 更新 `.run-agent/memory/`;主 agent 本轮已 `remember` 则跳过(双轨互斥);**仅 Trust 且非 `--bare`**;失败吞掉不阻断、游标不推进下次重试。

**技术栈增量**:

- **零新依赖**:全部复用 runQuery / StreamingToolExecutor / 权限引擎 / remember + memory 模块 / 会话持久化。
- 新增目录:`src/services/agents/`(registry + loader + builtin)、`src/services/agents/team/`(task registry + SendMessage/TaskStop)、`src/services/extract/`(记忆提取);新增文件 `src/core/run_agent.ts`、`src/tools/agent.ts`、`src/tools/send_message.ts`、`src/tools/task_stop.ts`;新增文档 `docs/agents.md`。

**不做的事(留待后续,诚实标注)**:

- **跨会话常驻团队 → V8**:本版 task registry 是 session 级,后台任务跑完即回收,agent 定义才跨会话持久化(定义即文件);常驻 teammate(跨轮存活、可寻址、团队 transcript 合并)需要常驻 agent 循环 + V8 基础设施,不做。
- **TeamWait / 主动 await 工具 → 不做**:点名三件套是 Agent/SendMessage/TaskStop;等待语义 = 轮末 `awaitAll` 自动收集,不新增第四件。
- **子 agent 进程树 / 进度可视化 → V8 TUI**;REPL 只加 `/tasks` 查看后台任务状态(文本列表)。
- **coordinator 常驻进程 / 多循环模型 → 不做**:system prompt 变体 + 三件套足够,架构保持单循环。
- **完整 LSP / 向量检索记忆 → 后续**(repo_map 只需定位,记忆检索仍关键词 + 索引)。

---

## §1 架构决策

### 决策 A:`runAgent` + `agent` 工具(子 agent 基建)

**动机**:路线图 V7 决策 1;0.4.1 explore 是种子(只读、前台、继承 client)。本决策把「嵌套 runQuery」泛化成通用委派原语:类型可换、可后台、可换模型、权限继承、**可寻址**。

**A1. `runAgent` 核心(`src/core/run_agent.ts`)**

```ts
export interface AgentRunOptions {
  prompt: string;
  client: LLMClient;
  tools: Tool[] | (() => Tool[]);          // 按类型解析出的工具集
  system?: string;                          // 类型 base system + 主 system 快照拼接(见 A5)
  contextWindow?: number;
  checkPermission?: (tool: Tool, input: unknown) => Promise<PermissionCheckResult>;
  maxIterations?: number;
  querySource?: string;                     // 'subagent' | 'extract_memories'(防 compact 递归)
  onText?: (t: string) => void;             // 可选:流式转发到主输出
  transcriptFile?: string;                  // 独立 transcript JSONL(roadmap「独立 transcript」)
  resultsDir?: string;                      // 继承主会话超大结果落盘
  signal?: AbortSignal;                     // TaskStop 传播(决策 C3)
  pollExternal?: () => LLMMessage[] | undefined; // SendMessage 注入(决策 C2)
}
export async function runAgent(opts): Promise<{ reply: string; messages: LLMMessage[]; iterations: number }>
```

- **实现 = `runQuery` 薄封装**:`runQuery([{ role: "user", content: prompt }], { client, tools, system, contextWindow, checkPermission, maxIterations, querySource, onText, resultsDir, signal, pollExternal })` → 返回 `{ reply, messages, iterations }`;transcript 用 `result.added` 逐条 `appendMessage(transcriptFile, m)`(复用会话持久化)。
- **独立上下文**:runQuery 每次流请求独立;compact / 重试只作用于本子查询,不污染主会话。子查询异常由调用方兜底(agent 工具转 tool_result 文本,不 throw)。
- **防递归**:子 agent 工具集**默认不含 `agent` 工具**(general-purpose 类型同样排除——无限嵌套是大风险);`SendMessage` / `TaskStop` 同理默认不含(worker 无协调权,那是主 agent 的职责,决策 C5);自定义 frontmatter `tools: ["agent", ...]` 显式开启才可嵌套,且嵌套层数由各层 maxIterations 天然封顶。

**A2. `agent` 工具(`src/tools/agent.ts`)**

```ts
schema = z.object({
  description: z.string().min(1).describe("A short (3-5 word) description of the task"),
  prompt: z.string().min(1).describe("The task for the agent to perform"),
  agentType: z.string().optional().describe("general-purpose | explore | verification | 自定义 frontmatter 类型"),
  model: z.string().optional().describe("Model override; 优先级 调用参数 > 类型 frontmatter > 继承父级"),
  run_in_background: z.boolean().optional().describe("后台运行:立即返回 task_id,本轮结束自动收集结果汇总"),
});
```

- `name: "agent"`;`isConcurrencySafe: true`——多个 specialist 可同批并行(子 client 每流独立、无共享可变状态;task registry 仅 `Map` push,无竞态)。
- **agent 工具本身归只读**(default 免确认):spawn 子 agent 不改项目,子 agent 内部任何写仍走继承的权限管线,无权限提升。装配:`readOnlyNames` 闭包加 `"agent"`(repl.ts `makeCheckPermission` 缺省只读判定与 index.ts readOnlyNames 同步)。
- call 流程:解析 `agentType` → `AgentRegistry` 查类型定义(工具集 / base system / maxIterations / 默认 model)→ 若显式 `model` 且注入了 `makeModelClient` 工厂 → 建子 client,否则继承父 client → `run_in_background` 分流:
  - **foreground**:`await runAgent(...)` → 回填 `[<agentType> 结论]\n<reply>`(前缀标注来源,模型能区分)。
  - **background**:`BackgroundTaskManager.spawn({ type, prompt, client, ... })` → 返回占位 **`[后台子 agent <id>(<type>) 已启动 — <prompt 前 60 字>;运行中可用 SendMessage 补充 / TaskStop 停止]`**(id 可寻址)。

**A3. model 覆盖(工厂注入)**

- `AgentToolOptions.makeModelClient?: (model: string) => LLMClient`。CLI 装配:`(m) => createClient(cfg.provider, { ...(apiKey ? { apiKey } : {}), model: m, ...(cfg.baseURL ? { baseURL } : {}) })`(provider/apiKey/baseURL 与主一致,只换 model)。
- `model` 对 run-agent 是**自由字符串**(多提供商,非 Claude Code 的 sonnet/opus/haiku 枚举);测试注入 fake client 工厂断言「工厂被调 + 收到预期 model」。
- **后台记忆提取用此机制跑低成本模型**(extractMemories 类型 frontmatter `model: <便宜模型>`)。

**A4. 权限继承(子 agent 权限不高于父级)**

- **foreground 子 agent**:复用父级 `checkPermission`(ask 走主 REPL readline——主循环 await 子查询期间 REPL 空闲,可安全弹窗;headless 下 canPrompt=false 天然 deny)。
- **background 子 agent**:**ask→deny 包装**(`d === "ask" ? "deny" : d`,同 0.4.1 exploreCheckPermission)——后台无交互绝不弹窗;用户 allow/deny 规则层照常生效。
- 硬底线全程生效:engine 内置 deny(`.git` / `.run-agent` / 危险命令)在子 agent 的 checkPermission 里同样判 deny,子 agent 无法绕过父级安全边界。

**A5. 子 agent system 组装**

- 子 system = **类型 base system**(内置各型给一段角色/约束提示,如 explore 的只读宣言、verification 的策略契约)+ **主会话 system 快照**(含 MEMORY.md 索引,让 specialist 感知项目记忆与约定)+ **类型 body**(frontmatter body / 内置说明)。
- 一次性组装(不逐轮重建):子查询一轮就结束,git 动态段对子 agent 价值低,省一次 execFile;稳定/动态边界仍复用 `buildSystemPrompt` 同款,防破坏主会话 cache 前缀的复用性。

**A6. 后台任务注册表(`BackgroundTaskManager`,`src/services/agents/team/registry.ts`)**

```ts
interface BackgroundTask {
  id: string;            // 递增序号或随机短 id(可寻址)
  type: string;
  prompt: string;
  status: "running" | "done" | "stopped" | "failed";
  reply?: string;        // 已产出文本(stopped 时是部分结果)
  pending: string[];     // SendMessage 注入队列
  abort?: AbortController;
  transcriptFile?: string;
}
class BackgroundTaskManager {
  spawn(task): string;                       // 注册 + 启动 fire-and-forget 执行 → id
  send(id, message): string;                 // 决策 C2;push pending
  stop(id): string;                          // 决策 C3;abort + status → stopped
  poll(id): LLMMessage[] | undefined;        // 子查询迭代边界取 pending 并清空(C2)
  isAborted(id): boolean;                    // C3
  awaitAll(): Promise<string[]>;             // 等全部 running 完成 → 摘要行数组(done/stopped/failed 区分)
  list(): BackgroundTaskInfo[];              // /tasks 用
}
```

- 单线程事件循环内:**send / poll 无竞态**(poll 原子取空 pending);**awaitAll 与主循环收集**在 `end_turn` 分支(A7)。
- 创建于 `main()`(session 级,零任务零开销),注入 agent 工具 + SendMessage/TaskStop 工具 + queryOpts。

**A7. 轮末自动收集(汇总进最终回复)**

- `runQuery` 加可选 `onBackgroundDone?: () => Promise<string[]>`——在 `stopReason === "end_turn"` 分支、返回前:
  - `await onBackgroundDone()`;若有完成结果 → push `[后台子 agent 结果]\n<摘要行>` 为新的 user 轮并 `continue`(让最终回复包含汇总,模型再产出一轮收尾);
  - 无 → 正常返回。
- **收集语义**:done → `- <id>(<type>): <reply 前 N 字>…`;**stopped → `- <id>(<type>): [已停止] <部分 reply 摘要>`**(决策 C3);failed → `- <id>(<type>): [失败: 原因摘要]`。
- **轮数预算**:后台等待计入 `iterations`,`maxIterations` 封顶防失控;本轮同时有前台工具时后台任务并行跑,不拖长前台路径。
- 与 headless 契约:agent / SendMessage / TaskStop 调用都进 tools 轨迹(`name: "agent"` 等);后台汇总以新 user 消息出现、不改变 JSON 字段(V6→V7 交接点兑现,向后兼容)。
- REPL `/tasks` 命令列出后台任务状态(running/done/stopped/failed + reply 摘要)。

**决策 A 配套测试**:

- `runAgent`:独立上下文(子查询消息不污染主消息数组)、transcript 落盘(沙箱临时文件)、querySource 传透、`signal`/`pollExternal` 传透。
- `agent` 工具:foreground 回填带前缀结论;background 立即返回占位(id 可寻址)+ 轮末 `onBackgroundDone` 自动汇总(注入慢响应 mock LLM 测时序);`model` 工厂被调 / 未调;未知 agentType 回填报错。
- 权限:background 下 ask→deny;子 agent 写工具走继承权限;内置 deny 硬底线不破;`readOnlyNames` 含 agent。
- 并发:同批两个 `agent` 调用并行执行(注入记录并发度的 mock)。

---

### 决策 B:agent 类型 + frontmatter(团队状态持久化)

**动机**:路线图 V7 决策 1 内置类型 + 决策 5「团队状态持久化:跨会话保留 agent 定义」。定义即文件——与 skills/commands 同机制,天然跨会话。

**B1. 内置三型(硬编码,进 registry)**

| 类型 | 工具集 | 权限策略 | 说明 |
| ---- | ------ | -------- | ---- |
| `general-purpose` | 父级全部工具(**不含 agent/SendMessage/TaskStop**,防递归) | 继承父级(foreground ask 可弹) | 通用委派 worker |
| `explore` | repo_map / glob / grep / read_file(0.4.1 只读集) | 继承父级(只读 default 免确认) | 只读探索;`thoroughness` 控制深度(quick/medium/very thorough → 4/8/12 轮) |
| `verification` | 只读集 + verify + run_bash(受限) | 决策 D3 专门策略(safe bash 放行 / 项目写 deny / /tmp 放行) | 对抗性验证(0.7.1) |

- **协调者三件套只装配进主 agent 工具池**,内置子 agent 类型默认不含——worker 职责单一,无协调权,防「子 agent 再 spawn 子 agent」的递归失控(自定义 frontmatter `tools` 显式加才开)。
- **0.4.1 `explore` 工具保留为兼容别名**:`makeExploreTool` 内部转成 explore 类型走 runAgent(对外 schema `{prompt, thoroughness}` 与行为不变,现有测试全量回归)。不删旧工具,避免破坏既有会话/测试。

**B2. 自定义 frontmatter(团队状态持久化的载体)**

- 路径:**项目级** `.run-agent/agents/<name>.md`(仅 Trust 加载)+ **用户级** `~/.config/run-agent/agents/<name>.md`(始终)。与 skills/commands 同语义:loader 直接 fs 直读,`.run-agent` 在内置 deny 段内,模型工具碰不到 agent 定义文件(提示注入面低)。
- frontmatter:`name`(必填,slug)/ `description`(可选,用途说明)/ `model`(可选,默认模型)/ `tools`(可选,工具名数组,缺省 = 全部不含 agent/SendMessage/TaskStop)/ `system`(可选,附加 system 片段)/ `maxIterations`(可选,子查询轮数上限)。body = 类型专属指令(并入子 system)。
- 解析:剥 BOM → frontmatter 子集(zod 校验,非法跳过告警不阻断),对齐 skills loader。
- 加载:`loadAgents(cwd, isTrusted)` + `AgentRegistry`(内置 + 自定义合并;内置优先,自定义不覆盖内置名)。
- 跨会话:agent 定义在文件里,天然持久化;`docs/agents.md` 写「内置类型 / 如何自定义 frontmatter / 权限继承 / run_in_background 语义」。

**决策 B 配套测试**:扫描 + Trust 门控(未 Trust 项目不加载自定义类型);frontmatter 解析(合法 / 缺 name 跳过 / 非法 tools 数组跳过);tools 过滤生效(自定义类型只给声明的工具,且默认不含三件套);内置与自定义合并、同名内置优先;经 `agent` 工具 `agentType=<自定义名>` 调起且 body 进子 system。

---

### 决策 C:协调者三件套(coordinator + SendMessage + TaskStop)

**动机**:路线图 V7 决策 2「主 agent 换协调者 system prompt,拆解委派 worker」+ 决策 3(Agent 三件套)。**2026-08-12 用户拍板 SendMessage / TaskStop 拉回本版**——V7 完整落地三件套,不再推迟。run-agent 主循环本身就是「主 agent」,无需新进程——换 system prompt 即成协调者,三件套让它可以**运行时指挥**而非单向 fire-and-forget。

**C1. `--coordinator` 模式**

- `--coordinator` flag + `SystemContext.coordinator?: boolean` → `buildSystemPrompt` 动态段注入协调者段落(完整引导):

```
你是协调者。把跨模块任务拆成可并行子任务,用 agent 工具委派 specialist
(优先 run_in_background=true 并行,拿 task_id;写类子任务串行委派)。
任务运行中如补充信息/修正需求,用 SendMessage 发给对应 task_id;
发现委派错误/任务失控/需求已变,用 TaskStop 止损。
收齐后汇总:核对每个子任务结论与原始目标,冲突/缺口重新委派或自己补上。
```

- 主 agent 仍是完整 agent(协调者 + 兜底执行者),只引导「优先委派」。`--bare` 下不注入(与记忆注入同语义)。

**C2. `SendMessage` 工具(`src/tools/send_message.ts`)**

```ts
schema = z.object({
  task_id: z.string().min(1).describe("The ID of the running background agent, e.g. from the agent tool result"),
  message: z.string().min(1).describe("The message to send to the running agent"),
});
```

- `name: "send_message"`;`isConcurrencySafe: true`;归内置只读(纯内存操作,免确认)。**只装配进主 agent 工具池**(C5)。
- call → `BackgroundTaskManager.send(task_id, message)`:
  - **running 任务**:`task.pending.push(message)` → 回填 `[已发送给后台子 agent <id>: <message 前 60 字>]`。
  - **不存在 / 已 done / 已 stopped**:回填 `[任务 <id> 不存在或已结束,无法发送;当前状态: <status>(<reply 摘要前 60 字>)]`——模型据此重新委派或接受结果。
- **送达机制(runQuery 外部注入)**:runQuery 在 ReAct while 迭代**顶部**(压缩检查前)调 `opts.pollExternal?.()`——子查询每轮迭代开始时从 task 的 pending 队列取消息,非空则 `pushConversation({ role: "user", content: message })` 并 `continue`(新 user 轮,消息进 added/子 transcript)。注入在迭代边界、非工具执行中途,不破坏 tool_use/tool_result 配对。
- 语义:SendMessage 是**尽力而为的追加指令**——子 agent 可能已快跑完,消息送达与否由状态判;协调者据此决定补充 vs 重新委派。

**C3. `TaskStop` 工具(`src/tools/task_stop.ts`)**

```ts
schema = z.object({
  task_id: z.string().min(1).describe("The ID of the background agent to stop"),
});
```

- `name: "task_stop"`;`isConcurrencySafe: true`;归内置只读。只装配进主 agent 工具池。
- call → `BackgroundTaskManager.stop(task_id)`:
  - **running**:`task.abort.abort()`(传播到子查询的 `signal`)+ `task.status = "stopped"` → 回填 `[已请求停止后台子 agent <id>]`。
  - **不存在 / 已结束**:回填状态提示(幂等,不报错)。
- **abort 传播(runQuery 支持 AbortSignal)**:
  - `RunQueryOptions` 加 `signal?: AbortSignal`;`client.stream(requestMessages, { tools, maxTokens, signal })` 透传(适配器实现;Anthropic / OpenAI SDK 原生支持,ollama 复用)。
  - **循环顶部** `if (opts.signal?.aborted) throw <AbortError>`。
  - **catch 分支给 AbortError 让路**:`isAbortError(e)` 直接上抛——**不进入 transient 重试、不进入 prompt_too_long 反应式压缩**(否则 abort 会被吞掉重跑)。
  - 后台执行器捕获 AbortError → `runAgent` 返回 `{ reply: 已产出部分文本, aborted: true }` → task 保持 `stopped`、reply 保留部分结果。
- **轮末收集**:stopped 任务在 awaitAll 里直接返回(不等),摘要行带 `[已停止]` 前缀(A7)。

**C4. 团队 transcript 与可寻址性**

- 每个后台任务独立 `transcriptFile`(roadmap 决策 1「独立 transcript」):`~/.local/share/run-agent/sessions/<ts>-<id>.subagent-<taskId>.jsonl`。子查询 `added` 逐条落盘;SendMessage 注入的 user 消息经 pushConversation 进 added → 天然记入子 transcript。**团队侧**由主会话 JSONL 的 agent/SendMessage/TaskStop 工具轨迹 + `/tasks` 状态覆盖,不做跨 transcript 合并(→ V8 常驻团队再做)。
- task_id 可寻址:agent 工具返回占位含 id;SendMessage / TaskStop 以 id 为参。

**C5. 权限与装配范围**

- 三件套 agent / send_message / task_stop 全归内置只读(`readOnlyNames` 闭包 + `makeCheckPermission` 缺省只读判定同步);**只装配进主 agent 工具池**——子 agent 内置类型工具集不含三件套(决策 A1/B1),自定义 frontmatter 显式 `tools` 可加(深度委派场景)。

**决策 C 配套测试**:

- `--coordinator`:system 含协调者段落、`--bare --coordinator` 不注入;端到端 mock:主 agent 拆 2 个后台 explore 子任务 → 轮末自动汇总 → 最终回复含两子任务结论(注入确定性 mock LLM)。
- SendMessage:注入队列 push;子查询迭代边界 poll 收到并注入子上下文(慢响应 mock:主 agent 发消息 → 子 agent 下一轮收到新 user 轮);任务已结束再发 → 回填状态提示文本;注入消息进 added/子 transcript。
- TaskStop:abort 传播(mock client.stream 收到 signal abort);catch 分支 AbortError 不重试、直接上抛;stopped 状态保留部分 reply;轮末收集注入 `[已停止]` 摘要;对不存在任务幂等。
- 三件套归只读:default/headless 免确认;子 agent 工具集默认不含三件套。

---

### 决策 D:verification 子 agent(0.7.1)

**动机**:路线图 V7 决策 3。蓝本 `verificationAgent.ts`。与 0.4.1 `verify` 工具的关系:verify 是**单文件基线**(跑 tsc/eslint/test 读回错误让模型自修);本项是**子 agent 级对抗性验证**(按改动类型定策略 + 强制步骤 + 探针 + 证据契约)。verify 工具可作为 verification 子 agent 的工具之一,两者并存不替代。

**D1. 触发契约(主 agent 侧)**:system 指引 + 文档约定——**非平凡改动(3+ 文件 / 后端 / API / 基础设施)完成前必须 spawn verification agent**,传「原始任务描述 + 改动文件清单 + 实现方式」。`VERDICT: FAIL` → 修 → 重新 spawn → 直到 PASS;PASS → 主 agent 自行 spot-check 2-3 条命令复核。同 Claude Code 的 prompt 层约束(不强硬拦,文档写明主 agent 义务)。

**D2. 子 system(注入策略 / 反合理化 / 探针 / 契约,精简自蓝本)**:

- **按改动类型分策略**:前端(起 dev server → 浏览器自动化或用 curl 探页面子资源——HTML 可 200 而它引用的资源全挂 → 前端测试);后端 / API(起 server → curl → 校验**响应形状**而非仅状态码 → 错误处理 → 边界值);库 / 包(构建 → 全量测试 → 从全新上下文按消费者姿势 import 调公共 API → 类型 / README 示例核对);重构(既有测试**原样**通过 → diff 公共 API 表面 → 同输入同输出 spot-check)。
- **强制步骤**:构建(可构建则构建,坏了 = 自动 FAIL)→ 项目测试(有则跑,挂了 = 自动 FAIL)→ 类型策略。
- **反合理化清单**:「代码看着对」→ 跑起来;「实现者测试过了」→ 独立验证;「没有浏览器 / 没有环境」→ 先确认工具再下结论,不许自编"做不到"故事。
- **发 PASS 前**:至少一条对抗性探针(并发 / 边界 / 幂等 / 孤儿操作)及其结果——全是 200 / 测试通过 = 只确认了 happy path,不算验证。
- **发 FAIL 前**:核对不是误报(环境问题 / 有意行为 / 外部契约不可改——不可行动的"bug"记为 observation 而非 FAIL)。

**D3. 工具集与权限(强制只读)**

- 工具集:repo_map / glob / grep / read_file + `verify` + `run_bash`(无 write / edit)。
- **verification 权限策略**(专门的 checkPermission):
  - `classifyBashCommand(cmd) === "safe"` → 自动 allow(构建 / 测试 / lint 不弹窗);
  - `pathInCwd` 判**项目内写入** → deny(禁写项目文件,含 run_bash 的写重定向与 write/edit——工具集已无写工具,此为 run_bash 层的收口);
  - 写入 `/tmp`(或 `$TMPDIR`)放行(临时脚本);
  - 其余危险命令(rm -rf /、git push --force 等)engine 硬底线 deny。
- 子 system 强调:临时脚本只许 /tmp,用后清理;不改项目任何文件。

**D4. 输出契约(证据化,验收核心)**

- 每条 check 必须含 `Command run:`(实际命令)+ 输出 + `Result: PASS/FAIL`(FAIL 带 Expected vs Actual)。**无 Command run 块的 PASS 判拒**(收尾解析器发现 PASS 但无命令证据 → 视为违规)。
- 收尾字面量 `VERDICT: PASS | FAIL | PARTIAL`(PARTIAL **仅限环境性限制**:无测试框架 / 工具不可用 / server 起不来;能跑就必判 PASS/FAIL)。
- 解析器(主 agent 侧辅助,或 verification 类型自校验):校验 VERDICT 字面量合法 + PASS 须有命令证据;校验不通过 → 回填告警让主 agent 重新委派。

**决策 D 配套测试**:工具集断言(无 write/edit);权限策略(safe bash allow / 项目写 deny / /tmp 放行 / 危险命令 deny);契约校验(mock 回复缺 Command run 的 PASS 被拒;VERDICT 字面量解析 PASS/FAIL/PARTIAL;非法字面量告警);子 system 含策略与反合理化段落(单测断言)。

---

### 决策 E:后台记忆提取双轨(0.7.1)

**动机**:V4(0.4.0)记忆只做**单轨**(主 agent system 指引「发现稳定结论用 remember」)——真实会话暴露对 `deepseek-v4-flash` 这类快模型触发不可靠(0 次调用)。双轨 = 主 agent 主动写 + **每轮结束后台提取子 agent 兜底**。蓝本 `extractMemories.ts`(已核实:游标增量 + hasMemoryWritesSince 互斥 + maxTurns 5 + 成功才推进游标)。用户已拍板:后台提取双轨推迟到子 agent 基建(即本版)。**V7 后台任务基建(决策 A6/A7)是它的直接依赖**——后台提取子 agent = `agent` 工具的后台任务 + 独立 transcript + 低成本 model,全部现成。

**E1. 触发与游标**

- 触发点:REPL 每完整 query loop 结束(`runTurn` 内 `runQuery` 返回、`end_turn` 且无工具调用后)——对齐蓝本「每轮结束 handleStopHooks」。
- **触发开关:仅 Trust 且非 `--bare`**;headless 不触发(CI 每次跑成本不可接受),文档注明。
- **游标**:`ExtractCursor = messages.length`(上次提取时的消息数)。每次触发取 `recent = messages.slice(cursor)`(模型可见消息),增量分析——第二次提取只分析新消息。**增量太少(< N 条)直接跳过不发请求**(成本守卫)。
- **互斥**:`recent` 里任一 assistant 消息含 `remember` tool_use(主 agent 本轮已直接写)→ **跳过并推进游标**(对齐 hasMemoryWritesSince;主/后台每轮互斥防重复)。
- 失败不推进游标 → 下次重试(对齐蓝本「成功才推进」)。

**E2. 提取子 agent(内置类型 extractMemories,复用 runAgent + background + model)**

- 工具集:read_file / glob / grep + `remember`。
- 权限策略:**ask→deny,唯一例外 `remember`→allow(仅 Trust)**——后台无交互;remember 本就写 `.run-agent/memory`、Trust 门控、幂等去重(name 一致跳过 / 更新)。
- 子 system:复用 `NOT_TO_SAVE_GUIDANCE`(memory.ts 已有:「不存代码结构 / 一次性调试 / CLAUDE.md 已写约定 / 会话琐事」)+ 四类 frontmatter(user/feedback/project/reference)说明 + 「**先读现有记忆索引再更新**防重复」。
- prompt:注入 `recent` 消息文本(截断,如 ≤ 30 条 / 60KB)+ **现有记忆清单**(复用 `buildMemoryIndexBlock` / `readIndexLines`,免子 agent 先 ls,对齐蓝本 formatMemoryManifest 预注入)+ 提取指令。
- `maxIterations: 5`(硬顶,防验证兔子洞);`querySource: 'extract_memories'`(防 compact 递归)。

**E3. 生命周期与成本**

- fire-and-forget:REPL `void extractMemories.trigger(...)`——不 await,不阻断下一轮 prompt。
- 失败吞掉(不抛、不阻断主流程),游标不推进。
- 成本:每 user turn 一次额外 LLM 调用;用**低成本模型**(extractMemories 类型 frontmatter `model`);游标增量 + 互斥跳过 + 增量太少跳过大幅降低实际触发次数。单次请求量级 ≈ 2-5k token(system 提取指令 + 工具定义 + 记忆索引 + 增量消息,非全量历史)。文档明示成本,给 `RUN_AGENT_DISABLE_MEMORY_EXTRACT` 环境变量关闭开关(可选,默认开)。
- 与轮末收集的关系:提取子 agent 用独立执行路径(直接 `runAgent`,**不入 task registry / awaitAll**)——它不是「委派结果」,不注入最终回复,静默落库。

**决策 E 配套测试**(沙箱 `USERPROFILE`/`HOME` + 临时项目目录,hermetic):

- 触发条件:Trust + 非 bare 才触发;未 Trust / bare / headless 不触发。
- 游标增量:跑两轮,第二次提取子 agent 收到的 prompt 只含新消息(注入记录 prompt 的 mock)。
- 增量太少跳过:新增 < N 条消息时不发请求(注入记录调用次数的 mock)。
- 互斥:主 agent remember 后跳过 + 游标推进。
- 提取子 agent 经 remember 写成功(临时目录内 `.run-agent/memory/<name>.md` + 索引更新)。
- 失败不推进游标、不抛异常;maxIterations = 5。

---

## §2 里程碑

### M1 — runAgent + `agent` 工具(决策 A 基建,0.7.0)

**文件**:

- `src/core/run_agent.ts`(新):`runAgent` 薄封装 + `AgentRunOptions`。
- `src/tools/agent.ts`(新):`agent` 工具(foreground/background 分流)。
- `src/services/agents/team/registry.ts`(新):`BackgroundTaskManager` 初版(spawn / list / awaitAll;send/stop 占位)。
- `src/core/query.ts`:`RunQueryOptions` 加 `onBackgroundDone?`;`end_turn` 分支自动收集(A7);`signal`/`pollExternal` 类型预留。
- `src/cli/index.ts`:`makeModelClient` 工厂;`BackgroundTaskManager` 创建并注入;`readOnlyNames` 加 `agent`;`buildTools` 装配 agent。
- `src/tools.ts`:`BuildToolsOptions` 加 `agentTool?`。
- `src/cli/repl.ts`:`/tasks` 命令初版;`makeCheckPermission` 缺省只读判定含 `agent`。

**测试**:决策 A 全量用例 + explore 工具回归(兼容别名不破)。

**验收**:mock 下主 agent 一次 foreground agent 调用拿到带前缀结论;一次 `run_in_background` 两个并行 specialist,轮末自动汇总进最终回复;后台任务 `ask` 降级 deny 不弹窗。

### M2 — SendMessage + TaskStop(runQuery 外部注入 + abort,0.7.0)

**文件**:

- `src/core/query.ts`:迭代顶部 `pollExternal` 注入(压缩检查前)+ 循环顶部 abort 检查 + catch 分支 AbortError 让路(`isAbortError` 直接上抛,不重试、不进反应式压缩)。
- `src/utils/errors.ts`:`isAbortError`。
- `src/providers/*.ts`:stream 第二参透传 `signal`(anthropic / openai / ollama 三适配器)。
- `src/services/agents/team/registry.ts`:`send` / `stop` / `poll` / `isAborted` 完整实现;awaitAll 处理 stopped/failed。
- `src/tools/send_message.ts`(新)、`src/tools/task_stop.ts`(新)。
- `src/cli/index.ts`:readOnlyNames 加 `send_message` / `task_stop`;buildTools 装配两工具。
- `src/cli/repl.ts`:`/tasks` 增强(status 含 stopped)。

**测试**:决策 C2/C3 全量用例(慢响应 mock 测送达时序;abort 传播 mock)。

**验收**:mock 下协调者派后台任务 → SendMessage 补充需求 → 子 agent 下一轮收到新 user 轮并按其续跑;TaskStop 后任务标记 stopped、部分结果保留、轮末注入 `[已停止]`;已结束任务 SendMessage 回填状态提示;AbortError 不重试。

### M3 — agent 类型 + frontmatter + coordinator(决策 B/C1/C5,0.7.0)

**文件**:

- `src/services/agents/loader.ts`(新):扫描 + frontmatter 解析 + Trust 门控。
- `src/services/agents/registry.ts`(新):`AgentRegistry`(内置 + 自定义合并;工具集 / base system / maxIterations / 默认 model 解析;内置三型工具集默认不含三件套)。
- `src/tools/agent.ts`:`agent` 工具按 registry 解析类型。
- `src/core/context.ts`:`SystemContext.coordinator?`;`buildSystemPrompt` 注入协调者段落。
- `src/cli/index.ts`:`--coordinator` flag;三件套只装配主 agent 工具池。

**测试**:决策 B/C1/C5 全量用例。

**验收**:`.run-agent/agents/qa.md` 自定义类型(带 tools + body),`agent` 工具 `agentType=qa` 调起且子 system 含 body、工具集不含三件套;`--coordinator` 下 system 含协调者段落、`--bare` 不注入;子 agent 工具池不含三件套。

### M4 — 0.7.0 发布

- 文档:`docs/agents.md`(内置类型 / 自定义 frontmatter / 权限继承 / run_in_background 语义 / SendMessage + TaskStop 用法 / coordinator / 三件套只装配主 agent);`docs/usage.md` 补 `/tasks`;`CHANGELOG.md [0.7.0]`;`package.json` 0.7.0;README 补「多 Agent」特性。
- `CLAUDE.md`:工具数(13 → 16:agent/send_message/task_stop 条件装配 + skill 为 13 内置之一)、架构段、测试用例数。
- CI 三 OS × Node 20/22/24 全绿;tag `v0.7.0` → push → `npm pack` 检查 → `npm publish --access=public` → `npm view` 验证(复用 0.6.0 流程)。

### M5 — verification 子 agent(决策 D,0.7.1)

**文件**:

- `src/services/agents/builtin/verification.ts`(新):类型定义 + 权限策略 + 子 system(策略 / 反合理化 / 探针 / 证据契约)+ VERDICT 解析器。
- `src/services/agents/registry.ts`:内置注册 verification。

**测试**:决策 D 全量用例。

**验收**:mock 下非平凡改动任务末尾主 agent 被指引 spawn verification;verification 跑 safe bash 不弹窗、拒项目写、/tmp 可写;输出含 `Command run:` + `VERDICT:` 字面量;缺命令证据的 PASS 被拒。

### M6 — 后台记忆提取双轨(决策 E,0.7.1)

**文件**:

- `src/services/extract/extract.ts`(新):游标 + hasMemoryWritesSince + trigger + 开关。
- `src/services/agents/builtin/extractMemories.ts`(新):类型定义 + 提取 prompt + 权限策略(remember allow)。
- `src/cli/repl.ts`:runTurn 轮末触发(仅 Trust + 非 bare + 非 headless);独立执行路径,不入 task registry。

**测试**:决策 E 全量用例(沙箱环境)。

**验收**:真实会话跑两轮,第二轮提取子 agent 只分析新消息;主 agent remember 后跳过;增量太少跳过;记忆落 `.run-agent/memory/` 且索引更新。

### M7 — 0.7.1 发布

- 文档:`docs/memory.md` 补双轨;`CHANGELOG.md [0.7.1]`;`package.json` 0.7.1;tag `v0.7.1`;CI;`npm publish`(沿用流程)。

---

## §3 DoD 验收清单

- [x] `agent` 工具:foreground 回填结论 / background 立即返回可寻址占位 + 轮末自动汇总;`model` 覆盖工厂;未知类型报错(`tests/tools/agent.test.ts`)
- [x] runAgent 独立上下文 + 独立 transcript 落盘;子 agent 工具集默认不含 agent/SendMessage/TaskStop(防递归)(`tests/core/v7.test.ts` + registry)
- [x] 权限:子 agent 权限不高于父级;background ask→deny(降级 deny 不执行);内置 deny 硬底线不破;三件套归只读;`readOnlyNames` 含三件套(team registry 单测 + CLI 装配核验)
- [x] 内置三型 + 自定义 frontmatter(Trust 门控 / tools 过滤 / body 进子 system);同名内置优先;跨会话持久化(`tests/services/agents/loader.test.ts`)
- [x] `--coordinator` 注入协调者段落、`--bare` 不注入;2 个后台 specialist 并行汇总正确(`tests/core/context.test.ts` + team registry 双任务测试)
- [x] `SendMessage`:running 任务注入、poll 迭代边界原子取空送达、已结束回填状态提示(team registry 单测)
- [x] `TaskStop`:abort 传播、AbortError 不重试直接上抛、stopped 保留部分结果、幂等(team registry + v7 单测)
- [x] `/tasks` 命令列出后台任务状态(`src/cli/repl.ts` 装配核验 + `BackgroundTaskManager.list` 单测)
- [x] 0.7.0 发布:docs/agents.md / CHANGELOG / 版本 / CI 3 OS × Node 20/22/24 / tag / npm pack / publish / npm view(发布)
- [ ] verification 子 agent:工具集无写工具;safe bash allow、项目写 deny、/tmp 放行、危险命令 deny;策略 + 反合理化 + 探针进 system(单测)
- [ ] verification 输出契约:每条 check 有 `Command run:`;缺证据的 PASS 被拒;`VERDICT: PASS/FAIL/PARTIAL` 字面量解析(单测)
- [ ] 后台记忆提取:触发条件(Trust + 非 bare + 完整轮);游标增量;增量太少跳过;hasMemoryWritesSince 互斥;remember 写成功;失败不推进游标不抛;maxIterations 5(单测)
- [ ] 0.7.1 发布:docs/memory.md 双轨 / CHANGELOG / 版本 / CI / tag / npm pack / publish / npm view(发布)
- [ ] **真实模型手动验证(需 key)**:跨模块任务由 2 个 specialist 分工且汇总正确;协调者 SendMessage 补充需求后子 agent 按新指令续跑、TaskStop 能止损;非平凡改动后 verification 出具带证据的 VERDICT;跑两轮对话后 `.run-agent/memory/` 出现后台提取的记忆(低成本模型下)

## §4 风险与注意

1. **后台任务生命周期与竞态**:fire-and-forget 子查询 + 主循环并发 + SendMessage/TaskStop 介入。缓解:task registry 单线程事件循环内无竞态(send/poll 原子);轮末 `awaitAll` 统一收集、结果以新 user 轮注入(不并发写主消息数组);失败吞掉;`maxIterations` 封顶;transcript 独立文件避免与主会话 JSONL 竞态。
2. **消息注入时序**:SendMessage 到达时子 agent 可能已结束。缓解:send 对非 running 任务回填状态 + reply 摘要,模型据此重新委派;注入在迭代边界原子送达,不破坏 tool 配对。
3. **abort 正确性**:AbortError 若被重试框架吞掉会「停止失败」;若进反应式压缩会「停止后还重跑」。缓解:`isAbortError` 在 catch 最前直接上抛;循环顶部也检查 aborted;测试锁死 abort 后不再发 stream。
4. **权限提升边界**:子 agent 是父级权限的「缩小器」——工具集子集 + 继承 checkPermission + background ask→deny + 三件套只装配主 agent。缓解:内置 deny 硬底线在子查询同样生效;文档写明「子 agent 权限不高于父级、worker 无协调权」;测试锁死。
5. **model 覆盖工厂**:错误实现可能让子查询用错 provider/key。缓解:工厂由 CLI 从 `createClient(cfg.provider, {apiKey, baseURL})` 构造,只换 model;测试注入 fake 工厂断言。
6. **记忆提取成本与噪音**:每轮一次额外 LLM 调用,可能写垃圾。缓解:低成本模型 + 游标增量 + 互斥跳过 + 增量太少跳过 + `NOT_TO_SAVE_GUIDANCE` + 「先查现有记忆再更新」 + maxIterations 5 + 失败静默 + 关闭开关 env;提取 agent 只读 + remember 门控(Trust),防提示注入。
7. **无限嵌套递归**:general-purpose 含 agent 会自指。缓解:子 agent 工具集**默认不含 agent/SendMessage/TaskStop**;显式 frontmatter 才开;各层 maxIterations 封顶。
8. **verification run_bash 安全面**:子 agent 有 run_bash。缓解:专门权限策略(safe 分类 allow / 项目写 deny / /tmp 放行 / 危险命令硬底线 deny);工具集无 write/edit;子 system 只许检查命令。
9. **平台坑(沿用)**:macOS `/var→/private/var` 已修(V6-3),agent/提取测试的临时路径一律 `realpathSync` 归一;Windows PowerShell 路径、`process.exitCode` + 自然退出纪律沿用;subagent transcript 长文件名在 Windows 注意。
10. **headless 契约稳定性**:agent/send_message/task_stop 调用进 tools 轨迹是**新增**工具名,不破坏既有字段;后台汇总走新 user 消息,不改 JSON 结构——契约向后兼容,但文档注明 `tools` 可能出现这三个名字。
11. **工程纪律**:`exactOptionalPropertyTypes` 条件 spread、`verbatimModuleSyntax` `import type`、zod v4、BOM 剥离、hermetic 测试(沙箱 USERPROFILE/HOME)——沿用 V2–V6。
12. **发布纪律**(沿用):CI 全绿再 publish;`npm pack` 检查无源码泄漏;bump 后本地重跑全量测试(0.4.0 教训)。

## §5 交接(V6 → V7 → V8)

**V6 → V7 依赖**:

- 0.4.1 explore 子 agent(嵌套 runQuery + 只读集 + 权限继承)是 `agent` 工具的内核,本版泛化、explore 保留别名。
- V6 的 `readOnlyNames` 闭包 / `makeCheckPermission` / 权限管线复用(三件套归只读、background ask→deny);headless JSON 契约扩展点(V6 §5 交接点「V7 的 run_in_background 在 tools 轨迹加字段即可向后兼容」)在此兑现。
- V4 的 remember + memory 模块(游标无关的写入原语)被提取子 agent 复用;`NOT_TO_SAVE_GUIDANCE` 直接进提取 system。
- V6 的 hooks / skills / commands 基建不涉及;agent 工具走既有权限与工具池装配。

**V7 → V8(生态)**:

- **跨会话常驻团队**:本版 task registry 是 session 级、后台任务跑完即回收。V8 若做常驻 teammate + 消息泵,`BackgroundTaskManager` 可升级为团队注册表(可寻址、跨轮存活),后台子 agent 从「轮末收集」演进为「常驻 + 团队 transcript 合并」;`/tasks` 文本列表让位 TUI 进程树。
- **TeamWait / 主动 await / 团队级 transcript**:V7 只做点名三件套 + 轮末收集;V8 按需补。
- **子 agent 进程树 / 进度 UI**:V7 REPL 只有 `/tasks`;V8 TUI(Ink)承载。
- **更多 hook 事件**(SubagentStop / PreCompact / Notification):SubagentStop 可接 V7 后台任务完成点。
- **verify 工具 → 子 agent 化**:verification 子 agent 已覆盖,V8 可视需把 verify 工具并入。
- **记忆检索升级**:后台提取 + 现有关键词索引已够,V8 再评估向量检索。
- **评测(SWE-bench 子集)**:多 agent 分工是评测价值的放大器,V8 公布基线时带上。
