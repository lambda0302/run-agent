# Plan V4 — 代码理解 + 主动记忆(0.4.0 + 0.4.1)

> 上游总计划:`docs/Plan.md` §五 V4(代码理解 + 主动记忆,2~~3 周,交付 `0.4.0`)。
> 上一版本交接:`docs/Plan_V3.md` §7/§8.7(compact 链路完整;`collectClaudeFiles` 四级结构、`--bare`/Trust 门控语义可扩展为记忆索引)。
> 本版本一句话:大型仓库里"定位要改的文件"更准,跨会话"记得住教训"——定位准 + 学得进。
> 工期参考:0.4.0(主动记忆)≈ 1 周;0.4.1(代码理解)≈ 1~~2 周,单独发版。

## §0 结论速览

**交付什么(0.4.0 — 主动记忆)**:

- **项目记忆 = Claude Code 式「独立文件 + MEMORY.md 索引」**(本版核心架构决策,§1 决策 A/B):`<cwd>/.run-agent/memory/` 下,**每条记忆一个独立 `.md` 文件**,frontmatter 三字段 `name` / `description` / `type`(user|feedback|project|reference),正文为记忆内容;**`MEMORY.md` 是索引页**(每行 `- [Title](file.md) — one-line hook`,上限 200 行 / 25KB),**常驻 system 稳定段**注入。模型启动即见索引 → 判断相关 → 用 `read_file` / `grep` **按需读完整记忆**。
- **写 = 专属 `remember`,读 = 窄化豁免**(决策 A):写仍只有 `remember` 一条通道(Trust + 权限引擎双门控,`scope` 默认 `"project"`,内部完成"写 topic 文件 + 更新 MEMORY.md 索引"两步);为让模型按需读记忆,**`read_file` / `glob` / `grep` 三个只读工具对 `.run-agent/memory/**` 放行(仅 Trust 会话)**,其余 `.run-agent` 内容(`CLAUDE.md` / `permissions.json`)与 `write_file` / `edit_file` / `run_bash` 依然全禁——这是 0.3.2「完全只读」收口的**唯一、有意的放宽**,仿 Claude Code 的 `isAutoMemPath` 豁免。
- **写入范围收敛**:agent **主动沉淀的记忆只写项目级**;**用户级记忆(`~/.config/run-agent/CLAUDE.md`)只在用户明确要求「更新用户记忆」时才写**——agent 不会自作主张改用户级记忆(决策 A 的用户级门控)。0.3.2 的"remember 写用户级"在 0.4.0 收紧为"默认写项目级"。
- **记忆内容规范(借鉴 Claude Code)**:frontmatter 的 `type` 四选一(`user / feedback / project / reference`),并明确「不存什么」——不记代码结构与 git 历史(源码已表达)、不记一次性调试方案、不记已写进 CLAUDE.md 的约定(决策 B)。
- **生命周期**:`run-agent memory` 子命令——`list [query]` / `show <name>` / `rm <name>` / `prune [--days N]`(索引可查、全文可看、可删、可过期)。
- **检索零依赖**:不做关键词倒排 + top-K 注入(此前方案),靠"索引常驻 + 模型按需 grep/read"——与 Claude Code 一致,省掉倒排索引与每轮检索注入。

**交付什么(0.4.1 — 代码理解)**:

- **`repo_map` 工具**(简单版,不用 tree-sitter):`git ls-files` 列候选 → 两遍排序(先文件名/路径段命中,再只对 top-N 做符号扫描)→ 按 token 预算返回候选文件 + 匹配符号行。零新依赖,10k+ 文件仓库里 1-2 步定位。
- **`explore` 只读探索子 agent**:用只读工具集(read/glob/grep/repo_map)跑一个嵌套 `runQuery`,返回结论回填 `tool_result`——为 V7 多 agent 铺路。
- **`verify` 诊断工具**(LSP 的保底路径):对改动文件跑项目脚本(`tsc --noEmit` / `npm test` / `npx eslint` 单文件),把 lint/编译错误读回给模型自修。完整 LSP 客户端标记为**加分项**(跨平台风险高),不在验收红线。

**技术栈增量**:零新运行时依赖(继续用 `@anthropic-ai/sdk`/`commander`/`openai`/`zod`;repo map 走 `node:child_process`+fs+正则;记忆检索靠"索引常驻 + 模型按需 grep/read",无倒排索引)。

**不做的事(留待后续)**:

- 完整 LSP 客户端 / tree-sitter / 向量语义检索 / 关键词倒排注入 → 后续(本版用 verify 保底 + 索引 + 按需读)。
- session 切换 UI / 方向键 select 菜单 → V8(`docs/select-ui-plan.md` 已获批未实现)。
- 会话持久化 P0(按 cwd 分目录 + `0o600`)→ 用户已明确"这些先不做,后续我会再让你做",不进 V4。

---

## §1 架构决策

### 决策 A:写入 = 专属 `remember` 通道;读 = 窄化豁免(`.run-agent/memory/**`)(本版核心)

**冲突**:Claude Code 式记忆机制要求 agent **能读**记忆文件(MEMORY.md 索引 + 按需读 topic 文件);而 0.3.2 把 `.run-agent` 对 agent 收口为**完全只读**(路径工具 deny + `run_bash` 命令文本 `AGENT_DIR_BASH_RE`)。若不改,agent 既写不进也读不出项目记忆。

