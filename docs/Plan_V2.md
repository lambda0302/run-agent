# Run Agent · V2「安全与并发 + Trust」实施方案

> 上游总计划：`Plan.md`（§五 V2 章节 + §六 决策 4/7 + 附版本节奏表）
> V1 交接：`docs/Plan_V1.md` §7（权限管线占位 / `isConcurrencySafe` / 错误恢复 / SECURITY.md 新增）
> 目标：**agent 变得可信任、可并行**，交付对外 release `0.2.0`。
> 工期参考：2 周 ｜ 里程碑拆 3 个（M1 权限引擎 / M2 工具并发 / M3 错误重试 + 安全交付物 + 发布）

---

## 0. 结论速览

**交付什么**：`npm install -g run-agent@0.2.0` 后——

1. **危险命令被拦截、未授权不改文件**：权限模式 `default` / `acceptEdits` / `bypass`，规则级 allow/ask/deny，`.git/`、`rm -rf`、`npm publish` 等有内置底线；
2. **只读并行、写串行**：一次多文件编辑时 `read_file`/`glob`/`grep` 并行跑，`write_file`/`edit_file`/`run_bash` 按序执行，结果回填顺序与调用一致；
3. **首次 Trust 对话**：不信任的项目不加载其配置（防提示注入），`trust` 子命令管理；
4. **错误可自愈**：流式 transient 错误指数退避重试；工具异常结构化回填让模型自我修正；max_tokens 截断续跑。

**技术栈增量**：**零新增运行时依赖**——权限引擎、并发调度、危险命令分类全部手写（延续 V1「少依赖」原则）。

**不做的事**（留给后续版本）：Plan 模式（V5）、MCP（V5）、StreamingToolExecutor（V5，本次是它的前身）、Hooks/Skills（V6）。

---

## 1. 架构决策（V1 交接 → V2 落地）

### 1.1 权限引擎 `src/permissions/`（零依赖，纯函数 + 持久化）

```ts
type PermissionMode = "default" | "acceptEdits" | "bypass";
type Decision = "allow" | "ask" | "deny";

type PermissionRule = {
  tool?: string;      // 工具名精确匹配，如 "run_bash" / "edit_file" / "*"
  path?: string;      // glob，作用于 file_path / cwd（路径先 path.normalize）
  command?: string;   // 正则，作用于 run_bash 的 command 字段
  action: Decision;
};
```

- **逐级短路** `hasPermissionsToUseTool(tool, input, mode): Promise<Decision>`（对齐 Claude Code 的 `hasPermissionsToUseTool`）：
  1. `mode === "bypass"` → `allow`（`--dangerously-skip-permissions`）；
  2. **内置安全底线**（硬编码 deny）：路径命中 `.git/`、`.claude/`、`.run-agent/`；命令分类为 `dangerous`；
  3. **用户规则**（`~/.config/run-agent/permissions.json` 的 `rules`，**按声明顺序首条命中短路**）；
  4. **兜底按 mode**：`default` → 只读工具 allow，写/改/bash `ask`；`acceptEdits` → 写/改 allow，bash 仍 `ask`。
- **`ask` 的无 TTY 降级**：one-shot 管道（非交互）时 `ask` 自动降级为 **deny + 明确报错**，绝不挂起等待——CLI 可用性底线。
- **危险命令分类** `classifyBashCommand(cmd): "safe" | "risky" | "dangerous"`：`dangerous` 内置于 deny（`rm -rf /`、`mkfs`、`dd of=/dev/`、`git push --force`、`npm publish`、shell 重定向覆盖系统路径等）；`risky`（`rm -rf <具体路径>`、`sudo`、管道 `|`、重定向 `>`）在 `default` 下 `ask`。
- 规则覆盖一切：即使命令命中内置 deny 清单，用户**显式规则**仍可放行/拦截（内置底线优先于规则，规则优先于兜底；`bypass` 在规则之上）。

### 1.2 Trust 对话（防提示注入的信任边界）

