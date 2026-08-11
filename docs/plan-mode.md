# Plan 模式（V5 决策 A）

> 适用版本：0.5.0+。复杂任务先出计划、用户批准、再动手——参考 Claude Code 的 Plan and Execute 交互。

## 它是什么

Plan 模式是权限模式 `PermissionMode` 的一档**会话内动态状态**（`"plan"`），与 `default` / `acceptEdits` 并列。
它不是 CLI 可选项（`--mode plan` 报非法值），只由两个入口进入、一个工具退出：

- **进入**（两条路径，共用同一状态机）：
  1. **模型驱动（主）**：模型调用 `enter_plan_mode` 工具（适合快模型不记得进 plan 时的兜底，见下 `/plan`）。
  2. **手动兜底（`/plan`）**：用户在 REPL 敲 `/plan` 直接进入，**不经模型判断**——弥补模型判断力不足。
- **退出**：统一走 `exit_plan_mode`（用户批准是必经的一步，**不另设退出斜杠命令**）。

进入 plan 时记录进入前的权限模式（`prePlanMode`）；退出（审批通过）时恢复它。

## Plan 下能做什么

plan 是**强制只读**态，判定优先级高于用户模式与用户规则（见 [permissions.md](permissions.md) 的判定顺序）：

| 工具类别                                                                     | 判定                                                                    |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `read_file` / `glob` / `grep` / `repo_map` / `explore`（cwd 内 / 记忆豁免）  | **allow**（只读探索）                                                   |
| 只读工具读 cwd 外                                                            | **ask**（canPrompt=false 时降级 deny）                                  |
| `write_file` / `edit_file` / `run_bash` / `verify` / `remember` / MCP 非只读 | **deny**（消息提示「plan 模式下只读：先调用 exit_plan_mode 呈现计划」） |
| `enter_plan_mode`                                                            | allow（它自身处理「已在 plan 中」）                                     |
| `exit_plan_mode`                                                             | **ask**（用户审批）                                                     |

内置危险命令（`rm -rf /` 等）在 plan 分支之前先 deny——安全底线不因模式而放松。

## 退出与审批

`exit_plan_mode` 带 `{ plan }` 入参。调用时：

1. **用户审批**（`checkPermission` 返回 ask → REPL 弹 `y/n/a`）：
   - **y（批准）** → 工具执行。
   - **n（拒绝）** → 工具不执行，模型留在 plan 模式继续探索。
2. 批准后工具做三件事：
   - 把计划**直写**到 `<cwd>/.run-agent/plans/plan-<ts>.md`（`fs.writeFile`，**不经权限管线**——这是系统行为，agent 工具碰不到 `.run-agent`）。
   - 恢复 `prePlanMode`。
   - 返回「用户已批准 + 计划全文 + 文件路径」，tool_result 回填计划全文——`/compact` 后上下文重建也能看到计划，模型无需读盘。

## 装配边界（防死锁）

- **one-shot 不装配** `enter_plan_mode` / `exit_plan_mode`，也没有 `/plan`：无审批弹窗时 `exit_plan_mode` 的 ask 必降级 deny，模型进 plan 就出不来（死锁）。不装配 = 模型根本没有入口。
- `buildTools` 的 `planMode` 选项、REPL 的 `planMode` 选项都只在交互 REPL 装配。
- system prompt 动态段只在装配了 plan 工具的会话注入引导（`SystemContext.hasPlanMode`）。

## 工程细节

- `enter_plan_mode` / `exit_plan_mode` 由 `src/tools/plan_mode.ts` 的 `makePlanTools` 工厂装配，注入 `getMode` / `setMode`（repl 闭包读写 `ctx.mode`）；`prePlanMode` 存工厂闭包（单会话单实例）。
- `/plan` 命令调用同一工厂暴露的 `enterPlanManually()`——与 `enter_plan_mode` 共用 `prePlanMode`，两条进入路径行为完全一致。
- 判定在 `src/permissions/engine.ts` 的 plan 分支（危险命令检查之后、其余判定之前）；只读判定经 `hasPermissionsToUseTool` 第 7 参 `readOnlyNames`（缺省 = 内置只读集，REPL 并入 explore 与 MCP 只读 hint）。