**写通道——沿用专属 `remember`(决策 A 原方案)**。`deniedByDefault(tool, input)` 只检查工具**入参里的路径字段**(`inputPath()` 取 `file_path`/`path`/`cwd`),`remember` 的入参是 `{ content, scope, ... }` **没有路径字段** → 天然不触发路径 deny;`AGENT_DIR_BASH_RE` 只管 `run_bash` 命令文本。所以专属写入工具可以在不改引擎的前提下写 `.run-agent/memory/`,前提是:

1. **写目标由工具内部计算,不接受入参路径**(防任意写):`scope="project"` → `path.join(cwd, ".run-agent", "memory")`,cwd 由 CLI 工厂注入;`scope="user"` → `userClaudeFilePath(homeDir)`(0.3.2 现状,仍是单文件 CLAUDE.md,不进记忆目录)。
2. **Trust 门控**:`scope="project"` 要求 `isTrusted`(工厂注入);未信任项目 → 返回"项目未受信任,无法写入项目记忆"。
3. **写入范围门控(本版收紧)**:`scope` **默认 `"project"`**——agent **主动沉淀只写项目级**;**用户级(`scope="user"`)仅在用户明确要求「更新用户记忆」时才写**,由 system prompt 指引 + 工具描述约束(见决策 B 的内容规范),不做技术强制——用户明确要求时理应当场放行,但**默认路径绝不写用户级**。
4. **权限引擎门控**:`remember` 本就是写类工具——default 下 ask、`acceptEdits` 下 allow、`bypass` 无条件、用户规则可 deny(现有行为,不改;`scope="user"` 的调用同样可见可拒)。
5. **守卫复用**:自动去重(按 name 命中先更新,不重复建文件)+ 大小上限(topic 文件 `MAX_MEMORY_FILE_BYTES = 16KB`;索引 `MEMORY.md` 上限 200 行 / 25KB,超限拒写或告警)。

**读豁免——唯一的、有意的放宽**(0.3.2「完全只读」在此处松开一角):

- 放行:`read_file` / `glob` / `grep` 三个只读工具,目标路径在 `.run-agent/memory/**` 下且会话为 **Trust** → 允许(内置 deny 跳过)。
- 仍全禁:`write_file` / `edit_file` 对 `.run-agent/**`(写只能走 `remember`);`run_bash` 命令文本含 `.run-agent` 段(`AGENT_DIR_BASH_RE`,V3-2 修复)不变——模型读记忆用 `read_file`/`grep` 工具即可,无需 shell;`.run-agent/CLAUDE.md`、`.run-agent/permissions.json` 等非 memory 路径不在此豁免内,依旧 deny。
- 未 Trust 项目:豁免不生效,`.run-agent/memory/` 对 agent 完全不可见(与 V3 的 project CLAUDE.md 注入同款 Trust 门控)。
- 实现:引擎 `deniedByDefault` 增 `isMemoryReadExempt(tool, path)` 判定(路径段精确匹配 `.run-agent` + `memory`,只对只读工具生效),`isTrusted` 由 PermissionContext 注入(引擎已有 Trust 信息)。

**结果**:

- 写:唯一入口 `remember`(权限 + Trust 双门控,`scope="user"` 另受"用户明确要求"约束);模型无法用 `write_file`/`edit_file`/`run_bash` 触碰 `.run-agent` 任何内容。
- 读:模型**可**用 `read_file`/`grep` 读 `.run-agent/memory/**`(Trust 会话)——这正是 Claude Code 式"索引 → 按需读全文"的前提;非 memory 的 `.run-agent` 内容依旧读不到。
- 注入:system 稳定段常驻 MEMORY.md 索引(决策 B),CLI 直读 fs,不经工具。

**自注入风险与缓解**(模型写的记忆会影响未来会话):① 写入口走权限引擎,default 必问;② 记忆索引只在项目受信任时注入、读豁免只在 Trust 会话生效;③ 用户随时可手动编辑/删除 `.run-agent/memory/`;④ 记忆内容按 `name` 去重 + 上限 + `prune` 可过期;⑤ 工具只写结构化 topic 文件 + 索引,不接受任意路径。残留风险(受信任项目内,模型自己记住的"约定"可能夹带私货)属可接受范围,文档注明——与 Claude Code 的 `MEMORY_DRIFT_CAVEAT` 一致,读到的记忆要先对照现状验证。

- **与 Claude Code 的差异(双轨取舍,2026-08-11 定)**:0.4.0 只做**单轨**——模型驱动的 `remember`,零额外 LLM 调用。Claude Code 的「每轮结束后台提取兜底」(`extractMemories`:fork 主对话 + 有限 turn 预算 + 主 agent 写过则跳过)**留到 V7**——它需要 `Agent` 工具的后台子 agent 基建,且每 user turn 产生一次额外 LLM 调用。V7 目标已加进 `docs/Plan.md` V7 核心功能 #4。
- **实施指引(2026-08-11 定,防 V4.5 白做)**:① `isMemoryReadExempt` 按 V4.5 最终形态写成**独立纯函数**——签名 `(tool, path, isTrusted)`,不在 `deniedByDefault` 内联逻辑、显式收 `isTrusted` 参数;0.4.2 移入专属通道(决策 C/D)时纯移动,不重写。② **(可选)提前实现 V4.5 决策 F 的一行**:`glob.ts`/`grep.ts` 的 `ALWAYS_IGNORE` 加 `.run-agent`——让 0.4.0 的读豁免"未 Trust 记忆不可见"保证立刻完整,省掉 0.4.2 的部分工作与 `docs/memory.md` 的依赖标注义务。

