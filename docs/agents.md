# 多 Agent 编排（0.7.0）

V7 引入子 agent 编排：主 agent 用 **`agent` 工具**把任务委派给 specialist，后台任务支持
**`send_message`**（运行中补充信息）与 **`task_stop`**（止损）。`--coordinator` 让主 agent 显式
扮演协调者——把跨模块任务拆成可并行的子任务、收齐后核对汇总。

---

## 内置 agent 类型

| 类型              | 说明                                                                              |
| ----------------- | --------------------------------------------------------------------------------- |
| `general-purpose` | 通用 worker：继承父级全部工具（**不含** `agent`/`send_message`/`task_stop`，防递归失控） |
| `explore`         | 只读探索：仅 `repo_map`/`glob`/`grep`/`read_file`，`maxIterations=12`（0.4.1 迁移，0.7.2 上调） |
| `verification`    | （0.7.1）证据式验证专家：只读 + `run_bash`（safe 自动放行 / 项目写 deny / `/tmp` 放行），出具带命令证据的 `VERDICT: PASS|FAIL|PARTIAL`，`maxIterations=12` |

**三件套只装配主 agent**：`agent`/`send_message`/`task_stop` 三个协调原语不会出现在子 agent 的
工具池里——worker 无协调权，模型无法无限递归派发子 agent（`CORE_TEAM_TOOLS`）。

## 自定义类型（frontmatter）

`.run-agent/agents/<name>.md`（**仅 Trust 项目**加载）或 `~/.config/run-agent/agents/<name>.md`
（用户级，始终加载），frontmatter + body（body 并入子 system，作为类型专属指令）：

```markdown
---
name: qa
description: 代码审查
model: claude-sonnet-5          # 类型级 model 覆盖（可选）
maxIterations: 6                # 子查询轮数上限（可选）
tools:                          # 显式白名单（可选）
  - read_file
  - grep
system: 你是 QA 审查员。         # system 片段（可选，与 body 一起并入子 system）
---
专注找 bug，逐条报 file:line 与证据。
```

- **tools 显式声明** → 子查询只用声明的工具；**缺省** → 父级全部工具（不含三件套）。
- **同名去重**：内置 > 用户级 > 项目级；非法 frontmatter 记入启动告警（跳过不阻断）。
- **model 优先级**：`agent` 调用参数 > 类型 frontmatter > 继承父级。

> `extractMemories` 是**系统内部类型**（0.7.1 后台记忆提取用，见 [docs/memory.md](memory.md)），不进主 agent 可 spawn 的清单——它由 REPL 轮末引擎直接以 `runAgent` 驱动，不入后台任务汇总。

## `agent` 工具

```
agent { description, prompt, agentType?, model?, run_in_background? }
```

- 前台（默认）：阻塞等待子 agent 结束，返回 `[<类型> 结论]` + reply。
- 后台（`run_in_background: true`）：立即返回 `task-<n>` 占位，本轮结束由主循环
  `awaitAll` 收集——每个后台任务独立 transcript `subagent-<n>.jsonl`（同会话目录）。
- **`agentType` 取值直接可见**：工具描述在创建时从 registry 动态列出全部可委派类型
  （内置 + 自定义），模型无需去文件系统搜 `.run-agent/agents/`（对搜索工具不可见）或
  试图创建类型文件（写 `.run-agent/` 被引擎硬拒）。新增自定义类型后重启即出现在描述里。

**权限继承**：子 agent 沿用父级 `checkPermission`（用户 deny 规则、内置 deny 底线全部生效），
子 agent 永远不能获得超过父级的权限。**后台任务永不弹窗**：子查询里权限 `ask` 一律降级
`deny`（后台轮末汇总时 REPL 不空闲，弹窗会死锁）。**前台子 agent 的权限弹窗带来源标签**：
agent 工具在继承父级 `checkPermission` 时包一层注入 `子 agent: <类型>`，弹窗文本前缀
`[子 agent: general-purpose] 允许 …?`——一眼分辨请求来自子 agent；主循环请求不带标签。
类型级专门权限策略（如 verification）不受影响、永不 ask。

**预算提示 + 收尾轮（0.7.2）**：`runQuery` 会把迭代轮数上限注入 system（`## 迭代预算` 段，
数值随类型 `maxIterations` 变化）——子 agent 知道自己有多少轮，会主动规划收尾（模型知情，
不会被看不见的轮数墙硬切）。收尾轮兜底：撞顶时若最后一轮仍以 `tool_use` 收尾（或
`max_tokens`/`error` 被截断、空 completion 重试耗尽），注入「请给出最终结论」指令并
**清空工具**再流一轮（有界，只多一轮），保证 `reply` 是真正的结论而非半截话。子 agent
因此总能拿到一个可用于汇总的结论。

## 协调者三件套

| 工具           | 用途                                                       | 语义                                                            |
| -------------- | ---------------------------------------------------------- | --------------------------------------------------------------- |
| `agent`        | 委派子任务（前台阻塞 / 后台可寻址）                         | 见上                                                            |
| `send_message` | 向运行中的后台子 agent 注入一条 user 消息                   | 子查询**迭代边界**送达（非中断，等该轮工具循环结束）              |
| `task_stop`    | 停止后台子 agent                                           | AbortController 传播 → 适配器中断 in-flight 请求 → 保留部分文本，状态 `stopped` |

```markdown
--- 协调者工作流 ---
1. 拆任务：跨模块任务拆成可并行子任务，agent run_in_background=true 并行派发（拿 task_id）。
2. 运行中反馈：补充信息 / 修正需求 → send_message {task_id, message}。
3. 止损：委派错误 / 任务失控 / 需求已变 → task_stop {task_id}。
4. 收尾：收齐后核对每个子任务结论与原始目标，冲突 / 缺口重新委派或自己补上。
```

## 运行方式

```bash
run-agent --coordinator     # 注入协调者 system 段落，进入编排模式
run-agent --coordinator "重构这个模块，拆成可并行任务派发"
run-agent                    # 不加 --coordinator：模型仍可手动调 agent 工具，但无协调者引导
```

交互 REPL 下 `/tasks` 列出后台子 agent（task_id / 类型 / 状态 / prompt 摘要）。headless
`--print` 单轮不装配后台任务列表，但前台 `agent` 工具同样可用。

> 手工验证真模型时,按类型组织的回归测试 prompt 见 [docs/testing-queries.md](testing-queries.md)。

## 与 Skills / Hooks 的关系

- **Skills** 是「预写工作流」，激活后改变**本 turn** 的工具集；**agent 类型**是「子 agent 的
  工具集与 system」——一个控制主循环行为，一个定义委派目标，正交。
- **Hooks** 的 `PreToolUse` 对 `agent`/`send_message`/`task_stop` 同样触发（它们也是普通工具，
  无文件副作用，归内置只读免确认）。
