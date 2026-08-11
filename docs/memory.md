# 记忆系统(V4,0.4.0)

Claude Code 式主动记忆:`<cwd>/.run-agent/memory/` 下每条记忆一个独立 md 文件(frontmatter `name`/`description`/`type` + 正文),`MEMORY.md` 索引页常驻 system 稳定段,模型按需读全文。目标是跨会话保留稳定结论,不追求检索精度——判断相关性靠索引钩子 + 模型 `read_file`/`grep` 兜底。

## 存储布局

```
.run-agent/memory/
├── MEMORY.md                      # 索引页,常驻 system;每行一条,无 frontmatter
│   - [Feedback: 测试入口](feedback_testing.md) — npm test 是唯一测试入口
│   - [用户工作方式](user_workspace.md) — Windows + 中文 + prettier
├── feedback_testing.md            # 独立记忆文件,frontmatter + 正文
└── user_workspace.md
```

**索引页 MEMORY.md 上限**:200 行 / 25KB。`remember` 写入前预检,将超限则拒写并提示先 `run-agent memory prune`;CLI 读取时超限截断并在尾部附警告行。

**topic 文件格式**:

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

- `name` 唯一(文件名 slug,未提供时从正文首行自动推导,中文保留);`description` 是判断相关性的依据;`type` 四选一。
- 单文件上限 16KB(超出不注入,`remember` 拒写)。

## 写入:专属 `remember` 工具

- `scope` **默认 `"project"`**——agent 主动沉淀只写项目级 `.run-agent/memory/`,一步完成「写 topic 文件 + 更新索引行」(按 `name` 命中先更新,不重复建文件)。
- `scope="user"` 写用户级 `~/.config/run-agent/CLAUDE.md`(0.3.2 单文件行为保留),**仅在用户明确要求「更新用户记忆」时用**,由 system 指引 + 工具描述约束,不做技术强制。
- 双门控:权限引擎(默认模式下 ask,可被用户规则 deny)+ **Trust**(未信任项目拒绝写项目记忆)。
- 写目标由工具内部计算(cwd 由 CLI 装配注入),不接受入参路径 → 模型无法任意写文件。

## 读取:索引常驻 + 按需读全文

1. system 稳定段注入 `## MEMORY.md` 索引块(仅 Trust 会话,`--bare` 禁用);模型启动即见索引。
2. 判断与当前任务相关 → `read_file` 读对应 `.md` 全文;不确定 → `grep` 记忆目录兜底。
3. **记忆是快照,可能过时**:先对照当前代码/用户最新指示验证,冲突以现状为准,过时就更新或删除旧记忆。

## 内容规范

**条目类型**(frontmatter `type`):

- `user` — 用户的身份、偏好、工作方式。这是内容分类,不代表写入位置——主动沉淀仍落项目级。
- `feedback` — 用户纠正/确认过的工作方式;正文结构「规则 → **Why:** → **How to apply:**」。记录失败也要记录确认过的成功做法,防过度保守。
- `project` — 项目目标、约束、跨会话事实(不能直接从代码/git 看出的);相对日期转绝对日期。
- `reference` — 外部资源指针(URL、文档、ticket、远端仓库)。

**不存什么(WHAT_NOT_TO_SAVE)**:

1. 代码结构/实现细节——源码、README、git 历史里都有,存了必过时;
2. 一次性调试过程与排查方案(已解决的 bug 记进 `docs/Bug_V*.md`);
3. 已在 CLAUDE.md / system prompt 写明的约定;
4. 会话琐事(一次性对话、临时上下文)。

用户明确要求保存清单/摘要类内容时,先问「有什么反直觉/非显而易见的部分」再存。

**何时读(WHEN_TO_ACCESS)**:相关、跨会话续接、用户重提旧话题、或用户明确要求「查记忆/记住」。用户说「忽略记忆」→ 当 MEMORY.md 为空处理,不提、不引用、不对比。

## 生命周期:`run-agent memory` 子命令

用户发起的维护操作,CLI 直读直写,不走工具权限管线:

- `run-agent memory list [query]` — 列出索引条目(扫 title + hook + name);
- `run-agent memory show <name>` — 打印单条完整记忆(frontmatter + 正文);
- `run-agent memory rm <name>` — 删除 topic 文件 + 摘除对应索引行;
- `run-agent memory prune [--days N]` — 删除早于 N 天(默认 30)的 topic 文件 + 摘除索引行。

## 安全边界

- **读豁免(唯一的有意放宽)**:Trust 会话内,`read_file`/`glob`/`grep` 对 `.run-agent/memory/**` 放行(引擎 `isMemoryReadExempt`,判定在内置 deny 之前);其余 `.run-agent` 内容(CLAUDE.md/permissions.json)与 `write_file`/`edit_file`/`run_bash` 命令文本仍全禁。
- **遍历层对齐(0.4.0 已前拉 V4.5 决策 F)**:`glob`/`grep` 的 `ALWAYS_IGNORE` 含 `.run-agent`,整目录扫不会带出记忆;模型读记忆用 `read_file` 或显式 `path=<memoryDir>` 的 grep。
- 未 Trust 项目:豁免不生效,`.run-agent/memory/` 对 agent 完全不可见。
- 写入口只有 `remember`(权限 + Trust 双门控);模型无法用其它工具触碰 `.run-agent`。
- **自注入残余风险**(受信任项目内模型写的记忆可能夹带私货):写入口走权限引擎必问、索引只在 Trust 注入、`prune` 可过期、读到的记忆先验证再采信——可接受范围,与 Claude Code 的 `MEMORY_DRIFT_CAVEAT` 一致。
