# 记忆与上下文管理（0.3.x）

> 路线图 [Plan.md](Plan.md) V3。实现细节与交接见 [Plan_V3.md](Plan_V3.md)。

长任务最怕两件事：**上下文爆掉**（跑着跑着模型忘了开头）和**跨会话失忆**（关掉终端就全忘）。
0.3.0 + 0.3.1 用几招解决：CLAUDE.md 四级记忆、自动/手动/反应式压缩、压缩边界消息续接会话。

---

## 一、CLAUDE.md 四级记忆

模型启动时自动读取并注入 system prompt 的「记忆」，按优先级从高到低拼接、标注来源：

| 级别    | 路径                                    | 注入条件                 |
| ------- | --------------------------------------- | ------------------------ |
| managed | `~/.config/run-agent/CLAUDE.managed.md` | 始终（本版预留，默认空） |
| user    | `~/.config/run-agent/CLAUDE.md`         | 始终（用户自写）         |
| project | `<项目根>/CLAUDE.md`                    | 仅项目受信任（Trust）    |
| local   | `<项目根>/.run-agent/CLAUDE.md`         | 仅项目受信任（Trust）    |

- **Trust 门控**：project / local 级记忆只有项目被信任才注入——防止恶意仓库用 CLAUDE.md 做提示注入。
  user 级是用户自己写的，始终注入。
- **只读直读**：记忆用文件系统直接读取（剥 BOM、≤32KB），不走工具。agent 无法用 `write_file`/`edit_file`
  改 `.run-agent/CLAUDE.md`，`run_bash` 命令里引用 `.run-agent` 路径段同样被内置 deny 收口
  ——记忆目录对 agent 完全只读，这是安全特性。
- **`--bare`**：`run-agent --bare` 禁用全部记忆与动态上下文注入（system 为 undefined，也不插入动态消息）。
- **稳定/动态边界（V8.3）**：system prompt 只保留**字节稳定**部分（角色准则 + CLAUDE.md 记忆 +
  MEMORY.md 索引）；时间戳 / 工作目录 / git / plan 引导 / MCP·skills 清单 / Stop hook 输出等
  **全部动态上下文**由 `buildDynamicContext` 产出，REPL / one-shot 每轮作为独立 user 消息
  （前缀标记 `DYNAMIC_CONTEXT_MARKER`）插在**用户 query 之前**。system 前缀一字节不变 →
  DeepSeek 自动前缀缓存从 token 0 命中；动态块在缓存点之后追加，不影响前缀。动态消息随会话
  持久化，resume 后下一轮自动清理旧快照并插入新的。

### 写入记忆：`remember` 工具（0.3.2）

四级记忆对 agent 是**只读**的（agent 无法用 `write_file`/`edit_file`/`run_bash` 触碰 `.run-agent`）。
想让 agent「记住」某事时，用 `remember` 工具——它把一条事实追加进**用户级**
`~/.config/run-agent/CLAUDE.md`（自动去重、超 32KB 拒绝写入），下次会话即被注入。

- **触发**：用户明确说「记住 xxx」时，agent 用 `remember`；发现值得跨会话保留的稳定结论
  （测试命令、约定、决策）也可主动记。
- **权限**：`remember` 是写类工具，走权限引擎——default 下 ask、`acceptEdits` 下免确认
  （0.4.2 起已无 bypass 模式，旧配置的 `"bypass"` 回退 default 并警告）；one-shot 不弹确认
  一律降级拒绝。用户可用规则 `{ "tool": "remember", "action": "deny" }` 完全禁用。
- **边界**：只写**用户级**，不写 project / local（`.run-agent` 保持只读，这是安全底线）。
  V4「主动记忆」再扩展结构化条目 / 检索 / 生命周期（`run-agent memory` 子命令）。

## 二、token 估算与 contextWindow

`run-agent` 用零依赖启发式估算输入 token：CJK 每字 1 token，其余按 4 字符 1 token。
估算用于决定「该不该压缩」，不追求精确——13k buffer + 可配窗口 + 0.3.1 的反应式兜底保证安全。

**contextWindow**（上下文窗口，token）默认按 provider 映射：

| Provider          | 默认窗口 |
| ----------------- | -------- |
| anthropic         | 200 000  |
| openai            | 128 000  |
| openai-compatible | 128 000  |
| ollama            | 8 192    |

可覆盖：`config.json` 的 `contextWindow` 字段 > `RUN_AGENT_CONTEXT_WINDOW` 环境变量 >
`--context-window <n>` CLI flag（flag 优先）。