```ts
// src/tools/remember.ts 扩展(0.4.0)
const schema = z.object({
  content: z.string().min(1).describe("The fact, preference, or lesson to remember"),
  scope: z
    .enum(["project", "user"])
    .optional()
    .describe(
      "Where to persist. Default 'project': the current project's memory " +
        "(.run-agent/memory/, one file per memory + MEMORY.md index) — use this for your " +
        "own cross-session learning. 'user': ~/.config/run-agent/CLAUDE.md — ONLY when the " +
        "user explicitly asks you to update their user-level memory; never proactively.",
    ),
  type: z
    .enum(["user", "feedback", "project", "reference"])
    .optional()
    .describe("Memory type for frontmatter (see memory content spec)"),
  name: z
    .string()
    .optional()
    .describe(
      "Filename slug (kebab-case, e.g. 'feedback_testing'). Auto-derived from content if omitted",
    ),
  description: z
    .string()
    .optional()
    .describe(
      "One-line relevance description for frontmatter + index hook. Auto-derived if omitted",
    ),
});
// scope 默认 "project":agent 主动沉淀只写项目级;user 级仅在用户明确要求时写
export function makeRememberTool(opts: {
  homeDir?: string; // scope="user" 时写用户级 CLAUDE.md 需要
  cwd?: string; // scope="project" 时需要
  isTrusted?: boolean; // scope="project" 时 Trust 门控
}): Tool;
```

### 决策 B:记忆读取 = MEMORY.md 索引常驻 system + 模型按需 read/grep(与 Claude Code 一致)

**存储布局**(`.run-agent/memory/`):

```
.run-agent/memory/
├── MEMORY.md                      # 索引页,常驻 system;每行一条,无 frontmatter
│   - [Feedback: 测试入口](feedback_testing.md) — npm test 是唯一测试入口
│   - [用户工作方式](user_workspace.md) — Windows + 中文 + prettier
├── feedback_testing.md            # 独立记忆文件,frontmatter + 正文
└── user_workspace.md
```

**文件格式**(topic 文件):

```markdown
---
name: feedback_testing
description: 测试入口约定——npm test 是唯一入口,改 src/ 后先 build 再 vitest run 验证
type: feedback
---

npm test 是唯一测试入口;改完 src/ 后先 build 再 vitest run 验证。

**Why:** 混用测试命令曾导致漏跑用例。
**How to apply:** 改动后先 `npm run build` 再 `npx vitest run <file>`。
```

- `name` 唯一(文件名 slug);`description` 是**判断相关性的依据**(Claude Code 语义: "used to decide relevance in future conversations");`type` 四选一。

**MEMORY.md 索引**(`ENTRYPOINT_NAME = "MEMORY.md"`):

- 每行 `- [Title](file.md) — one-line hook`,无 frontmatter,是索引不是记忆本身。
- **上限**:200 行 / 25KB(仿 Claude Code),超限截断并在尾部附警告行;`remember` 写入时若将超限 → 拒写并提示先 `prune`。
- **注入**:system 稳定段,`collectClaudeFiles` 之后拼一个 `## MEMORY.md` 块(CLI 直读 fs + 截断,零依赖);**仅 Trust 会话注入**,`--bare` 时禁用。索引在会话内静态,只在 `remember` 写入后下次重建 system 时更新(REPL 每轮本就重建 system,无额外成本)。

**读取流程**(与 Claude Code 完全同构):

1. 模型启动即见索引 → 拿当前 user 消息对照各条 hook 判断相关性(`WHEN_TO_ACCESS`:相关、跨会话续接、用户重提旧话题时)。
2. 相关 → `read_file` 读 `file.md` 全文(frontmatter 的 description/type + 正文);不确定 → `grep` 记忆目录(`path=<memoryDir> glob="*.md"`)兜底。
3. **记忆漂移提醒**:读到的记忆是快照,可能过时——`WHEN_TO_ACCESS` 附"对照当前代码/用户最新指示验证,冲突以现状为准,并更新或删除旧记忆"(仿 Claude Code `MEMORY_DRIFT_CAVEAT`)。

**条目内容规范(借鉴 Claude Code 的 memory 约定,`docs/memory.md` 全文收录)**:

- **条目类型**(frontmatter `type`,对应「记什么」):
  - `user` — 用户的身份、偏好、工作方式(如"用户用 Windows、偏好中文回复、要 prettier 格式化")。**这是内容分类,不代表写入位置**——run-agent 主动沉淀仍落 `.run-agent/memory/`(决策 A),并非写用户级 CLAUDE.md。
  - `feedback` — 用户纠正/确认过的工作方式,正文结构"规则 → **Why:** → **How to apply:**"(记录失败也要记录确认过的成功做法,防过度保守)。
  - `project` — 当前项目的目标、约束、跨会话事实(不能直接从代码/git 看出的,如"会话切换推迟到 V8");存相对日期时转绝对日期。
  - `reference` — 外部资源指针(URL、文档、ticket、远端仓库)。
