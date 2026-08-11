# 会话持久化：run-agent V1 现状 vs Claude Code 方案

> 目的：记录 run-agent V1 会话持久化的实现与评估，并以 Claude Code 的真实实现（源码级核实）为参照，
> 给出 V3 及以后的改进建议。
>
> 核实来源：`F:\CC_Source\claude-code-sourcemap\`（@anthropic-ai/claude-code 2.1.88 的 npm sourcemap 还原源码，
> 非官方、仅供研究），并交叉核对本机 `~/.claude/projects/` 下真实 transcript（CLI 2.1.227）。
> run-agent 侧代码以当前 `src/` 为准。

---

## 0. 一句话结论

- **run-agent V1 = 消息数组的持久化**：写入是序列化消息数组的增量，读取是拼回数组。69 行、零依赖、够用。
- **Claude Code = 持久化日志里的图**：每行一个带 `uuid`/`parentUuid` 的 Entry 节点，读取按链重建、按语义剪枝。
  因此它能支撑 compact、snip、rewind、fork、子代理 sidechain、Edit 回滚——这些都是"对图做变换"。
- **给 run-agent 的实践建议（按性价比）**：① 立刻做——会话按 cwd 分目录 + 文件 `0o600`；② 下一版做——
  引入 `uuid`/`parentUuid` 字段 + `last-prompt` 指针；③ 长期再考虑——批量写队列、渐进式读取。

---

## 1. run-agent V1 现状

### 1.1 实现

核心文件：`src/utils/sessionStorage.ts`（69 行，自 v0.1.0 起未变，V2 未改动此层）。

| 要素 | 实现 |
|---|---|
| 存储位置 | `~/.local/share/run-agent/sessions/`（基于 `homedir()`） |
| 文件命名 | `<ISO时间戳去冒号点>-<6位随机base36>.jsonl` |
| 单行格式 | `{ ts, message: LLMMessage }`，逐行 `appendFile` 追加 |
| 读取 | `loadSession()` 逐行 `JSON.parse` 重建消息数组，坏行 `try/catch` 跳过 |
| resume | `latestSessionFile()` 按文件名字典序倒序取最新 → `loadSession` 回放 messages |

写入时机（`src/cli/repl.ts`）：用户 prompt 先追加一行，`runQuery` 跑完后把本轮新增消息 `result.messages.slice(before)` 逐条追加。

### 1.2 评估

**做对的：**

- **持久化内部统一格式 `LLMMessage`**（含 `tool_use`/`tool_result` block），resume 回放零格式转换、无损，切 provider 也续得上——这是整套方案最聪明的一笔。
- **append-only 日志模型**：追加 O(1)、抗崩溃、无需锁/事务，适配 agent loop 连续写多条的模式。
- **时间戳进文件名**：让"找最新会话"退化成一次字典序排序，零 IO 成本，顺带解决 Windows 路径合法性。
- **坏行容错**：单行损坏不拖垮整个 resume。

**短板（按严重程度）：**

| 短板 | 后果 |
|---|---|
| `/clear` 只清内存不清盘 | 清空后 `--resume` 旧历史原样回来，清空语义被打破 |
| 无会话元数据 | 没存模型/provider/项目路径/版本/token 用量；resume 沿用旧上下文却不知道当初的配置 |
| 无 compact/摘要 | 长会话全量重放，token 线性膨胀，迟早撞 `maxTokens` |
| 坏行"吞错"而非告警 | 跳过一行 `tool_result` 可能让后续 `tool_use` 回放对不上，静默失败 |
| `--resume` 只能续最新 | 不能指定历史会话，会话文件的唯一 id 未暴露 |
| 全局平铺、跨项目串会话 | 两个项目的会话混在一个目录，`--resume` 只认全局最新 |
| 字典序==时间序假设脆弱 | 依赖文件名等长且前缀不变，结构一改就静默出错 |
| 无并发保护 | 两进程同时 resume 同一文件会交错追加 |

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
  + 一条 `isCompactSummary: true` 的 `user` 摘要消息。旧内容留在盘上，摘要里还会指明回读完整 transcript 的路径。
- resume 时用 `compactMetadata.preservedSegment` 重建有效链，物理上在 boundary 之前的非保留消息被剪掉。

---

## 3. 逐项对比

| 维度 | run-agent V1 | Claude Code |
|---|---|---|
| 目录结构 | 全局平铺 `sessions/` | `projects/<sanitized-cwd>/`，按项目隔离 |
| 文件名 | `<时间戳>-<id>.jsonl` | `<uuid>.jsonl`（uuid==sessionId） |
| 行粒度 | 一条 LLMMessage | 一个 Entry 记录（assistant 回合多行 + 控制记录） |
| 消息身份 | 无 | 每条 `uuid` + `parentUuid` 链 |
| 每行元数据 | 无 | `sessionId/cwd/version/gitBranch/slug/model/usage…` 全量 |
| 找最新/续接 | 文件名字典序 | `last-prompt.leafUuid` 指针 + mtime |
| 写路径 | 逐条 `appendFile` | 100ms 批量队列 + `0o600` + 退出 flush + 元数据重写 |
| 读路径 | 整文件逐行 | 64KB 头尾渐进 + 1MB 流式加载 |
| compact | 无（排到 V3） | 内联 boundary + summary，append-only 不截断 |
| 恢复范围 | 消息数组 | 完整 AppState（agent/model/worktree/文件历史/attribution/todos） |
| 坏数据 | 坏行跳过（吞错） | 按 uuid 去重 + 链手术（relink/snip） |
| 模型 | 消息日志 | 状态存储（图） |

---

## 4. V3+ 改进建议（按性价比）

### P0 · 立刻做（几行改动，高回报）

1. **会话按 cwd 分目录**：`~/.local/share/run-agent/sessions/<sanitized-cwd>/<id>.jsonl`，
   复用 Claude Code 的 `sanitizePath` 思路（非字母数字 → `-`，超 200 字符加 hash）。直接消除跨项目续错会话。
2. **文件权限 `0o600`**（`mkdir` 目录 `0o700`）：会话含明文 prompt 与文件内容，默认权限应收紧。

### P1 · 下一版做（为 /clear 与 compact 铺路）

3. **引入 `uuid` + `parentUuid` 字段**：先不建完整链重建，只给消息加身份，让 compact 有挂靠点。
4. **加 `last-prompt` 指针记录**：把"找最新"从文件名排序改成显式指针，同时给 `/clear` 正确定义空间
   （清内存 + 更新指针，而非让 resume 回放全量）。
5. **落一条元数据记录**（`model`/`provider`/`usage`）：resume 时能知道上次的配置与成本。

### P2 · 长期（性能工程，出现长会话卡顿再上）

6. **批量写队列**：100ms 合并 + 退出时 `flush()`，避免逐条 fsync。
7. **渐进式读取**：resume 列表只读头尾 64KB；加载用流式分块；设 `MAX_TRANSCRIPT_READ_BYTES` 防 OOM。
8. **compact**：内联 `compact_boundary` + `isCompactSummary` 摘要，append-only 不截断。

> 不建议 P2 现在就做：这些是为"单文件多个 GB + 几十万条消息"做的工程，run-agent 69 行零依赖还远未到这一步。

---

## 5. 参考资料

- run-agent 侧：`src/utils/sessionStorage.ts`、`src/cli/repl.ts`、`src/cli/index.ts`（v0.1.0 起未变）
- Claude Code 源码（研究用途，2.1.88）：`F:\CC_Source\claude-code-sourcemap\restored-src\src\utils\sessionStorage.ts`
  `sessionStoragePortable.ts` `sessionRestore.ts`，以及 `services/compact/`、`utils/listSessionsImpl.ts`
- 官方文档：Claude Code `.claude` 目录说明（code.claude.com/docs/en/claude-directory）
- 本机实测：`~/.claude/projects/F--MyClaudeCode/*.jsonl`（CLI 2.1.227）