**自动压缩阈值**：`max(contextWindow − 13000, ⌊contextWindow × 0.6⌋)`。第二项钳制小窗口
（ollama 8k 时 13k buffer 会溢出成负阈值）。历史估算超阈值且消息数 ≥ 4 时，下一轮请求前自动压缩。

## 三、上下文压缩（compact）

触发方式：

- **自动**：历史估算超阈值，`runQuery` 每轮循环顶自动压缩（摘要请求自身标记 `querySource='compact'`，
  不会递归触发）。
- **手动**：REPL 里输入 `/compact` 立即压缩（历史过短/未超阈值时提示无需压缩）。

**压缩流程**：

1. 把当前对话**整段**（含最新 user 请求）交给同 client 的摘要请求：无工具、流式、`maxTokens≈1000`、
   输入先裁到 `contextWindow − 3000` 防摘要自身爆窗。
2. 产出一条**边界消息**（role=user）：哨兵 `\u0000RUN_AGENT_COMPACT_BOUNDARY\u0000` + 摘要 +
   **已读文件重挂**（最近读过的 ≤5 个 `read_file` 路径，各 ≤2000 行 / 4MB / 非二进制 / 剥 BOM，
   内容重新读回边界消息——压缩后模型仍能「看到」关键文件）。
3. 边界消息成为新上下文的唯一起点，旧历史留在 JSONL 里但被忽略（追加式不变）。

为什么整段摘要、不留尾段：**不会撕裂 tool_use/tool_result 配对**，持久化顺序天然自洽。

**`--resume` 续接**：`loadSession` 扫描会话文件，从**最后一个**含哨兵的边界消息开始返回
（边界消息本身 + 其后所有消息）。无哨兵的旧会话（0.2.0）回退全量加载，行为不变。

> `/clear` 只清内存不落盘：清空后 `--resume` 仍会读到旧会话历史（沿用 V1 语义）。

## 四、超大工具结果指针化（决策 8）

工具结果估算 > 8192 token（`RUN_AGENT_RESULT_SPILL_TOKENS` 可覆盖）时，不再整段塞进消息列表：

- 全文落盘到 session 同目录的 `<sessionDir>/r<n>.txt`；
- 消息列表里只留指针文本：`[结果已写入 <absPath>(共 N 行)。需要全文时用 read_file 读取该路径]`；
- 模型需要细节时自己 `read_file` 读回。

好处：便宜层先挡一刀，大 diff / 大日志不会把上下文快速撑爆，自动压缩触发频率随之降低。
落盘文件随 session 保留（单文件 ≤ ~4MB），可手动清理。

## 五、REPL 跨轮连续性 + `added` 契约

修复了 V1 遗留 bug：REPL 之前每轮只用 `result.messages.slice(before)` 持久化、且不替换自己的
消息数组——导致跨轮只把 user 消息喂给模型。现在：

- `runQuery` 内部统一经 `pushConversation(m)`（同时进 `messages` 与 `added`），compact 边界消息
  也进 `added`；
- REPL / one-shot 改为 `messages = result.messages` + 逐条持久化 `result.added`。

效果：REPL 跨轮历史包含 assistant/tool 消息（连续性回归），压缩后 `--resume` 从摘要续起。

## 六、0.3.1 反应式压缩 + 硬截断兜底

估算 + 13k buffer 覆盖绝大多数情况，但模型有自己的 token 计算方式，可能比你的估算更早爆窗。
0.3.1 把「模型说超长」当一等事件处理：

**反应式压缩**：流式请求捕获到上下文超长错误（Anthropic `type=prompt_too_long`、OpenAI
`code=context_length_exceeded`、或消息正则）时，在流式请求的 catch 分支**强制压缩**
（`force: true` 忽略估算阈值——模型已经说不下了）→ 摘要请求 → 边界消息 → 重置增量后重试。
每轮至多恢复一次：`reactiveStage` 守卫（0=未反应 → 1=已压缩 → 2=已截断 → 再超长则抛原错误），
绝不无限循环。

**硬截断兜底**：强制压缩后仍超长（比如窗口小到连边界消息都装不下）→ `hardTruncateToFit`
反复丢最老消息直到 fit；随后 `normalizeToolPairing` 修复硬截断产生的孤儿 tool 消息：

- 没有对应 `tool_use` 的 `tool` 结果消息 → 丢弃；
- 没有后续 `tool_result` 的 `tool_use` 块 → 从 assistant 消息里清掉（纯块消息整条丢弃，
  带文本的保留文本）。

裁不动（只剩 1 条仍超长）才把原错误抛给上层——有界退出，不会死循环。

未配 `contextWindow` 时不做反应式压缩（没有压缩目标），直接抛原错误。