- **不存什么(WHAT_NOT_TO_SAVE)**:① 代码结构/实现细节——源码、README、git 历史里都有,存了必过时;② 一次性调试过程与排查方案(已解决的 bug 记进 `docs/Bug_V*.md`,不占记忆);③ 已在 CLAUDE.md / system prompt 里写明的约定(重复存会漂移);④ 会话琐事(一次性对话、临时上下文)。**用户明确要求保存清单/摘要类内容时,追问"有什么反直觉/非显而易见的部分"再存。**
- **何时读(WHEN_TO_ACCESS)**:相关、跨会话续接、用户重提旧话题、或用户明确要求"查记忆/记住";用户说"忽略记忆" → 当 MEMORY.md 为空处理,不提、不引用、不对比。

### 决策 C:生命周期 = `run-agent memory` 子命令(用户直接调用,不经权限引擎)

- `run-agent memory list [query]` — 列出索引条目(带关键词过滤,扫 title + hook + description)。
- `run-agent memory show <name>` — 打印单条完整记忆(frontmatter + 正文)。
- `run-agent memory rm <name>` — 删除 topic 文件 + 摘除对应索引行。
- `run-agent memory prune [--days N]` — 删除早于 N 天(默认 30)的 topic 文件 + 摘除索引行。
- 目标目录与决策 A 相同:`<cwd>/.run-agent/memory/`;目录/索引不存在 → 空列表。属 CLI 直读直写(用户发起的维护操作,不走工具权限管线),沿用 `trust` 子命令的实现风格(`src/cli/index.ts` commander 子命令)。

### 决策 D:`repo_map` = 简单版(git 索引 + 符号表),不用 tree-sitter

Plan.md 允许"可用简单版替代(git 索引 + 符号表)"。**对 tree-sitter 的立场与 V4.5 一致:可实现,但暂时没必要。** 原生 binding 有跨平台编译风险;纯 TS 重实现可行但工程量大(Claude Code 用 4436 行纯 TS 重实现 tree-sitter-bash + WASM golden 对拍验证,见 `docs/Plan_V4.5.md` 决策 E 4b)——repo_map 只需要"定位",符号 regex 已够,完整解析不进 V4。

- **工具签名**:

```ts
// src/tools/repo_map.ts
const schema = z.object({
  query: z.string().min(1).describe("Symbol or filename keyword to locate in the repository"),
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(32768)
    .optional()
    .describe("Result cap in bytes (default 4096)"),
});
```

- **两遍排序**(10k+ 文件不全量符号扫描):
  1. `git ls-files`(缓存,keyed by cwd + HEAD sha + TTL)→ 过滤(node_modules/.git/dist/coverage/.run-agent/.claude、二进制、>1MB)→ 按文件名含查询词 > 路径段含 > 其他 打分,取 top-N(默认 30)。
  2. 只对 top-N 做符号扫描(per-extension 轻量正则:ts/js → `^(export )?(async )?(function|class|interface|type|const|enum) \w+`;py → `^(class |def |async def )`;go → `^(func |type .* struct|type .* interface)`),输出"文件 + 匹配符号行"。
- **返回**:按 token 预算 `maxBytes` 截断,缺省 4KB——模型看到"候选文件 + 关键符号",再自己 `read_file` 精读。
- **权限**:只读工具(`isConcurrencySafe: true`,免确认),走内置 deny(不会扫到 `.git`/`.run-agent`)。
- **失败兜底**:非 git 仓库 → 退化为 `readdir` 递归列文件(上限 5000);git 缺失/超时 → 返回空+提示。

**强度评估(2026-08-11):不为"改 bug"加强,维持简单版。** 定位 vs 改码的边界——repo_map 只负责"指路",理解代码靠模型 `read_file` 精读;改 bug 的瓶颈在 `verify` 闭环(改完能验证)与 `explore` 多文件推理,不在符号定位精度。且 bug 输入(测试失败/报错/用户描述)通常自带 `file:line` 或符号名,文件名/路径段匹配已够用。强化项(调用图、CST 级理解)解决的是"大仓库跨文件重构"这类需求,杠杆是 `explore` 子 agent,不是 repo_map 精度。**加强与否由真机验证定夺**(§8.5 DoD 最后一条:真实模型大仓库定位 + 改 + verify 自修)。若验证后定位确实偏,零依赖档位依次:① 符号 regex 按语言扩覆盖;② 多词查询(文件名+符号组合);③ 把"引用某符号"做成 grep 后备喂 explore(零依赖模拟部分调用图)。仍不够才评估 tree-sitter 纯 TS 路线(见 V4.5 决策 E 4b,独立版本)。

### 决策 E:`explore` = 只读探索子 agent(为 V7 铺路)

