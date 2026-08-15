# 会话持久化：run-agent 当前实现 vs Claude Code 方案

> 目的：记录 run-agent 会话持久化的当前实现（对照 V1 时代的旧评估逐项更新），并以 Claude Code 的真实实现
> （源码级核实）为参照，给出尚未落地的改进建议。
>
> **版本说明**：本文初稿写于 V1，评估「消息数组持久化」的现状并给出 V3 及以后的建议。此后 V3 实现了
> `added` 契约 + compact（哨兵边界）、V7 新增子 agent 独立 transcript，实现方式已有实质变化。V8 落地
> 会话按 cwd 分目录 + 首行元数据 + `--list` / `--resume <id>` / REPL `/sessions` 交互切换。本版重写
> §1/§3/§4 为**当前实现（0.8.1）**；§2（Claude Code 研究）与结论不受版本影响，基本保留原文。
>
> 核实来源：run-agent 侧以当前 `src/` 为准（文件行号即当前代码）；Claude Code 侧为
> `F:\CC_Source\claude-code-sourcemap\`（@anthropic-ai/claude-code 2.1.88 的 npm sourcemap 还原源码，
> 非官方、仅供研究），并交叉核对本机 `~/.claude/projects/` 下真实 transcript（CLI 2.1.227）。

---

## 0. 一句话结论

- **run-agent = 消息数组的 append-only 日志 + 哨兵边界**：写入是逐条追加 `LLMMessage`，读取是拼回数组、
  遇到压缩边界从摘要续起。核心文件 `src/utils/sessionStorage.ts`（215 行，零依赖）。
- **V3 之后的关键演进**：① 持久化契约从 `result.messages.slice(before)` 改为 **`added` 契约 + 数组替换**，
  为 compact 重建数组铺路；② **compact 已内联实现**——不重写文件，向同一 JSONL 追加一条带哨兵的边界消息，
  resume 从最后一个边界续起（对应旧建议 P2#8，已超出原预期）；③ **V7 子 agent 独立 transcript**——与主会话
  同目录、同格式的 `<sessionDir>/subagent-<id>.jsonl`；④ **V8 会话按 cwd 分目录 + 首行元数据 + 会话切换**
  ——修跨项目串会话、`--list` / `--resume <id>` / REPL `/sessions` 可看历史并自主切入（见 §1.9）。
- **Claude Code = 持久化日志里的图**：每行一个带 `uuid`/`parentUuid` 的 Entry 节点，读取按链重建、按语义剪枝。
  它支撑 compact、snip、rewind、fork、子代理 sidechain、Edit 回滚——都是「对图做变换」。
- **尚未落地的建议（现状更新）**：P0 ① 按 cwd 分目录 + ② 文件权限收紧 **V8 已落地**；P1 ⑤ 元数据记录 + ④
  `--resume <id>` 指定切入 **V8 已落地**（不做 `uuid`/`parentUuid` 图、不做 `last-prompt` 指针）；P2 批量写队列、
  渐进式读取除列表头部外均未做（会话体量未到 GB 级）。

---

## 1. run-agent 当前实现

### 1.1 存储位置与文件格式

核心文件：`src/utils/sessionStorage.ts`（215 行，V8 后从 82 行重写：cwd 分目录 + 首行元数据 + 会话列表/定位）。

| 要素     | 实现                                                                             |
| -------- | -------------------------------------------------------------------------------- |
| 存储位置 | `~/.local/share/run-agent/sessions/`（基于 `homedir()`）                         |
| 目录结构 | **按 cwd 分目录**（V8 ①）：`sessions/<sanitized-cwd>/`，`sanitizePath` 非字母数字 → `-`、超长截断 200 字符 + sha256 8 位 hash 后缀 |
| 文件命名 | `<ISO时间戳去冒号点>-<6位随机base36>.jsonl`，如 `2026-08-10T22-59-00.000Z-abc123.jsonl` |
| 首行元数据 | 新建会话第 1 行 `{ ts, meta: { cwd, model, provider, version } }`（V8 ②），第 2 行起才是消息行 |
| 单行格式 | `{ ts, message: LLMMessage }` 或首行 `{ ts, meta }`，逐行 `appendFile` 追加，`ts` 是写入时刻的独立时间戳 |
| 权限     | 目录 `mkdir { mode: 0o700 }`、文件 `appendFile { mode: 0o600 }`（V8 ③，Node 的 mode 只对新建项生效） |
| 读取     | `loadSession()` 逐行 `JSON.parse` 重建数组（跳过 meta 行），坏行 `try/catch` 跳过                 |
| resume   | `--resume`（无 id）→ `latestSessionFile()` 按文件名字典序倒序取最新；`--resume <id>` → `findSessionFile()` 按 id 定位 → `loadSession` 回放 |

对应代码：`sessionsDir()`（`sessionStorage.ts:9`）、`sanitizePath`（`:15-21`）、`SessionMeta`/`SessionRecord`
（`:24-36`）、`createSessionFile`（`:48-62`）、`appendMessage`（`:65-68`）、`loadSession`（`:74-99`）、
`latestSessionFile`（`:102-118`）、`findSessionFile`（`:205-214`）。

### 1.2 写路径：`added` 契约（V3 核心变更）

旧文档写的是 `result.messages.slice(before)`——V3 起废弃。现在：

- `runQuery` 内部所有消息统一经 `pushConversation` 入队，**同时**推进 `messages` 与 `added` 两个数组
  （`src/core/query.ts:140-144`）。
- REPL 每轮（`runTurn`，`src/cli/repl.ts:405-442`）与 one-shot（`runOneShot`，`repl.ts:257-297`）的持久化顺序一致：
  1. **先把用户 prompt 追加一行**（`repl.ts:406-407` / `repl.ts:263-264`）；
  2. 跑完后 `for (const m of result.added) await appendMessage(...)`（`repl.ts:433-435` / `repl.ts:290-292`）；
  3. **`messages = result.messages`** 整体替换（`repl.ts:432`）——compact 可能重建数组，`slice` 已不可靠。
- **compact 边界消息、`pollExternal` 注入的外部消息也都走 `added`**（`query.ts:180`、`query.ts:154`），
  因此它们同样会被持久化。
- headless 也复用 `runOneShot`，同一持久化路径（`src/cli/index.ts:495,523`），会话文件名进 headless JSON 输出
  的 `session` 字段（`index.ts:531`）。

### 1.3 读路径：`--resume [id]`

- `--resume`（无 id）→ `latestSessionFile()` 取**当前项目**最新会话；`--resume <id>` → `findSessionFile()` 按 id 定位
  指定会话（id 取文件名 `<ts>-<id>` 全串）→ `loadSession(f)` 回放（`src/cli/index.ts:372-395`）。
- `sessionsDir(cwd)` 传入当前工作目录：`--resume` 只认当前项目的会话，不再跨项目串会话（V8 ①）。
- `findSessionFile`：id 用 `/^[0-9A-Za-z][0-9A-Za-z.\-]*$/` 正则校验（防路径穿越），`stat` 存在性确认。
- `latestSessionFile`：readdir 过滤 `.jsonl` + 排除 `subagent-` 前缀，按文件名**逆字典序**取第一个——
  ISO 时间戳去冒号点后字典序即时间序（`sessionStorage.ts:102-118`）。**文件名时间戳固定 UTC**
  （`toISOString()`），排序不变式依赖它；展示层才用 `sessionIdTime()` 转本地时区（地区自适应）。
- `loadSession`：逐行 parse，跳过 meta 行，遇到内容含压缩哨兵 `\u0000RUN_AGENT_COMPACT_BOUNDARY\u0000` 的消息时
  **重置加载点**为 `messages = [该边界消息]`（最后一个哨兵赢）；损坏行跳过，resume 不因单行坏数据失败
  （`sessionStorage.ts:74-99`）。

### 1.4 compact 与持久化的协同（V3）

- **JSONL 保持纯追加**，compact 不重写文件——旧历史留在文件里，加载时被边界重置忽略，实现「resume 从摘要续起」。
- 边界消息 = `[上下文已压缩] <哨兵> + 对话摘要 + 已重新挂载文件块`（`src/core/compact.ts:101-111`，
  哨兵定义 `compact.ts:16`；重挂来自 `collectReadFiles` 捞 read_file 历史、最多 5 个文件）。
- **自动压缩**：`runQuery` 每轮循环顶估算超阈值即 `maybeAutoCompact`，边界消息进 `added` 被持久化
  （`query.ts:165-183`）。
- **手动 `/compact`**：`messages = res.messages` + 仅持久化边界消息（`repl.ts:565-590`）。
- **反应式压缩**：`prompt_too_long` 时强制压缩；仍超长则 `hardTruncateToFit` 反复丢最老消息 +
  `normalizeToolPairing` 修孤儿 tool 配对（`compact.ts:187-225`）——都在内存完成，不额外落盘。

### 1.5 子 agent 独立 transcript（V7 新增）

- `transcriptDir` = `path.dirname(sessionFile)`，与主会话**同目录**（`index.ts:406-407`）。
- 后台任务：每个任务一个 `<transcriptDir>/subagent-<id>.jsonl`（如 `subagent-task-1.jsonl`，
  `src/services/agents/team/registry.ts:88-91`）。
- 写入：`runAgent` 先 append 用户 prompt，再逐条 append `result.added`（`src/core/run_agent.ts:55-86`），
  **格式与主会话相同**的 JSONL。独立文件与主会话命名不冲突。

### 1.6 目录复用

`resultsDir` 同样指向 `path.dirname(sessionFile)`——超大工具结果落盘为 `<sessionDir>/r<N>.txt`
（决策 8，`compact.ts:47-58`）。因此会话目录最终混存三类文件：主会话 jsonl + 子 agent transcript jsonl +
落盘结果 txt。落盘路径为绝对路径，resume 后仍有效。

### 1.7 `/clear` 语义

`/clear` 只 `messages.length = 0` **清内存，不落盘**（`repl.ts:561-564`）。清空后若 `--resume`，
仍会读到文件里的旧历史——旧文档已注明此行为，现状未变。

### 1.8 评估（V1 短板 → 当前状态）

**V1 起就做对的（现状仍是优点）：**

- **持久化内部统一格式 `LLMMessage`**（含 `tool_use`/`tool_result` block），resume 回放零格式转换、无损，
  切 provider 也续得上。
- **append-only 日志模型**：追加 O(1)、抗崩溃、无需锁/事务。
- **时间戳进文件名**：找最新会话退化成一次字典序排序，零 IO 成本。
- **坏行容错**：单行损坏不拖垮 resume。

**V1 短板 → 当前状态：**

| 短板                    | 当前状态                                                                   |
| ----------------------- | -------------------------------------------------------------------------- |
| `/clear` 只清内存不清盘 | **未变**——清空后 `--resume` 旧历史原样回来（已知、文档注明，沿用现状）      |
| 无会话元数据            | **已解决（V8）**——首行 `meta` 存 cwd/model/provider/version，`--list` 与 resume 可读（未存 token 用量） |
| 无 compact/摘要         | **已解决**——哨兵边界 + 摘要 + 文件重挂，自动/手动/反应式三路，resume 从摘要续起 |
| 坏行「吞错」而非告警    | **未变**——跳过一行 `tool_result` 仍可能让后续 `tool_use` 回放对不上（静默） |
| `--resume` 只能续最新   | **已解决（V8）**——`--resume <id>` 按 id 定位历史会话；REPL `/sessions` 菜单自主切入 |
| 全局平铺、跨项目串会话  | **已解决（V8）**——`sessions/<sanitized-cwd>/` 按项目隔离，`--resume` 只认当前项目 |
| 字典序==时间序假设脆弱  | **未变**——依赖文件名等长且前缀不变                                        |
| 无并发保护              | **未变**——两进程同时 resume 同一文件会交错追加                             |

**V1 之后新增的短板（新引入的复杂度）：**

| 短板                              | 后果                                                                       |
| --------------------------------- | -------------------------------------------------------------------------- |
| 边界重置依赖哨兵字符串            | 若摘要里混入同字面量会误重置；哨兵含 `\u0000`，正常内容不会碰撞，风险可控   |
| 会话目录混存三类文件              | **曾实证出 bug、已修复**：`latestSessionFile` 只按 `.jsonl` 过滤时，`subagent-*.jsonl`（字母开头，char code 恒大于数字）倒序字典序下**永远**排在时间戳主会话前 → `--resume` 会误选子 agent transcript。已修：`latestSessionFile` 过滤 `subagent-` 前缀（常量 `SUBAGENT_FILE_PREFIX`，registry.ts 复用同一前缀命名，防两处漂移）+ 2 条回归测试 |
| 落盘结果 txt 与会话同生命周期      | 无清理策略，长会话会累积 `r<N>.txt` 文件                                    |

### 1.9 会话列表 + 切换（V8 新增）

| 入口 | 行为 |
| ---- | ---- |
| `run-agent --list` | 只列**当前项目**会话（`sessionsDir(cwd)`），每文件**只读前 8192 字节**（渐进式），输出 `id  model  时间  预览`；预览 = 首条用户 prompt 截断 60 字符（A 方案）。无需配置 / API key（在 `loadConfig` 之前执行） |
| `run-agent --resume <id>` | 按 id 定位会话文件（正则防路径穿越）→ `loadSession` 切入，替代「只续最新」 |
| REPL `/sessions` | 列出当前项目会话 → `promptSelect` 方向键菜单（↓/↑ 移动、Enter 切入、Esc 取消）→ 加载目标会话替换当前 `messages` + 更新 `sessionFile` 指针（后续 `appendMessage` 写新会话） |

- 切入语义 = **切换写入目标**：后续追加写入选中的会话文件，当前轮消息也替换为选中的历史。
- `promptSelect` 基建（`src/ui/keypress.ts` + `src/ui/select.ts`）：ANSI 方向键菜单、纯函数 `nextFocus`（回绕 + 跳过 disabled）、
  菜单期间 readline 静音（`rl.pause()` + 临时移除 line 监听）保证 **stdin 唯一所有权**；REPL 权限弹窗
  （`resolveAsk` 三项菜单 + `askTrustProject` 两项菜单）也复用同一菜单，见 `docs/select-ui-plan.md`。
- `--list` 输出示例（`时间` 列 = 本地时区显示，存储/排序仍按 UTC 文件名）：
  ```
  2026-08-14T06-30-00-000Z-abc123  deepseek-chat  2026-08-14 14:30:00  帮我检查一下这段代码的并发安全…
  ```
  （示例假设系统时区 UTC+8：UTC `06-30` → 本地 `14:30`。展示用 `sessionIdTime(id)`，`sessionStorage.ts`。）

---

## 2. Claude Code 的持久化方案（源码核实）

> 源码：`restored-src/src/utils/sessionStorage.ts`（5106 行）、`sessionStoragePortable.ts`（793 行）、
> `sessionRestore.ts`，以及 `services/compact/`、`utils/listSessionsImpl.ts` 等。
> 版本 2.1.88；与机器上 2.1.227 的 transcript 结构一致。

### 2.1 存储布局

```
~/.claude/projects/<sanitized-cwd>/<session-uuid>.jsonl     # 主会话 transcript
~/.claude/projects/<sanitized-cwd>/<session-uuid>/subagents/    # 子代理线程 agent-<id>.jsonl + .meta.json
~/.claude/projects/<sanitized-cwd>/<session-uuid>/tool-results/ # 工具输出缓存
~/.claude/projects/<sanitized-cwd>/memory/                 # 项目级 auto-memory
```

- **目录名 = 编码后的启动 cwd**：`sanitizePath` 把所有非字母数字字符替换成 `-`（Windows 下 `:`/`\` 都是被替换对象），
  超长路径截断到 200 字符 + 追加 hash 后缀保证唯一（`sessionStoragePortable.ts:293-319`）。会话天然按项目隔离。
- **文件名 = sessionId (UUID)**，与文件内每条记录的 `sessionId` 字段一致。每个会话一个同名 sidecar 目录。
- 目录 `0o700`、文件 `0o600` 权限位。

### 2.2 文件格式：每行一个 Entry，不是一条消息

一行一个 JSON 记录。assistant 回合**一个 content block 一行**（thinking/text/tool_use），控制记录混在中间。
`Entry` 类型在 `types/logs.ts`，`appendEntry` 按 `entry.type` 分流（`sessionStorage.ts:1128-1265`），已知类型包括：
`user`/`assistant`/`attachment`/`system`（含 `compact_boundary`、`turn_duration`）以及
`summary`、`custom-title`、`ai-title`、`tag`、`last-prompt`、`mode`、`agent-name`、`agent-color`、
`agent-setting`、`worktree-state`、`pr-link`、`file-history-snapshot`、`content-replacement`、`queue-operation`、
`marble-origami-commit`、`marble-origami-snapshot` 等。

每条消息记录在 `insertMessageChain` 里注入 session 元数据（`sessionStorage.ts:1057-1063`）：
`sessionId, cwd, version, gitBranch, slug, userType, entrypoint`；assistant 记录还带 `model`、`usage`、`stop_reason`。

### 2.3 核心数据结构：parentUuid 链

- 每条消息带 `parentUuid`（会话根为 `null`），工具结果的 `parentUuid` 指向产生它的 assistant（`sourceToolAssistantUUID`）。
- **resume 从 leaf 出发沿 `parentUuid` 回溯重建链**：`buildConversationChain`（`sessionStorage.ts:2069`）。
- compact、`/snip`、剪枝都是在加载时对这条链做手术：
  - `applyPreservedSegmentRelinks`（`sessionStorage.ts:1839`）：跨 compact boundary 把保留段重新接回链；
  - `applySnipRemovals`（`sessionStorage.ts:1982`）：按 boundary 里的 `removedUuids` 删节点并跨 gap 重连。
- **UUID 去重是 resume/compact 能成立的基石**：`getSessionMessages` 维护已写 UUID 集合，
  `recordTranscript`/`appendEntry` 按 UUID 去重，compact 后的 `messagesToKeep` 因 UUID 相同不会重复写入。

### 2.4 写路径

- **批量排队写入**：`enqueueWrite` → `drainWriteQueue`（`sessionStorage.ts:606-686`），**100ms 刷新间隔**、
  单块上限 **100MB**，最后 `fsAppendFile(..., {mode: 0o600})` 合并写。
- **退出时 flush + 重写元数据**：`registerCleanup` 里先 `flush()` 再 `reAppendSessionMetadata()`，
  把 `last-prompt`/`custom-title`/`tag`/`mode`/`worktree-state` 等重新追加到 EOF，保证它们始终在尾部 64KB 窗口内。
- **不是纯 append-only**：`removeMessageByUuid`（`sessionStorage.ts:871`）对流式失败产生的孤儿消息做
  尾部定位 + ftruncate 截断 + 重写尾行；目标不在尾部则整文件重写（>50MB 放弃，`MAX_TOMBSTONE_REWRITE_BYTES`）。
- 开关：`--no-session-persistence` / `cleanupPeriodDays=0` / `CLAUDE_CODE_SKIP_PROMPT_HISTORY` 可整体关停。

### 2.5 读路径：渐进式，为 GB 级文件设计

- **会话选择器**：`readHeadAndTail`（`sessionStoragePortable.ts:215`）只读**头 64KB + 尾 64KB**
  （`LITE_READ_BUF_SIZE = 65536`），即可取标题、slug、时间、首条 prompt——`/resume` 列表扫几百个会话只花几十次小读。
- **真实 resume**：`readTranscriptForLoad`（`sessionStoragePortable.ts:717`）**1MB 分块流式向前读**，
  在 fd 层跳过 attribution 行、在流里就地截断 compact boundary，峰值内存 = 输出大小而非文件大小。
- 硬上限 `MAX_TRANSCRIPT_READ_BYTES = 50MB` 防 OOM（源码注释：会话文件可长到多个 GB，inc-3930）。
- 小于 5MB 的文件跳过 precompact 过滤（`SKIP_PRECOMPACT_THRESHOLD`）。

### 2.6 resume / restore：恢复的不只是消息

`sessionRestore.ts`：

- `processResumedConversation`：复用原 sessionId（`switchSession`，除非 `--fork-session`）、恢复 agent 定义与模型覆盖
  （`restoreAgentFromSession`）、**重新 cd 回退出时的 worktree**（`restoreWorktreeForResume`）、恢复 mode。
- `restoreSessionStateFromLog`：把 `fileHistorySnapshots`（Edit 回滚快照）、`attributionSnapshots`、
  context-collapse 提交日志、TodoList **反序列化回 AppState**。
- transcript 本质是**状态存储**，消息只是其中一部分。

### 2.7 compact

- 自动触发（接近上下文上限时，`trigger:"auto"`），也可手动 `/compact`。
- **内联、append-only、不截断**：向同一文件追加一条 `system`/`compact_boundary` 记录（带 `preTokens/postTokens/cumulativeDroppedTokens/preservedSegment`）
  - 一条 `isCompactSummary: true` 的 `user` 摘要消息。旧内容留在盘上，摘要里还会指明回读完整 transcript 的路径。
- resume 时用 `compactMetadata.preservedSegment` 重建有效链，物理上在 boundary 之前的非保留消息被剪掉。

---

## 3. 逐项对比

| 维度        | run-agent（当前 0.8.1）                                           | Claude Code                                                      |
| ----------- | ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| 目录结构    | `sessions/<sanitized-cwd>/`，按项目隔离（V8，对齐 CC 思路）       | `projects/<sanitized-cwd>/`，按项目隔离                          |
| 文件名      | `<时间戳>-<id>.jsonl`                                             | `<uuid>.jsonl`（uuid==sessionId）                                |
| 行粒度      | 一条 LLMMessage                                                   | 一个 Entry 记录（assistant 回合多行 + 控制记录）                 |
| 消息身份    | 无（不做 uuid/parentUuid 图）                                     | 每条 `uuid` + `parentUuid` 链                                    |
| 每行元数据  | 首行 `meta`：cwd/model/provider/version；消息行仅 `ts`            | `sessionId/cwd/version/gitBranch/slug/model/usage…` 全量         |
| 找最新/续接 | 文件名字典序 + `--resume <id>` 按 id 定位；REPL `/sessions` 菜单   | `last-prompt.leafUuid` 指针 + mtime                              |
| 写路径      | 逐条 `appendFile`（用户 prompt 先写 + `result.added`）+ `0o600`   | 100ms 批量队列 + `0o600` + 退出 flush + 元数据重写               |
| 读路径      | `--list` 只读头 8192B（渐进）；加载整文件 + 哨兵边界重置           | 64KB 头尾渐进 + 1MB 流式加载                                     |
| compact     | 内联哨兵边界 + 摘要 + 文件重挂（自动/手动/反应式）                | 内联 compact_boundary + summary，append-only 不截断              |
| 子代理      | 独立 `subagent-<id>.jsonl` 与主会话同目录，同格式                  | `<session-uuid>/subagents/agent-<id>.jsonl` + .meta.json         |
| 恢复范围    | 消息数组（从最后边界续起）                                        | 完整 AppState（agent/model/worktree/文件历史/attribution/todos） |
| 坏数据      | 坏行跳过 + 边界重置                                               | 按 uuid 去重 + 链手术（relink/snip）                             |
| 模型        | 消息日志（append-only，无图变换）                                 | 状态存储（图）                                                   |

---

## 4. 尚未落地的改进建议（按性价比，状态已更新）

> V3 已把旧 P2#8（compact）做完，且超出原建议（哨兵边界 + 文件重挂 + 反应式压缩 + 硬截断兜底）。
> **V8（2026-08-13）已落地：P0 全部（①cwd 分目录 + ②0o700/0o600）+ P1 部分（首行元数据、`--resume <id>` 指定
> 切入、REPL `/sessions` 交互切换；不做 uuid/parentUuid 图、不做 last-prompt 指针），P2 其余不做**——随
> **0.8.1** 交付，见 §5 设计与 §1.1/§1.3/§1.9 实现。

### P0 · 立刻做（几行改动，高回报）—— ✅ V8 已做（0.8.1）

1. **会话按 cwd 分目录**：`sessions/<sanitized-cwd>/<id>.jsonl`，复用 Claude Code 的 `sanitizePath` 思路
   （非字母数字 → `-`，超长截断 200 字符 + hash 后缀）。直接消除跨项目续错会话。
2. **文件权限 `0o600`** + 目录 `0o700`：会话含明文 prompt 与文件内容，权限已收紧。

### P1 · 下一版做（为 /clear 与更精细恢复铺路）—— 部分已做（0.8.1）

3. **引入 `uuid` + `parentUuid` 字段**：**不做**（V8 拍板）——run-agent 恢复不需要对链做手术；
   `subagent-` 前缀过滤已止血 `--resume` 误选。
4. **加 `last-prompt` 指针记录**：**不做**（V8 拍板）——「找最新」仍用文件名字典序；`/clear` 指针机制顺延 V8 后。
5. **落一条元数据记录**（`model`/`provider`/`version`）：✅ **V8 已做**——会话首行 `{ ts, meta }`，
   resume 可知上次配置、`--list` 只读首行即得列表元数据（未存 usage/token 用量）。

### P2 · 长期（性能工程，出现长会话卡顿再上）—— compact 已做，其余未做

6. **批量写队列**：100ms 合并 + 退出时 `flush()`，避免逐条 fsync。
7. **渐进式读取**：resume 列表只读头尾 64KB；加载用流式分块；设 `MAX_TRANSCRIPT_READ_BYTES` 防 OOM。
   部分已做：`--list` 每文件只读头 8192B（`listSessions`）。
8. ~~**compact**~~ ✅ 已做（V3）：内联哨兵边界 + 摘要 + 文件重挂，append-only 不截断；另含反应式压缩 +
   硬截断 + 孤儿 tool 修复兜底。

> 与初稿一致的判断：P2 其余条目是为「单文件多个 GB + 几十万条消息」做的工程，run-agent 还远未到这一步。

---

## 5. V8 会话持久化 + 会话切换落地设计（2026-08-13 讨论拍板）

> 状态：**已实现（0.8.1，2026-08-13）**。本节记录 V8 系统能力完善中「消息持久化 + 会话切换」的完整设计，
> 全部按设计落地（实现见 §1.1/§1.3/§1.9 与 `src/`）。用户拍板要点：会话切换（看历史 + 自主选择切入）
> **从 V9 桶挪到 V8**；列表预览用**首条 prompt 截断**（A 方案）；交互选择走 **promptSelect 方向键菜单**
> （路径 A，落地 select-ui-plan.md 基建）。V9 不再含会话切换条目。

### 5.1 范围与归属

| 项 | 归属 | 说明 |
| ---- | ----- | ---- |
| 按 cwd 分目录 + 权限收紧 | **V8** | 修跨项目串会话 bug，存储层可靠性 |
| 首行元数据记录 | **V8** | resume 可知 model/provider，列表数据源 |
| `--list` + `--resume <id>` | **V8** | 看历史 + 指定切入（CLI 最简版） |
| promptSelect 基建（keypress/select） | **V8** | 会话选择方向键菜单的依赖，顺带升级权限/Trust 确认 |
| REPL `/sessions` 交互切换 | **V8** | 类似 CC `/resume` |
| AI 生成标题（B 方案） | V9 | 需额外 LLM 调用，成本翻倍 |
| uuid/parentUuid 图 | **不做** | run-agent 恢复不需要对链做手术 |
| 批量写 / 渐进读（P2 其余） | **不做** | 会话体量远未到 GB 级 |
| `/clear` 指针机制 | V8 后 | 现有「只清内存不清盘」保持文档注明；与 V9 会话管理一起做 |

### 5.2 存储层改造（`src/utils/sessionStorage.ts`）

**① 按 cwd 分目录**（P0#1）
- `sessionsDir(cwd)`：`~/.local/share/run-agent/sessions/<sanitized-cwd>/`，`sanitizePath` 复用 CC 思路
  （`sessionStoragePortable.ts:293-319`）：非字母数字 → `-`，超长路径截断 200 字符 + hash 后缀保唯一。
- 调用点：`src/cli/index.ts:343/349`（`latestSessionFile`/`createSessionFile`）传 cwd；`transcriptDir`
  （`index.ts:406`）与 `resultsDir`（`compact.ts:47-58`）跟随新会话目录，子 agent transcript / `r<N>.txt`
  落盘结果同目录不变。
- **旧文件不迁移**：旧文件未存 cwd、无从对应；留在 `sessions/` 平铺根作为历史遗留，新会话走新目录。

**② 首行元数据记录**（P1#5 简化版）
- 会话第 1 行 `{ ts, meta: { cwd, model, provider, version } }`，第 2 行起为 `{ ts, message }` 消息行
  （`SessionRecord` 加可选 `meta`；`createSessionFile` 建文件即写首行；`loadSession` 遇 `meta` 行跳过）。
- resume 时可读上次 model/provider；`--list` 只读第 1 行即得列表元数据。

**③ 权限收紧**（P0#2）：`ensureDir` 的 `mkdir` 用 `{ mode: 0o700 }`，`appendFile` 用 `{ mode: 0o600 }`
（Node 的 mode 只对新文件生效，既有文件不变，天然满足）。

### 5.3 会话列表 + 切换

**④ `--list`**：readdir 当前 cwd 的会话目录，每文件**只读前 2 行**（渐进式，几十个会话几十次小读）：
```
<id>  <model>  <时间>  <首条 prompt 截断 60 字符>
```
预览 = 第 2 行首条用户 prompt 截断；排序按文件名字典序倒序（时间戳在文件名里，天然时间序）。
`<时间>` 列经 `sessionIdTime(id)` 显示为**本地时区**（跟随系统时区，地区自适应），文件名字戳仍 UTC。

**⑤ `--resume <id>`**：按 id 定位会话文件（`sessions/<cwd>/<id>.jsonl`）→ `loadSession` 切入，
替代现有 `latestSessionFile`「只续最新」。id 取文件名 `<ts>-<id>` 全串（唯一、可复制）。

**⑥ REPL `/sessions`**：列出当前项目会话 → `promptSelect` 方向键菜单选择 → 切入 =
加载目标会话替换当前 `messages` + 更新 `sessionFile` 指针（后续 `appendMessage` 写新会话）。

### 5.4 promptSelect 基建（select-ui-plan.md 落地）

- `src/ui/keypress.ts`：`parseKeypress` 纯函数（ANSI 序列 → `KeyEvent`：up/down/enter/escape/char），
  可单测；同 CC 注册表思想提供 `isPreviousKey/isNextKey/isAcceptKey/isCancelKey` 判词。
- `src/ui/select.ts`：`promptSelect<T>(options, { rl })` 通用方向键菜单——`rl.pause()` + 临时移除 line 监听
  （readline 完全静音）→ 收集 → 恢复 `rl.resume()` + 还原 line 监听；焦点移动做成纯函数 `nextFocus`
  （越界回绕、跳过 disabled）。**stdin 唯一所有权是铁律**（select-ui-plan §2.4）：`rl` 由 REPL 注入，
  全程单一读者。`input` 缺省回退 `rl.input`（显式 `input` 优先），保证 REPL 注入流不被漏听。
- 接入：`resolveAsk`（权限确认 `[y/n/a]` → 三项菜单）+ `askTrustProject`（两项菜单）+ `/sessions`。

### 5.5 依赖顺序与验证

实现顺序：**存储层(①②③) → 列表(④⑤) → promptSelect(⑦⑧) → /sessions(⑥ + 接入)**。

验证（**已完成，0.8.1**）：`sessionStorage.test.ts` 15 用例（sanitizePath/sessionsDir/meta 行/listSessions/
findSessionFile）+ `keypress.test.ts` 12 用例 + `select.test.ts` 13 用例 + repl 粘贴/弹窗回归 ——
typecheck + lint + **560 用例全绿**（verify 工具移除后 52 文件）；待 CI 三 OS × Node 20/22/24 全绿 + 真实模型手动验证（需 key）。

---

## 6. 参考资料

- run-agent 侧（当前实现）：
  - `src/utils/sessionStorage.ts`（存储/读/写）
  - `src/cli/repl.ts`（`runOneShot`/`runTurn` 的 added 持久化、`/clear`、`/compact`）
  - `src/cli/index.ts`（会话创建/续接、`resultsDir`/`transcriptDir` 指向）
  - `src/core/query.ts`（`pushConversation`、compact 边界与 pollExternal 走 added）
  - `src/core/compact.ts`（哨兵、边界消息、文件重挂、落盘指针、硬截断/孤儿修复）
  - `src/core/run_agent.ts`（子 agent transcript 写入）
  - `src/services/agents/team/registry.ts`（`subagent-<id>.jsonl` 命名）
- Claude Code 源码（研究用途，2.1.88）：`F:\CC_Source\claude-code-sourcemap\restored-src\src\utils\sessionStorage.ts`
  `sessionStoragePortable.ts` `sessionRestore.ts`，以及 `services/compact/`、`utils/listSessionsImpl.ts`
- 官方文档：Claude Code `.claude` 目录说明（code.claude.com/docs/en/claude-directory）
- 本机实测：`~/.claude/projects/F--MyClaudeCode/*.jsonl`（CLI 2.1.227）