- `~/.config/run-agent/trust.json`：`{ "trustedProjects": string[] }`（绝对路径）。
- **首次在未信任目录运行**：TTY 内询问「是否信任此项目？」；`--trust` flag 或 `trust` 子命令跳过/追加；无 TTY 时默认**不信任**（只加载用户级规则）。
- 信任状态决定是否加载**项目级**配置（`.run-agent/permissions.json`）。V6 的 Hooks 同样挂在 trust 边界下。不信任 → 只读 `cwd` 之外的敏感操作一律拒绝。
- `trust` 子命令：`run-agent trust list | add <path> | remove <path>`。

### 1.3 工具并发 `src/core/execute.ts`（纯函数调度）

```ts
function partitionToolCalls(calls: ToolUseBlock[]): {
  concurrent: ToolUseBlock[]; // isConcurrencySafe === true → 可并行
  serial: ToolUseBlock[];     // 其余 → 按序执行
}
async function executeTools(calls, tools, hooks): Promise<string[]> // 返回按原始顺序的 result[]
```

- **标注**：`read_file` / `glob` / `grep` → `isConcurrencySafe: true`（显式）；`write_file` / `edit_file` / `run_bash` → `isConcurrencySafe: false`。注意 V1 接口注释说默认 true，**写类工具必须显式标 false**，这是并发安全的关键。
- **执行策略**：并发批 `Promise.all` + 信号量封顶 `MAX_CONCURRENCY = 10`；串行批按原顺序逐个 await。
- **结果重排（最容易写错处，单测重点）**：所有 tool_result 必须按**原始 tool_calls 顺序**回填——并发执行完要按 `id`/索引重排，否则模型分不清结果对应哪个调用。
- **异常捕获**：沿用 V1 结构（`工具执行错误: <message>`），V2 升级为结构化字段（错误类型 + stderr 摘录）回填 tool_result，便于模型自愈。

### 1.4 错误重试（V1 已有雏形，V2 固化 + 强化）

- **流式请求重试**：`stream()` 抛 transient 错误（HTTP 429 / 5xx / 网络）时，指数退避重试 `maxRetries` 次（默认 2，`RUN_AGENT_MAX_RETRIES` 可配）。非 transient（校验失败、授权失败）不重试。
- **工具重试**：保留 V1 语义「异常回填 tool_result 让模型决定」，不自动重跑副作用工具（写/bash 重跑有风险）。
- **max_output_tokens 恢复**：保留 V1 的「输出被截断，请继续完成当前任务」，V2 补测试固化。

---

## 2. 里程碑 M1 —— 权限引擎 + Trust（解锁一切）

**文件**：

```
src/permissions/types.ts     # PermissionMode / Decision / PermissionRule
src/permissions/engine.ts    # hasPermissionsToUseTool（逐级短路）+ classifyBashCommand + 内置 deny 清单
src/permissions/store.ts     # permissions.json / trust.json 读写（~/.config/run-agent/）
src/permissions/prompt.ts    # TTY 确认队列（y/n/a，支持“本次总是允许”）；无 TTY 自动 deny
src/cli/index.ts             # --mode / --dangerously-skip-permissions / --trust；接线权限管线
src/cli/trust.ts             # trust 子命令（list/add/remove）
tests/permissions/engine.test.ts   # allow/ask/deny 判定矩阵 + 危险命令拦截
tests/permissions/store.test.ts    # 规则/trust 持久化（临时目录）
```

**M1 验收**：判定矩阵测试绿；`rm -rf` / `npm publish` 在 `default` 下被拦截；无 TTY 时 `ask` 自动 deny 不挂起；`trust add` 后项目规则被加载。

## 3. 里程碑 M2 —— 工具并发

**文件**：

```
src/tools.ts                # 写类工具标 isConcurrencySafe: false；只读工具显式 true
src/core/execute.ts         # partitionToolCalls + executeTools（信号量 + 结果重排）
src/core/query.ts           # stopReason==="tool_use" 分支替换为 executeTools（见 query.ts:84-108）
tests/core/execute.test.ts  # 只读并行/写串行/结果顺序保持/并发上限 10
tests/core/query.test.ts    # 扩展：单轮多 tool_use 批集成场景（FakeClient）
```