```ts
// src/tools/explore.ts
const schema = z.object({
  prompt: z
    .string()
    .min(1)
    .describe(
      "Read-only exploration task for the sub-agent (e.g. 'find where X is handled and how')",
    ),
  thoroughness: z
    .enum(["quick", "medium", "very thorough"])
    .optional()
    .describe("Search depth (default 'medium')"),
});
export function makeExploreTool(deps: {
  client: LLMClient;
  system?: string;
  contextWindow?: number;
  checkPermission?: (tool: Tool, input: unknown) => Promise<Decision>;
}): Tool;
```

- 内部跑一个**嵌套 `runQuery`**:`initial = [{role:"user", content: prompt}]`,工具集 = 只读子集(read/glob/grep/repo_map,**不含** write/edit/bash/remember),系统复用主 system(含 MEMORY.md 索引)。`read`/`grep` 随主会话的读豁免也可访问 `.run-agent/memory/**`(Trust 会话),子 agent 同样能按需读记忆。
- **`thoroughness` 参数**(学 Claude Code `EXPLORE_AGENT` 的调用方深度声明):`"quick" | "medium" | "very thorough"`(缺省 medium)→ 映射 `maxIterations`(quick=4 / medium=8 / very thorough=12)并写入 prompt 指引,调用方按需求声明深度,不再一律 8 轮。
- 返回:子 agent 的最终 `reply` 作为 `tool_result` 回填。
- 嵌套 `runQuery` 复用 V3 的 compact(带 contextWindow 时超长自动压缩)——子 agent 上下文独立,不污染主会话。
- `isConcurrencySafe: false`(昂贵、串行)。权限:继承父级;工具集本身只读,default 下免确认。
- **与 V7 的关系**:V7 把它泛化为 `Agent` 工具(subagent_type / model / run_in_background / 独立 transcript);**后台运行与模型选择留到 V7**——嵌套 `runQuery` 是同步阻塞,做不了真后台,`Agent` 工具(独立 transcript + run_in_background)才能;本版只做 read-only 一种 + thoroughness,够探索定位用。

### 决策 F:诊断 = `verify` 工具保底,完整 LSP 是加分项

- **`verify` 工具**(0.4.1 必做,保底):对指定文件跑项目脚本——

```ts
// src/tools/verify.ts
const schema = z.object({
  file: z.string().describe("The changed file to check"),
  command: z
    .string()
    .optional()
    .describe("Override command template (default per detected toolchain)"),
});
```

- 按仓库识别 toolchain:有 `tsconfig.json` → `npx tsc --noEmit`(整仓,或 `--incremental` 加速);有 eslint 配置 → `npx eslint <file>`;有 `package.json` scripts.test → `npm test -- --run` 相关子命令。默认走 `npx <tool> …`,超时 120s、输出 30k 截断(复用 bash 工具约束)。
- 本质是"把 lint/编译错误读回来",满足 DoD"改动后能读回 lint 错误"。
- **定位对齐 Claude Code**:本工具 = Claude Code 的**基线层**(主 agent 指令"报完成前必须实际验证:跑测试/执行脚本/看输出",验证就是模型自己跑 Bash)——把"跑 tsc/eslint/test 读回错误"工程化成一个工具。**升级路径不在本版**:对抗性验证(按类型分策略/反合理化/VERDICT 契约/强制只读)是**子 agent 级**,已列入 `docs/Plan.md` V7「验证专家子 agent」,蓝本 Claude Code `verificationAgent.ts`。
- **加分项(可选,不承诺)**:最小 LSP 客户端(JSON-RPC over stdio,spawn `typescript-language-server`,initialize → didOpen → publishDiagnostics → kill,带超时守卫)。跨平台 spawn/路径/版本 flaky,评估成本后决定;不做也满足验收。

---

## §2 里程碑 M1 — 主动记忆(0.4.0)

**文件**:

- `src/core/memory.ts`(新建):`MEMORY_DIRNAME`/`ENTRYPOINT_NAME("MEMORY.md")`/`MAX_ENTRYPOINT_LINES(200)`/`MAX_ENTRYPOINT_BYTES(25KB)`/`MAX_MEMORY_FILE_BYTES(16KB)`/`MEMORY_TYPES`/`NOT_TO_SAVE_GUIDANCE`(内容规范常量,供 system 指引复用);`memoryDirPath(cwd)`/`topicFilePath(cwd, name)`/`entrypointPath(cwd)`;`parseTopicFile(text)`(frontmatter name/description/type + 正文,剥 BOM);`readIndexLines(dir)`(读 + 截断 200 行/25KB + 超限警告);`buildMemoryIndexBlock(dir, isTrusted)`(格式化 `## MEMORY.md` 注入块);`writeTopicFile`/`appendIndexLine`/`removeIndexLine`/`listMemories`/`removeMemory`(供 `remember` 与 CLI 复用)。
- `src/permissions/engine.ts`:`isMemoryReadExempt(tool, path)`——`read_file`/`glob`/`grep` 且路径段精确匹配 `.run-agent`+`memory` → 放行;在 `deniedByDefault` 内置 deny 前判定,`isTrusted` 由 PermissionContext 传入;其余 `.run-agent` 路径与 `run_bash` 命令文本照旧 deny。
- `src/core/context.ts`:`buildSystemPrompt` 在 `collectClaudeFiles` 后拼 `buildMemoryIndexBlock`(仅 Trust,`--bare` 跳过);**STABLE_SYSTEM 的 remember 指引更新**——主动沉淀用 `remember`(默认写项目级 `.run-agent/memory/`,一步完成写文件+更索引),并附"记忆类型 + 不存什么 + 记忆是快照需验证"摘要;**用户级记忆只在用户明确要求更新时才写**;`SystemContext` 不变。
- `src/tools/remember.ts`:扩展 `scope`/`type`/`name`/`description` + `makeRememberTool(opts)` 工厂(决策 A);**`scope` 默认 `"project"`**,project 分支写 topic 文件(frontmatter + 正文)+ 追加索引行(按 `name` 去重先更新),需 `cwd`/`isTrusted`;`scope="user"` 分支写 `userClaudeFilePath(homeDir)`(0.3.2 行为保留,仅用户明确要求时用)。
- `src/tools.ts`:`makeRememberTool` 需要 cwd/isTrusted——从"模块级常量 `rememberTool`"改为工厂,由 CLI 装配时创建(`TOOLS` 数组改为函数或 CLI 内拼)。
- `src/cli/index.ts`:`run-agent memory` 子命令(list/show/rm/prune,决策 C);`main()` 里用 cwd/isTrusted 装配 remember 工具;one-shot 与 REPL 注入 MEMORY.md 索引块(无需逐轮 query)。
- 测试:`tests/core/memory.test.ts`(frontmatter 解析/索引读写截断/注入块/Trust 门控)、`tests/permissions/engine.test.ts`(memory 读豁免:read_file 放行、write_file 仍 deny、非 memory 路径 deny、未 Trust deny、`run_bash` `.run-agent` 命令照旧拦)、`tests/tools/remember.test.ts`(默认 scope=project 写 topic 文件 + 更新索引、同 name 更新不重复、超限拒绝、未信任拒绝;scope=user 仅用户明确要求时调用、仍写用户级 CLAUDE.md)、`tests/core/context.test.ts`(buildSystemPrompt 含 MEMORY.md 索引块、指引含"主动→项目级")、`tests/cli.test.ts`(memory 子命令冒烟)。

**验收**:

- `remember` **不带 `scope`(默认 project)** 写出的是一组文件:一条记忆一个 `name.md`(frontmatter 三字段 + 正文)+ `MEMORY.md` 索引新增一行;同名再写 → 更新原文件与索引行,不重复建文件;超 16KB / 索引将超 200 行拒写;未信任项目拒绝。
- **主动沉淀只写项目级**:普通会话里 agent 的 `remember` 调用不会触碰用户级 `~/.config/run-agent/CLAUDE.md`;`scope="user"` 仅在用户明确要求时出现(单测断言 + system 指引)。
- **读豁免正确**:Trust 会话内 `read_file`/`grep` 能读 `.run-agent/memory/**`;`write_file`/`edit_file` 对 `.run-agent` 任何路径仍 deny;`read_file` 读 `.run-agent/CLAUDE.md`/`permissions.json` 仍 deny;`run_bash` 命令含 `.run-agent` 段仍拦;未 Trust 会话豁免不生效。
- 启动/每轮 system 稳定段含 `## MEMORY.md` 索引块(截断后);`--bare` 时不含;未 Trust 时不含。
- `run-agent memory list/show/rm/prune` 增删改查生效;rm 同时摘索引行;prune 按天数过期。
- 两次会话间,第二次能经索引判断 → `read_file` 读到第一次沉淀的完整记忆并按它行事(集成测试:mock 写 → 重建 system 含索引 → 模型 Read 命中文件)。

## §3 里程碑 M2 — 代码理解(0.4.1)

**文件**:

- `src/tools/repo_map.ts`(新建):决策 D 全部;`listGitFiles`/`filterCandidates`/`scoreByPath`/`scanSymbols`/`buildRepoMap(query, maxBytes)`;缓存(keyed by cwd+HEAD sha,TTL 60s);非 git 退化为 readdir。
- `src/tools/explore.ts`(新建):决策 E;`makeExploreTool(deps)`;只读工具集 + 嵌套 `runQuery` + `maxIterations:8` + 独立上下文(可压缩)。
- `src/tools/verify.ts`(新建):决策 F;toolchain 识别 + 默认命令 + 超时/截断。
- `src/tools.ts`:注册 `repo_map` / `verify`(静态工具);`explore` 需 client/system/contextWindow → CLI 装配(与 remember 同路径)。
- `src/cli/index.ts`:`main()` 装配 explore(注入 client/system/contextWindow/checkPermission)。
- 测试:`tests/tools/repo_map.test.ts`(临时 git 仓库:候选排序、符号命中、maxBytes 截断、非 git 退化、内置 deny 路径被过滤)、`tests/tools/explore.test.ts`(mock client:嵌套 runQuery 用只读工具、返回 reply、上下文独立)、`tests/tools/verify.test.ts`(mock 子进程输出回填、超时)。

**验收**:

- 临时 10k+ 文件(或同量级 mock)仓库里,`repo_map <符号/文件名>` 1-2 步返回真正要改的候选文件。
- `explore` 只读完成任务并回填结论;过程中不会出现写类工具。
- 改完文件后 `verify` 把编译/lint 错误读回给模型,模型据此自修。

