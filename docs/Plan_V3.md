# Plan V3 — 记忆与上下文管理(0.3.0)

> 上游总计划:`docs/Plan.md` §五 V3(记忆与上下文管理,2~3 周,交付 `0.3.0`)。
> 上一版本交接:`docs/Plan_V2.md` §7(权限管线已真实现、重试框架已参数化,供本版 compact 复用)。
> 本版本一句话:跑长任务不爆上下文,跨会话不"失忆"。决定可用性上限。
> 工期参考:0.3.0 ≈ 2 周;0.3.1(reactive compact 兜底)≈ 1 周,单独发版。

## §0 结论速览

**交付什么(0.3.0)**:

- system prompt 动态注入:日期 + git 状态(分支/sha/最近 commit/git user/status),稳定前缀与动态后缀分离(保 prompt cache 前缀)。
- CLAUDE.md 四级项目记忆(managed→user→project→local),自动发现、自动注入、`--bare` 全禁;project/local 级受 Trust 门控。
- compact 核心:零依赖 token 估算 + 自动压缩阈值(contextWindow−13000,钳制小窗口);fork-agent 摘要(`querySource='compact'` 防递归);单边界消息重建 + 已读文件本地重挂;`/compact` 手动命令;`loadSession` 按边界重置点续起。
- **超大工具结果指针化**:超阈值工具结果落盘,消息列表只放指针+预览,模型需要时自己 read_file——便宜层,先于摘要,降低触发频率(决策 8)。
- **REPL 跨轮连续性修复 + `added` 持久化契约**(compact 的地基,顺带修好 V1 遗留的"REPL 跨轮只喂 user 消息"缺口)。

**技术栈增量**:零新依赖。token 估算启发式(CJK 加权)、git 上下文 `node:child_process` execFile。

**不做的事(留待后续)**:

- reactive compact(prompt_too_long 自动压缩)+ 硬截断兜底 + 孤儿 tool 修复 → **0.3.1**(本版 §7 交接)。
- session 切换 UI / 方向键 select 菜单 → V8(`docs/select-ui-plan.md` 已批准未实现)。
- cache_control 分块、精确 tokenizer → 后续成本优化(本版用稳定/动态字符串边界保前缀)。
- CLAUDE.md 的 repo map / 语义索引 → V4 代码理解。

---

## §1 架构决策

### 决策 1:system 注入 = 首条 system 消息,零适配器改动

`runQuery` 把 `opts.system` 拼成 `[{ role: "system", content }]` 作为消息数组首条传给 `client.stream`。已核实:anthropic 适配器(`src/providers/anthropic.ts:76,88`)把 system 抽到顶层 `system` 参数;openai 适配器(`src/providers/openai.ts:34-35`)内联 `role:"system"`;ollama 复用 openai。**无需改适配器逻辑**,补测试锁定即可。system 不进 `RunQueryResult.messages` / 不持久化——只在 opts 里。

```ts
// src/core/query.ts
export interface RunQueryOptions {
  // ... 现有字段
  system?: string; // 组装好的 system prompt(首条注入,不进返回/持久化)
  contextWindow?: number; // 触发自动 compact 的窗口(本版 M2 用)
  onCompact?: (info: { beforeTokens: number; afterTokens: number; summary: string }) => void;
  querySource?: "user" | "resume" | "compact"; // "compact" 跳过一切压缩,防递归
}

export interface RunQueryResult {
  messages: LLMMessage[]; // 完整对话(不含 system;compact 后为边界消息 + 后续)
  added: LLMMessage[]; // 本调用新产生、需持久化的消息(含 compact 边界)★新契约
  reply: string;
  iterations: number;
  compacts: number; // 本调用发生压缩的次数
}
```

### 决策 2:持久化契约改 `added` + REPL 数组替换(关键前提)

V1/V2 用 `result.messages.slice(before)` 持久化(`src/cli/repl.ts:167-180`、`:94-96`),假设 `runQuery` 只 append。**compact 会整体替换 messages 数组,`slice(before)` 必然错位**;且 REPL 从不把自己的 `messages` 替换成 `result.messages` → 跨轮只把 user 消息喂给模型。

修法:`runQuery` 内部统一经 `pushConversation(m)`(同时 push 进 `messages` 与 `added`);compact 重建时把边界消息 push 进 `added`。REPL / runOneShot 改为:

```ts
const result = await runQuery(messages, opts);
messages = result.messages; // ★ 替换自身数组(跨轮连续性)
for (const m of result.added) await appendMessage(opts.sessionFile, m); // ★ 持久化 added
```

### 决策 3:CLAUDE.md 四级自有路径 + Trust 门控 + 只读直读

- 级别(优先级从高到低):**managed**(内置预留,本版空)→ **user** → **project** → **local**。注入 system 时按序拼接并标注来源。
- 路径(**run-agent 自有约定**,用户已拍板):

| 级别    | 路径                            | 注入条件       |
| ------- | ------------------------------- | -------------- |
| managed | 内置(预留,空)                   | 始终           |
| user    | `~/.config/run-agent/CLAUDE.md` | 始终(用户自写) |
| project | `<cwd>/CLAUDE.md`               | 项目受信任     |
| local   | `<cwd>/.run-agent/CLAUDE.md`    | 项目受信任     |

- project/local 仅受信任项目注入,与 V2 的项目级规则门控一致(`src/cli/index.ts:125-138` 的 `isTrusted`),防恶意仓库提示注入。
- 读取用直接 fs(只读、剥 BOM、单文件大小上限),**不走工具** → 与内置 deny 对 `.run-agent` 路径的*工具*限制不冲突;副作用:agent 不能用 write_file 改自己的 local 记忆(属安全特性,文档注明)。
- `--bare`:`opts.system = undefined`,禁用全部记忆/上下文注入。

```ts
// src/core/context.ts
export interface SystemContext {
  cwd: string;
  isTrusted: boolean;
  bare: boolean;
}
export interface GitContext {
  branch?: string;
  sha?: string;
  subject?: string;
  user?: string;
  status?: string[];
}
export async function buildSystemPrompt(
  ctx: SystemContext,
  opts?: { git?: GitContext; date?: Date },
): Promise<string | undefined>; // bare → undefined
export async function collectClaudeFiles(
  cwd: string,
  isTrusted: boolean,
): Promise<{ level: string; content: string }[]>;
```

### 决策 4:token 估算启发式 + contextWindow 配置 + 阈值钳制

零依赖估算,CJK 加权(本项目 system/工具结果以中文为主,不加权严重低估):

```ts
const CJK = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]/g;
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK)?.length ?? 0;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}
export function estimateMessageTokens(m: LLMMessage): number; // 块内容 JSON.stringify + tool 固定开销 3/条
export function estimateMessagesTokens(ms: LLMMessage[]): number;
export function estimateInputTokens(
  messages: LLMMessage[],
  system: string | undefined,
  toolSpecsTokens: number,
): number;
```

contextWindow 默认映射(`src/config/index.ts`,优先级 flag > env > 配置文件 > 默认映射):

| provider          | 默认窗口 | 依据                          |
| ----------------- | -------- | ----------------------------- |
| anthropic         | 200000   | Sonnet/Opus/Haiku 现行 200k   |
| openai            | 128000   | gpt-4o-mini 等                |
| openai-compatible | 128000   | DeepSeek 等多数 128k/64k,取高 |
| ollama            | 8192     | 本地小模型常 4k-32k,取保守    |

**阈值钳制**:`threshold = max(contextWindow − 13000, floor(contextWindow * 0.6))`——第二项兜底小窗口(ollama 8k 时 13000 buffer 会溢出成负阈值导致每轮都压缩)。

### 决策 5:compact = 整段摘要 + 单边界消息 + 本地重挂已读文件

- **不做"保留尾段"模型**:把当前对话全部内容(含最新 user 请求)整段交给摘要,产出单一边界消息作新上下文起点 → 主动压缩路径无 tool_use/tool_result 配对撕裂、持久化顺序天然自洽(边界一定追加在文件尾部之后)。
- `summarizeHistory`:**同 client、无 tools、流式累积 text、`querySource:'compact'`、maxTokens≈1000**。摘要输入若 `estimate > contextWindow − 3000` 先裁最老消息,防摘要请求自身爆窗。
- 边界消息:`[上下文已压缩]…` + 哨兵 + `<summary>` + 重挂文件块(上限 5 个、各 2000 行 / 4MB / BOM / 二进制守卫,复用 `src/tools/read.ts` 的读取约束)。
- **递归防线**:`summarizeHistory` 直接调 `client.stream`(不经 `runQuery`);`runQuery` 在 `querySource === 'compact'` 时跳过主动压缩。双保险。

