# Bug 记录 · V3「记忆与上下文管理」

> 阶段：2026-08-11 ｜ 交付：`0.3.0` + `0.3.1` + `0.3.2`（CLAUDE.md 四级记忆 + 压缩 + remember 工具，166 测试）
> 来源：会话记录、git 提交 `99d97d3`。**V3-1 是 V1 遗留的核心连续性 bug；V3-2 是安全特性不完整；V3-3 是 0.3.1 硬截断引入的数据完整性问题。** 均已解决。

| #    | Bug                                                                          | 类别              | 严重度  | 状态      |
| ---- | ---------------------------------------------------------------------------- | ----------------- | ------- | --------- |
| V3-1 | REPL 跨轮只喂 user 消息——assistant/tool 历史丢失                             | 会话连续性        | 🔴 严重 | ✅ 已解决 |
| V3-2 | `run_bash` 引用 `.run-agent` 绕过只读收口（路径工具已 deny）                 | 权限/安全         | 🟠 高   | ✅ 已解决 |
| V3-3 | 硬截断后产生孤儿 tool 消息（无配对 tool_use/tool_result）                    | 上下文/数据完整性 | 🟠 高   | ✅ 已解决 |
| V3-4 | README / usage.md DeepSeek key 示例误导（openai-compatible 无默认 key 变量） | 文档              | 🟡 中   | ✅ 已解决 |

---

## 会话连续性：REPL 跨轮只喂 user 消息（V3-1，最严重）

- **现象**：REPL 里跑完一轮后，下一轮发给模型的**只有 user 消息**——assistant 的推理、`tool_use`、`tool_result` 全丢了，agent 在新一轮变成"失忆"。
- **根因**（V1 遗留）：`repl.ts` 每轮用 `result.messages.slice(before)` 持久化增量，且**不把自己的 `messages` 替换成 `result.messages`**——内存里只有自己 push 的那条 user 消息，跨轮历史自然只剩 user。compact 一旦重建消息数组，`slice(before)` 更是必然错位。
- **修复**（0.3.0 M1）：持久化契约改为 `added`——`runQuery` 内部统一经 `pushConversation(m)` 同时进 `messages` 与 `added`；调用方 `messages = result.messages`（数组替换）+ 逐条持久化 `result.added`。compact 边界消息也进 `added`，`--resume` 从摘要续起。
- **教训**：持久化增量必须和"真正新增了哪些消息"同源；消息数组一旦可能被整体重建，`slice(before)` 这类"位置差"持久化就不可靠。**契约化（`added`）比位置差安全。**

---

## 安全特性不完整：`run_bash` 绕过 `.run-agent` 只读收口（V3-2）

- **现象**：`read_file` / `write_file` / `edit_file` / `glob` / `grep` 的目标含 `.run-agent` 路径段时**已被内置 deny**，但 `run_bash` 的命令文本里引用 `.run-agent` **不受此限制**——agent 可在用户批准下经 shell 读写记忆文件（`.run-agent/CLAUDE.md`、`.run-agent/permissions.json`），与文档宣称的"记忆目录对 agent 完全只读"不符。
- **根因**：路径 deny（`DENY_DIR_SEGMENTS`）走 `inputPath()`——只从工具的 `file_path` / `path` / `cwd` 取路径；`run_bash` 的入参是 `{ command }`，没有路径字段，天然绕过了路径段检查。
- **修复**（0.3.1，方案 A）：`deniedByDefault` 对 `run_bash` 额外做命令文本匹配——`AGENT_DIR_BASH_RE`（`(?<=^|[\s\\/'"\`=(;|&])\.run-agent(?![\w-])`）命中即 deny。只收 `.run-agent`，不误伤 `.git`/`.claude`/ 相似目录名（如`.run-agent-backup`）。
- **教训**：路径类安全收口不能只看"工具参数里有路径字段的工具"——凡是能间接触达文件系统的通道（shell 命令、命令拼接、环境变量）都要单独过一遍同一份 deny 语义。**安全边界按"能力"而非"工具"来审计。**

---

## 数据完整性：硬截断产生孤儿 tool 消息（V3-3）

- **现象**：0.3.1 的反应式压缩之后仍超长时，`hardTruncateToFit` 反复丢最老消息直到 fit——但可能丢掉一条 `tool_use`（其 `tool_result` 还留在上下文里），或丢掉 `tool_result`（其 `tool_use` 还留在上下文里）。这类**孤儿消息**违反 API 的配对约束，会导致后续请求被模型侧拒绝。
- **根因**：硬截断是按"消息级别"丢弃最老消息，不理解 `tool_use`/`tool_result` 的配对关系。
- **修复**（0.3.1）：硬截断后接 `normalizeToolPairing`——没有对应 `tool_use` 的 `tool` 结果消息直接丢弃；没有后续 `tool_result` 的 `tool_use` 块从 assistant 消息里清掉（纯块消息整条丢弃，带文本的保留文本）。裁不动（只剩 1 条仍超长）才抛原错误，有界退出不循环。
- **教训**：任何"丢弃/截断历史"的逻辑都必须先想清楚消息间的引用关系；压缩路径保证整段摘要不撕裂配对，硬截断兜底则必须显式修复。

---

## 文档误导：DeepSeek key 示例（V3-4）

- **现象**：README / usage.md 里 openai-compatible（DeepSeek）的配置示例暗示"设置 `DEEPSEEK_API_KEY` 环境变量即可"，但实际 `DEFAULT_API_KEY_ENV["openai-compatible"] === undefined`——该 provider **没有**默认 key 环境变量，只设 `DEEPSEEK_API_KEY` 不会生效，用户会拿到"未提供 API key"的困惑报错。
- **根因**：示例沿用 anthropic/openai 的"默认 key 变量"心智，但 openai-compatible 是任意 base-url 的通用通道，无法预设 key 变量名。
- **修复**：README / usage.md 改为明确要求 `--api-key` / `apiKeyEnv`（如 `RUN_AGENT_API_KEY_ENV=DEEPSEEK_API_KEY`）/ config.json 三者之一显式指明。
- **教训**：文档示例必须和代码的默认值映射逐条核对，尤其是"通用通道"（openai-compatible/ollama）这类无默认配置的分支。

---

## 小结

- **真 bug 4 个**：1 个 V1 遗留的会话连续性缺陷（V3-1，0.3.0 修复）、1 个安全收口缺口（V3-2，0.3.1 修复）、1 个硬截断的数据完整性问题（V3-3，0.3.1 修复）、1 个文档误导（V3-4，0.3.0 期间修复）。
- **共性教训**：① 持久化要"契约化"而不是"位置差"；② 安全收口按"能力"审计所有触达通道；③ 所有"丢历史"的代码都要考虑消息配对。
- **非产品 bug（不列入表）**：排查过程中的反斜杠转义伪影（re-check 脚本在 heredoc/JSON 三层转义下丢失 `\`，误报"应拦未拦"；引擎测试正确转义、18/18 全绿——属校验脚本陷阱，非代码缺陷）。
- **V2-11（权限确认多 y 回显）** 的修复包含在 0.3.0 发布物里，但归属 V2，已在 [Bug_V2.md](Bug_V2.md) 记录，此处不重复。