## §4 里程碑 M3 — 0.4.0 发布

**文件**:

- `docs/memory.md`(记忆格式:**独立文件 + frontmatter(name/description/type)+ MEMORY.md 索引**,条目类型 user/feedback/project/reference + 不存什么 + 写入范围约定(主动→项目级、用户级仅用户要求时写)+ 读取流程(索引常驻 → 按需 read/grep)+ `.run-agent/memory/` 读豁免说明 + `run-agent memory` 用法;对应 Plan.md V4 开源交付物)。
- `docs/context-management.md` 补"项目记忆:remember scope=project(默认)/ MEMORY.md 索引注入 / 按需读取 / memory 子命令 / 读豁免"小节。
- `CHANGELOG.md [0.4.0]`;`package.json` version `0.4.0`;README 补特性(主动记忆、`run-agent memory`)。
- `docs/architecture.md` 工具表更新(内置工具 7 → 8,含 remember 扩展)。

**验收**:CI 三 OS × Node 20/22/24 全绿;`npm pack` 干净;tag `v0.4.0`;`npm publish --access=public`(复用 0.2.0 流程与 `~/.npmrc` token)。

## §5 0.4.0 DoD 验收清单

- [ ] `remember` 支持 `scope`(默认 `"project"`)与 `type`/`name`/`description`;project 写 topic 文件(frontmatter + 正文)+ 更新 MEMORY.md 索引;同名更新不重复、16KB/200 行超限拒写、Trust 门控(单测)
- [ ] 主动沉淀不写用户级;`scope="user"` 仅用户明确要求时写(单测 + system 指引)
- [ ] system 指引含「记忆类型 + 不存什么」摘要与漂移提醒;`docs/memory.md` 收录全文(单测/文档)
- [ ] **读豁免**:`read_file`/`grep` 能读 `.run-agent/memory/**`(Trust);`write_file`/`edit_file` 对 `.run-agent` 仍 deny;读 `.run-agent/CLAUDE.md`/`permissions.json` 仍 deny;`run_bash` `.run-agent` 命令仍拦;未 Trust 豁免不生效(引擎单测)
- [ ] MEMORY.md 索引注入 system 稳定段(200 行/25KB 截断);`--bare` 禁用;未 Trust 不注入(单测)
- [ ] `run-agent memory list/show/rm/prune` 生效;rm 摘索引行、prune 按天数过期(单测/CLI 冒烟)
- [ ] 两次会话间,第二次能经索引判断 → `read_file` 读到第一次沉淀的完整记忆并按它行事(集成测试:mock 写 → 重建 system 含索引 → 模型 Read 命中文件)
- [ ] 0.4.0 发布:CHANGELOG / package.json / CI / tag / `npm pack` / npm publish
- [ ] **真实模型手动验证(需 key)**:会话中让模型主动沉淀一条约定到项目级 → 下次会话索引可见、模型读到并按它行事;用户明确要求更新用户记忆时,`scope="user"` 生效

## §6 0.4.0 风险与注意

1. **自注入** → 决策 A 的 5 条缓解;文档明确"受信任项目内模型写入记忆的剩余风险";读到的记忆按漂移提醒先验证再采信(仿 Claude Code `MEMORY_DRIFT_CAVEAT`/`TRUSTING_RECALL`)。
2. **读豁免扩大攻击面** → 豁免严格限定"只读工具 × `.run-agent/memory/**` × Trust 会话"三条件:路径段精确匹配 `.run-agent`+`memory`(不匹配 `.run-agent/CLAUDE.md` 等),`write_file`/`edit_file`/`run_bash` 永不豁免;写仍唯一走 `remember`。引擎单测覆盖正反用例。
3. **`.run-agent` 只读语义被误读** → 文档必须写清"0.3.2 完全只读在 0.4.0 松开 `.run-agent/memory/` 的**只读**一角(仿 Claude Code `isAutoMemPath`);写仍唯一走 remember;其余 `.run-agent` 内容仍全禁",否则外部读者以为安全被破坏。
4. **索引膨胀** → MEMORY.md 上限 200 行 / 25KB + topic 文件 16KB;超限 `remember` 拒写并提示 `prune`;`prune` 按天数过期。
5. **工程纪律**沿用 V3:`exactOptionalPropertyTypes` 条件 spread、`verbatimModuleSyntax` `import type`、zod v4 `instanceof` 窄化、读文件剥 BOM(含 frontmatter 解析前)。
6. **cwd 注入** → `makeRememberTool` 需要 cwd/isTrusted,由 CLI 注入(测试用沙箱注入);不要在模块顶层持有全局 cwd。
7. **relevance 判断全靠模型**(无检索注入兜底) → 与 Claude Code 同构;靠索引 hook 质量(写入时 `description` 要具体)+ 模型 `grep` 记忆目录兜底;若后续发现命中差,再叠加关键词检索(决策 B 的索引格式兼容)。
8. **用户级记忆被误写** → `scope` 默认 project + system 指引明示"用户级仅在用户明确要求时更新";`scope="user"` 走权限引擎(default 必问、`acceptEdits` 下 allow 仍可见可拒),用户始终可拦截。

## §7 0.4.0 → 0.4.1 交接