```ts
// src/core/compact.ts
export const COMPACT_BUFFER = 13000;
export const COMPACT_MARKER = "\u0000RUN_AGENT_COMPACT_BOUNDARY\u0000";
export const COMPACT_SYSTEM_PROMPT = "..."; // 见 §3 M2

export interface CompactContext {
  client: LLMClient;
  contextWindow: number;
  toolSpecsTokens: number;
  system?: string;
  onCompact?: (info: { beforeTokens: number; afterTokens: number; summary: string }) => void;
}
export async function maybeAutoCompact(
  messages: LLMMessage[],
  ctx: CompactContext,
): Promise<{ messages: LLMMessage[]; compacted: boolean }>;
export async function summarizeHistory(
  client: LLMClient,
  messages: LLMMessage[],
  maxTokens?: number,
): Promise<string>;
export function buildBoundaryMessage(summary: string, files: string[]): LLMMessage;
export function collectReadFiles(messages: LLMMessage[]): string[]; // tool_use 历史捞 read_file 路径,去重取最近 5
```

### 决策 6:system 稳定/动态边界(落地 Plan.md 决策 8)

`buildSystemPrompt` 返回 `stable + 分隔 + dynamic`:

- stable = 角色准则 + 工具使用准则 + CLAUDE.md 记忆(按需重读)。
- dynamic = 日期 + git 状态(分支/sha/最近 commit/git user/status 前 10 行)。

动态在后,保住稳定前缀的 cache 复用。git 用 execFile 并发 5 条命令,`{ timeout: 800, windowsHide: true }`,任一失败静默置 `undefined`,全程 ≤ ~1s;module 级 3s TTL 缓存(cwd 维度);system 在每次 `runQuery` 前重建。

### 决策 7:reactive compact 走 V2 重试框架(0.3.1)

在 `src/core/query.ts` stream 的 catch 分支扩展:捕获 context-too-long(anthropic `type=prompt_too_long` / openai `code=context_length_exceeded` / 消息正则)→ 强制 `maybeAutoCompact` → 重置 attempt/textParts/toolUses → 重试;已压缩仍超长 → `hardTruncateToFit`(反复丢最老直到 fit)+ `normalizeToolPairing`(清孤儿 tool 消息)→ 重试;裁不动才抛原错误。不属 transient,与指数退避互斥。**全部落到 0.3.1**。

### 决策 8:超大工具结果指针化(便宜层,先于摘要)

- **触发**:组装 `role:"tool"` 消息时,`estimateMessageTokens(result) > TOOL_RESULT_SPILL_TOKENS`(默认 8192,`RUN_AGENT_RESULT_SPILL_TOKENS` 可覆盖)→ 结果落盘。
- **落盘位置**(耐用,resume 可读):与 session 同目录 `<sessionFile>.r<n>.txt`;需 `resultsDir` 经 `RunQueryOptions` 透传(由 cli/repl 从 `sessionFile` 派生,one-shot 与 REPL 都传)。
- **消息内容**:`[结果已写入 <absPath>(共 N 行)。需要全文时用 read_file 读取该路径]`,替换原文进消息列表。
- **模型取用**:走 read_file → 自动进权限管线(只读工具默认 allow;`~/.local/share/run-agent/…` 不含内置 deny 的 `.run-agent` 段,不冲突)。
- **收益**:超大输出(bash>30k、大文件)不再整段进消息列表,`estimateInputTokens` 显著下降 → 自动压缩触发频率降低;resume 后指针仍可读。
- **清理**:落盘文件随 session 保留,文档注明可手动清理(风险 11)。

---

## §2 里程碑 M1 — 上下文组装 + CLAUDE.md(0.3.0)

**文件**:

- `src/core/context.ts`(新建):`estimateTokens` 族、`GitContext`/`SystemContext`、`collectGitContext(cwd)`、`buildSystemPrompt(ctx, { git?, date? })`、`collectClaudeFiles(cwd, isTrusted)`(四级自有路径、直读、剥 BOM、上限)。
- `src/config/index.ts`:`RunAgentConfig`/`CliOverrides` 加 `contextWindow?: number`;`DEFAULT_CONTEXT_WINDOW: Record<ProviderName, number>`;`envConfig` 读 `RUN_AGENT_CONTEXT_WINDOW`。
- `src/cli/index.ts`:`--bare`、`--context-window <n>`;`CliOpts` 加字段;`main()` 组 `SystemContext { cwd, isTrusted, bare }` → `buildSystemPrompt` → 传 `system`/`contextWindow` 进 `agentOpts`。
- `src/cli/repl.ts`:`AgentOptions` 加 `system`/`contextWindow`/`onCompact`;每轮 `runQuery` 前重建 system;持久化切 `added`;REPL 数组替换。
- `src/core/query.ts`:`RunQueryOptions`/`RunQueryResult` 按决策 1/2 扩展;首行 `initial.filter(m => m.role !== "system")`;stream 首条拼 system 消息;所有 push 换 `pushConversation`。
- 测试:`tests/core/context.test.ts`、`tests/config.test.ts`(contextWindow 优先级矩阵)、`tests/core/query.test.ts`(system 进请求不进返回)、`tests/providers/anthropic.test.ts`(system 抽顶层锁定)。

**验收**:

- 估算单测绿(中文串/英文串/ContentBlock JSON)。
- `buildSystemPrompt` trusted 时含 project/local CLAUDE.md,未 trusted 不含;`--bare` 时返回 undefined。
- `collectGitContext` 在临时 `git init` 仓库返回 branch/sha/subject/user(CI 有 git;git 缺失时静默 undefined)。
- `runQuery` 请求首条是 system 消息;`result.messages` / `added` 不含 system。
- REPL 跨轮历史含 assistant/tool 消息(连续性回归:第二轮起模型能看到上一轮工具结果)。

## §3 里程碑 M2 — compact 核心(0.3.0)

**文件**:

- `src/core/compact.ts`(新建):决策 5 的全部函数 + 决策 8 助手(`TOOL_RESULT_SPILL_TOKENS`、`spillOversizedResult(content, index, resultsDir)`)+ `COMPACT_SYSTEM_PROMPT`。摘要提示词草案:

```
You are compressing a terminal coding-agent conversation history (user requests, assistant tool
calls, file reads, command runs, replies) into a dense summary.
- State the user's overall goal, current task state, and what remains to be done.
- Keep every important fact: absolute file paths, symbols, key line numbers, decisions and reasons.
- Note files read and what matters in them; commands run and outcomes; errors and what was tried.
- Prefer exact identifiers over paraphrase; never drop constraints or requirements.
- End with a near-verbatim restatement of the most recent user request.
- Match the conversation's language. Use prose plus short bullets. Under 500 tokens.
```

- `src/utils/sessionStorage.ts`:`loadSession` 扫描最后一个含 `COMPACT_MARKER` 的 user 消息,**只从它之后返回**(JSONL 仍追加式,旧历史留在文件但被忽略;无哨兵的旧会话回退全量加载)。
- `src/cli/repl.ts`:`/compact` 命令(手动 `maybeAutoCompact` → 替换 messages → `appendMessage` 边界 → 提示压缩前后 token 数)。
- `src/core/query.ts`:while 循环顶(iterations++ 后、stream 前)主动压缩:`contextWindow` 已设 && `querySource !== "compact"` && `estimateInputTokens > threshold` && `messages.length >= 4` → `maybeAutoCompact`,边界 push 进 `added`;工具结果组装时做指针化(决策 8,`RunQueryOptions.resultsDir` 提供落盘目录)。
- 测试:`tests/core/compact.test.ts`(阈值触发/不触发;边界消息含哨兵与重挂文件;collectReadFiles 去重取最近;落盘/指针替换/未超阈值不变/env 覆盖;硬截断不进本版)、`tests/core/query.test.ts`(mock 长对话小 contextWindow → 摘要 → 续跑正确;`added` 含边界;递归守卫;有 resultsDir 时指针化、无则原样)、`tests/utils/sessionStorage.test.ts`(单/多边界取最后一个)。

**验收**:

- 连续 10+ 轮工具调用(mock,小 contextWindow 触发)不爆上下文,续跑结果正确。
- 边界消息含重读文件内容(压缩后已读文件可恢复)。
- `/compact` 手动触发并持久化;`loadSession` 从最后边界续起。
- `--resume` 后历史超阈值自动压缩。
- 超大工具结果被指针化:消息列表只剩指针+预览,模型 read_file 可读全文;未超阈值结果原样保留。

## §4 里程碑 M3 — 0.3.0 发布

**文件**:

- `docs/context-management.md`(压缩策略、CLAUDE.md 四级约定、contextWindow 配置、`--bare` 语义、0.3.1 预告)。
- `CHANGELOG.md` 记 `[0.3.0]`;`package.json` version `0.3.0`;README 补特性(`--bare`/`/compact`/contextWindow/CLAUDE.md)。
- `docs/architecture.md` 目录树与扩展点表更新。

**验收**:CI 三 OS × Node 20/22/24 全绿;`npm pack` 干净;tag `v0.3.0`;发布 `npm publish --access=public`(复用 0.2.0 流程与 `~/.npmrc` token)。

---

## §5 DoD 验收清单

- [ ] `buildSystemPrompt` 注入日期 + git 分支/status/最近 commit/git user;稳定/动态边界分隔
- [ ] CLAUDE.md 四级自有路径;project/local 仅 trusted 注入;`--bare` 全禁
- [ ] token 估算(CJK/Latin/JSON 块)+ contextWindow 优先级矩阵
- [ ] system 进请求、不进返回/持久化;REPL 跨轮连续性
- [ ] 主动 compact:mock 长对话超阈值 → 摘要 → 边界 → 续跑正确;`added` 含边界
- [ ] 超大工具结果指针化:超阈值落盘、消息只剩指针+预览,模型 read_file 可读全文(单测)
- [ ] 压缩后已读文件可恢复(边界消息含重读内容)
- [ ] `/compact` 手动触发 + 持久化;`loadSession` 从最后边界续起
- [ ] `--resume` 后历史超阈值自动压缩
- [ ] 0.3.0 发布:CHANGELOG/package.json/CI/tag/`npm pack`/npm publish
- [ ] **真实模型手动验证(需 key)**:长会话触发 auto-compact 且任务不丢;`--resume` 续接压缩过的会话;DeepSeek/Ollama 下压缩正常;`--bare` 无注入

## §6 风险与注意

1. **无 tokenizer 估算误差** → 13k buffer + CJK 加权 + `contextWindow` 可配;最坏由 0.3.1 reactive 兜底。ollama 小窗口务必钳制阈值。
2. **compact 撕裂 tool 配对** → 整段摘要无尾段模型消除主动路径;硬截断兜底(0.3.1)用 `normalizeToolPairing` 修复。
3. **摘要子请求自身爆窗** → 输入先裁到 `contextWindow − 3000`,摘要 maxTokens≈1000。
4. **REPL 持久化契约** → 必须切 `added` 契约 + 数组替换,否则 resume 丢上下文(本版核心修复,勿省)。
5. **git 命令延迟** → 并发 + 800ms 超时 + 3s TTL + 失败静默;`windowsHide:true` 防 Windows 闪窗。
6. **提示注入 via 恶意 CLAUDE.md** → project/local 仅 trusted 注入;`.run-agent/CLAUDE.md` 只读直读、agent 工具碰不到(内置 deny),文档注明。
7. **compact 额外 LLM 成本** → 每次压缩一次摘要请求;`messages.length>=4` 防过度压缩。
8. **`/clear` 与 resume** → `/clear` 只清内存不落盘,清空后 resume 仍读到旧历史(沿用现状,文档注明)。
9. **工程纪律**:`exactOptionalPropertyTypes` 条件 spread、`verbatimModuleSyntax` `import type`、zod v4 `instanceof` 窄化、读文件剥 BOM——沿用 V2 纪律。
10. **`--resume` 兼容** → `loadSession` 只在找到哨兵时重置;无哨兵旧会话(0.2.0)回退全量加载,行为不变。
11. **指针化落盘文件累积** → 单文件 ≤ ~4MB、随 session 保留;文档注明手动清理,不阻塞。

## §7 版本间交接(0.3.0 → 0.3.1)

**0.3.0 结束时的代码状态**:

- `src/core/context.ts`(估算/上下文/git/CLAUDE.md)、`src/core/compact.ts`(主动压缩:阈值/摘要/边界/文件重挂)、`src/config/index.ts`(contextWindow)、`src/cli/index.ts`(`--bare`/`--context-window`)、`src/cli/repl.ts`(`/compact`、`added` 契约、数组替换)、`src/core/query.ts`(system 注入 + 主动压缩 + `added`)、`src/utils/sessionStorage.ts`(边界重置点)。

**留给 0.3.1 的扩展点**:

- **reactive compact**:`isPromptTooLong(e)`(`src/utils/errors.ts`,anthropic `type=prompt_too_long` / openai `code=context_length_exceeded` / 消息正则);query.ts catch 分支接入;`compactedThisIter` 标志。
- **硬截断兜底**:`hardTruncateToFit(messages, threshold)`、`normalizeToolPairing`(清孤儿 tool 消息)。
- 复用 V2 重试框架(`isTransientError` 之外的第二个错误分支)。

**为 V4 预留**:compact 的 token 统计/边界机制可直接喂 V4 的 repo map;`collectClaudeFiles` 的四级结构可扩展为 V4 的记忆索引。V4 已纳入**主动记忆管理**(agent 自动写入/检索项目记忆,见 `docs/Plan.md` §五 V4)——本版 compact 摘要与 session 持久化是记忆写入的素材来源,`--bare` / Trust 门控语义在其写入路径沿用。

---

## §8 版本 0.3.1 —— reactive compact + 硬截断兜底

> 上游:`docs/Plan.md` §五 V3;本文件 §1 决策 7、§7 交接。
> 本版本一句话:把"超长必爆"的最后一道兜底补上——主动压缩拦不住时,由错误驱动的反应式压缩 + 硬截断兜住。
> 工期:≈ 1 周,交付 `0.3.1`。

### 8.1 结论速览

**交付什么**:

- **reactive compact**:调用返回 context-too-long 时,不当作普通错误抛出,而是触发压缩后重试,让长会话在主动压缩失效时仍能续跑。
- **硬截断兜底**:压缩一次仍超长 → 反复丢最老消息直到 fit → 修复被截断撕裂的 tool 配对 → 重试;裁不动才抛原错误。
- 与 V2 指数退避(`isTransientError`)互斥:context-too-long 不重试、走压缩,两者不混。

**技术栈增量**:零新依赖。

**不做的事**:cache_control 分块、精确 tokenizer、`run-agent memory` 主动记忆(→ V4)均不在本版。

### 8.2 架构决策

**决策 8.1:错误识别 = `isPromptTooLong(e)`(三形态)**

```ts
// src/utils/errors.ts
export function isPromptTooLong(e: unknown): boolean;
```

识别三种 shape:

- **Anthropic**:`error.error.type === "prompt_too_long"`(SDK APIError 嵌套 error 对象)。
- **OpenAI / 兼容**:`code === "context_length_exceeded"`。
- **消息正则兜底**:`/prompt[_ ]too[_ ]long|maximum context length|context_length_exceeded|prompt is too long/i`。

**决策 8.2:共享阈值助手 `computeCompactThreshold`**
M2 的阈值计算内联在 `src/core/query.ts`,0.3.1 抽到 `src/core/compact.ts` 统一导出,主动/反应式两处共用,防两处漂移:

```ts
export function computeCompactThreshold(contextWindow: number): number {
  return Math.max(contextWindow - COMPACT_BUFFER, Math.floor(contextWindow * 0.6));
}
```

**决策 8.3:双守卫防死循环**

- `compactedThisIter: boolean`,每次 while 迭代开头复位 → 同一次迭代里压缩最多一次,之后只走硬截断。
- `querySource === "compact"` 的摘要请求永不触发 reactive(摘要请求自身不带 contextWindow)。

**决策 8.4:硬截断不写边界标记**
硬截断只是内存里丢最老消息,不产生新边界(避免把"截断"伪装成"压缩");session 文件里被丢的旧消息仍在。resume 重放若再超长,由 reactive compact 兜住——可接受,文档注明。

### 8.3 里程碑 M4 —— reactive compact + 硬截断兜底

**文件**:

- `src/utils/errors.ts`:`isPromptTooLong(e)`(决策 8.1)。
- `src/core/compact.ts`:`computeCompactThreshold`(决策 8.2,顺手抽离 M2 内联阈值);`hardTruncateToFit(messages, threshold)`(反复丢最老直到 `estimateMessagesTokens <= threshold`,保底保留最近 2 条);`normalizeToolPairing(messages)`(收集 assistant 消息里的 tool_use id 集合 → 丢弃 `tool_use_id` 不在集合里的 `role:"tool"` 消息 → 丢弃无后续 tool_result 的孤儿 tool_use 块)。
- `src/core/query.ts`:catch 分支在 `isTransientError` 判断**之前**插入 reactive 分支:

```ts
// (伪代码,实现以 query.ts 现有 retry 结构为准)
} catch (e) {
  if (opts.contextWindow && opts.querySource !== "compact" && isPromptTooLong(e)) {
    if (!compactedThisIter) {
      compactedThisIter = true;
      const r = await maybeAutoCompact(messages, compactCtx);   // 强制压缩一次
      if (r.compacted) {
        messages = r.messages;
        added.push(r.messages[0]!);                             // 边界入 added,随持久化落盘
        attempt = 0; textParts = []; toolUses = [];
        continue;                                               // 重试
      }
    }
    // 已压缩仍超长 → 硬截断兜底
    const next = hardTruncateToFit(messages, computeCompactThreshold(opts.contextWindow));
    normalizeToolPairing(next);
    if (next.length === messages.length) throw e;               // 裁不动,抛原错误
    messages = next;
    attempt = 0; textParts = []; toolUses = [];
    continue;
  }
  if (attempt >= maxRetries || !isTransientError(e)) throw e;   // 原有 transient 分支
  // ...
}
```

- 测试:`tests/core/query.test.ts`(抛 prompt_too_long 一次 → 压缩 → 重试成功;压缩后仍抛 → 硬截断 → 重试;极短 contextWindow 裁不动 → 抛原错误;`querySource='compact'` 不触发)、`tests/utils/errors.test.ts`(anthropic shape / openai code / 正则兜底 三形态 + 误判反例)、`tests/core/compact.test.ts`(hardTruncateToFit 丢最老至 fit、保底 2 条;normalizeToolPairing 清孤儿 tool 消息与孤儿 tool_use 块)。

**验收**:client 抛 context-too-long → 摘要重试成功且 `added` 含边界;压缩后仍超长 → 硬截断 + 孤儿修复 → 重试;同一次迭代只压缩一次、不陷入死循环;裁不动时抛原错误。

### 8.4 里程碑 M5 —— 0.3.1 发布

**文件**:

- `docs/context-management.md` 补"反应式压缩"小节(超长错误自动压缩 → 硬截断兜底的行为与阈值说明)。
- `CHANGELOG.md` 记 `[0.3.1]`;`package.json` version `0.3.1`;README 如需补一句超长兜底行为。
- 交接:`docs/Plan_V3.md` 本 §8 归档为 0.3.1 的实施方案;相关 bug 另行记入 `docs/Bug_V3.md`。

**验收**:CI 三 OS × Node 20/22/24 全绿;`npm pack` 干净;tag `v0.3.1`;`npm publish --access=public`。

### 8.5 0.3.1 DoD 验收清单

- [ ] `isPromptTooLong` 三形态识别(单测,含误判反例)
- [ ] reactive compact:抛 context-too-long → 摘要 → 重试成功;`added` 含边界
- [ ] 已压缩仍超长 → 硬截断 + 孤儿修复 → 重试
- [ ] `compactedThisIter` + `querySource` 双守卫:同迭代只压缩一次、不死循环
- [ ] 裁不动(极短 contextWindow)抛原错误
- [ ] 0.3.1 发布:CHANGELOG / package.json / CI / tag / `npm pack` / npm publish
- [ ] **真实模型手动验证(需 key)**:人工塞入超长上下文 → 超长错误被自动压缩接住并续跑;极端小 contextWindow 下不挂

### 8.6 0.3.1 风险与注意

1. **错误识别跨提供商差异** → 三形态 + 正则兜底;漏识别时回落现有抛错路径(不更糟)。
2. **硬截断丢上下文** → 只丢最老、保底 2 条;`normalizeToolPairing` 修配对;最坏被用户 `--resume` 看到旧历史,再由 reactive 兜。
3. **死循环** → `compactedThisIter` + `querySource` 守卫 + 裁不动抛错,三重保险。
4. **resume 兼容** → 硬截断不写标记;旧会话(0.3.0)无标记逻辑不冲突。
5. **工程纪律**沿用 V3:`exactOptionalPropertyTypes` 条件 spread、`verbatimModuleSyntax` `import type`。

### 8.7 0.3.1 → V4 交接

0.3.1 结束时,compact 链路完整:主动(阈值)+ 手动(`/compact`)+ 反应式(超长错误)+ 兜底(硬截断),全部共享 `computeCompactThreshold` 与 `estimateTokens` 族。V4 主动记忆直接复用这套上下文/压缩管线作为"写入素材"来源;`--bare` / Trust 门控语义继续沿用。