**M2 验收**：单轮 3 个只读调用总耗时 ≈ 单个耗时（并行生效）；读+写混合时写不越序；tool_result 顺序与 tool_calls 一致；并发数不超过 10。

## 4. 里程碑 M3 —— 错误重试 + 安全交付物 + 发布

**文件**：

```
src/core/query.ts           # 流式 transient 错误重试（指数退避，maxRetries）
tests/core/query.test.ts    # 重试场景：FakeClient 首次抛错→重试成功 / 多次失败最终放弃
SECURITY.md                 # 漏洞上报流程 + 安全边界说明
docs/permissions.md         # 权限模式 / 规则 / Trust / 危险命令 使用说明
README.md                   # 新增“安全模型”章节（权限模式、Trust 对话怎么工作）
docs/Plan_V2.md             # 本文件归档（DoD 注释状态）
CHANGELOG.md                # [0.2.0]
package.json                # version 0.2.0
```

**M3 交付**：版本 `0.2.0`、CI 三 OS × 3 Node 全绿、tag `v0.2.0`、`npm pack` 检查。

---

## 5. DoD 验收清单

- [ ] 危险命令被拦截、未授权不改文件（engine 判定矩阵测试绿）
- [ ] 一次多文件编辑时只读并行、写串行，结果顺序一致（execute 测试绿）
- [ ] 无 TTY 的 `ask` 自动 deny，不挂起
- [ ] Trust 对话 + `trust` 子命令可用；不信任项目不加载其配置
- [ ] 流式 transient 错误指数退避重试生效（`maxRetries`）
- [ ] `SECURITY.md` + README「安全模型」章节 + `docs/permissions.md`
- [ ] CHANGELOG 记 `0.2.0`；package.json 版本 `0.2.0`；CI 三 OS 绿；tag `v0.2.0`
- [ ] 真实模型本地验证一次「权限拦截 + 并发编辑」（需 key，手动）

---

## 6. 风险与注意

1. **并发结果乱序** → `executeTools` 必须按原始顺序重排；单测断言 tool_result 顺序与 tool_calls 一致。
2. **无 TTY 挂起** → prompt 层检测 `isTTY`，`ask` 降级 deny 并输出可读原因；REPL 内才真正弹确认。
3. **危险命令误判** → 分类函数保守（`risky` 多于 `dangerous`，宁 ask 勿漏）；用户规则可覆盖。
4. **Windows 路径与 shell** → 路径统一 `path.normalize` 后匹配（延续 V1）；bash 命令分类只认字符串模式，PowerShell 语法（`Remove-Item`）同归 `risky` 由用户规则收口。
5. **`isConcurrencySafe` 默认值** → V1 接口默认 true；写类工具必须显式 `false`，review 时逐一核对 6 个工具的标注。
6. **重试副作用** → 只对 `stream()` 重试；**不**自动重跑写/bash 工具（有副作用），交给模型决策。
7. **zod / TS 约束** → 延续 V1 教训：`exactOptionalPropertyTypes` 用条件 spread、`verbatimModuleSyntax` 用 `import type`、zod v4 用 `instanceof` 窄化。

---

## 7. V2 → V3 交接

**V2 结束时的代码状态**：

```
src/permissions/          ← 权限引擎（模式 + 规则 + 内置底线 + Trust）
src/core/execute.ts       ← 并发调度（分区 + 信号量 + 结果重排）
src/core/query.ts         ← loop 接入权限管线 + 并发执行 + 流式重试
src/cli/trust.ts          ← trust 子命令
SECURITY.md / docs/permissions.md
```

**为 V3 预留的扩展点**：

- **权限管线已真实现**：V3 的 compact / CLAUDE.md / 新工具自动走同一管线，天然受保护。
- **`partitionToolCalls` 是 V5 StreamingToolExecutor 的前身**：V5 把「收集完整 batch 再执行」改成「边流式边并行」。
- **trust 边界挂接 Hooks**：V6 的 PreToolUse/PostToolUse 复用 `trustedProjects` 作为信任边界。
- **重试策略参数化**：V3 的 `prompt_too_long` reactive compact 复用同一重试/恢复框架。