0.4.0 结束时:记忆写入(remember 专属通道)/ 读取(索引常驻 + 按需 read/grep)/ 生命周期(list/show/rm/prune)闭环,`.run-agent` 收口确立"写全禁、读仅 memory 目录"的边界。0.4.1 的 `repo_map`/`explore`/`verify` 是独立工具,不依赖记忆层;但 `explore` 复用主 system(含 MEMORY.md 索引)且其只读工具随读豁免也能访问记忆——交叉收益:子 agent 探索时也带记忆。0.4.1 的 CLI 装配模式(工厂注入依赖)直接复用 0.4.0 给 `remember` 建立的模式。

---

## §8 版本 0.4.1 —— 代码理解

> 上游:`docs/Plan.md` §五 V4;本文件 §1 决策 D/E/F。
> 本版本一句话:大仓库里定位准、改完能自检。
> 工期:≈ 1~2 周,交付 `0.4.1`。

### 8.1 结论速览

**交付什么**:

- **`repo_map` 工具**:git 索引 + 两遍排序 + 符号扫描,按 token 预算返回候选文件;零新依赖。
- **`explore` 只读探索子 agent**:嵌套 `runQuery` + 只读工具集,独立上下文,结论回填。
- **`verify` 工具**:对改动文件跑 tsc/eslint/test,读回错误自修。
- 完整 LSP 客户端 = 加分项,不做也满足 DoD。

**技术栈增量**:零新依赖。

**不做的事**:tree-sitter(**可实现但暂时没必要**,见决策 D 强度评估,对齐 V4.5 决策 E 4b)/ 向量检索 / 后台子 agent(→ V7)/ 完整 LSP(评估后定)。

### 8.2 架构决策

**决策 8.1:repo_map 两遍排序,绝不全量符号扫描**(10k+ 文件场景的命门)。第一遍按文件名/路径段打分筛 top-N(cheap,`git ls-files` 一次);第二遍只对 top-N 做符号正则扫描。`git ls-files` 结果按 `(cwd, HEAD sha)` 缓存 60s,避免每轮重复 spawn。

**决策 8.2:explore 上下文独立但复用主 system**。嵌套 `runQuery` 的 `initial` 只有一条 user(prompt),system 复用主 system(含记忆),contextWindow 传入 → 子 agent 自身超长可自动压缩,不污染主会话。工具集硬编码只读五件套,不信任任何调用方参数。

**决策 8.3:verify 的 toolchain 识别**,按优先级:eslint 配置 > `tsconfig.json` → `tsc --noEmit` > scripts.test;`command` 可覆盖。统一 120s 超时 + 30k 截断(与 bash 工具同一约束常量)。

### 8.3 里程碑 M2(§3)验收细化

- repo_map:符号精确命中 > 文件名命中 > 路径段命中;maxBytes 截断;`.git`/`.run-agent`/node_modules 永不进入候选。
- explore:mock client 断言子查询工具集只含只读工具;reply 回填;超长子查询触发压缩(不炸主会话)。
- verify:mock 子进程返回错误文本 → 工具结果含该错误;超时返回超时提示。

### 8.4 里程碑 M3' — 0.4.1 发布

`docs/architecture.md`(工具表 8 → 10);`CHANGELOG [0.4.1]`;`package.json 0.4.1`;README 补 repo_map/explore/verify;CI 绿;tag `v0.4.1`;发布。`docs/Bug_V4.md` 建立(如有)。

### 8.5 0.4.1 DoD 验收清单

- [ ] repo_map 在临时大仓库(或同量级 mock)1-2 步定位目标文件;符号/文件名/路径段三种命中排序正确(单测)
- [ ] repo_map 对 `.git`/`.run-agent`/node_modules 永不返回路径;非 git 仓库退化为 readdir(单测)
- [ ] explore 只读完成任务回填结论;断言子查询只含只读工具(单测)
- [ ] verify 读回 tsc/eslint 错误文本;超时兜底(单测)
- [ ] 0.4.1 发布:CHANGELOG / package.json / CI / tag / `npm pack` / npm publish
- [ ] **真实模型手动验证(需 key)**:大仓库里让模型用 repo_map 定位并改一个文件;改完 verify 读到错误并自修

### 8.6 0.4.1 风险与注意

1. **git ls-files 慢** → 缓存 + 过滤后只扫 top-N;极端大仓退化为 readdir 上限。
2. **符号正则误命中** → 只是"候选提示",模型 read_file 精读为准,不追求 100% 准。
3. **explore 递归/死循环** → `maxIterations:8` + 只读工具集(无副作用可安全重试);子查询错误不抛出、转为 tool_result 文本。
4. **verify 命令风险** → 命令模板白名单(仅 tsc/eslint/test 派生),不走任意用户命令;超时强杀。
5. **工程纪律**沿用 V3。

### 8.7 0.4.1 → V5 交接

0.4.1 结束时:`explore` 的嵌套 `runQuery` 模式可泛化为 V7 的 `Agent` 工具(加 subagent_type/model/background);`repo_map` 可喂 V5 的 Plan 模式(只读探索阶段自动带 repo_map);`verify` 可挂 V6 的 Hooks(PostToolUse 自动跑)。会话持久化 P0(P 分目录 + 0o600)仍等用户指示再进 V5+。
