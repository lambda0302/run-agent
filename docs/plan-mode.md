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

**计划文件前置（0.8.2）**：进入 plan 即确定计划文件路径 `<cwd>/.run-agent/plans/plan-<ts>.md`（首次写盘才建文件）。plan 期间模型可用 `write_file`/`edit_file` **增量打磨**该文件（引擎精确文件豁免，见下），`exit_plan_mode` 缺省读盘取最终计划——用户批准前就能看到/审改计划文件，而非批准瞬间才落盘。

## Plan 下能做什么

plan 是**强制只读**态，判定优先级高于用户模式与用户规则（见 [permissions.md](permissions.md) 的判定顺序）：

| 工具类别                                                                     | 判定                                                                    |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `read_file` / `glob` / `grep` / `repo_map` / `explore`（cwd 内 / 记忆豁免）  | **allow**（只读探索）                                                   |
| 计划文件 `write_file` / `edit_file` / `read_file`（0.8.2，精确文件 + plan 模式） | **allow**（引擎步骤 4.5 豁免——先于路径危险段；写计划文件不被 `.run-agent` 段拦） |
| 只读工具读 cwd 外                                                            | **ask**（canPrompt=false 时降级 deny）                                  |
| 其它 `write_file` / `edit_file` / `run_bash` / `remember` / MCP 非只读 | **deny**（消息提示「plan 模式下只读：先调用 exit_plan_mode 呈现计划」） |
| `enter_plan_mode`                                                            | allow（它自身处理「已在 plan 中」）                                     |
| `exit_plan_mode`                                                             | **ask**（用户审批）                                                     |

内置危险命令（`rm -rf /` 等）在 plan 分支之前先 deny——安全底线不因模式而放松。

## 退出与审批

`exit_plan_mode` 入参 `{ plan?: string }`（0.8.2 起可选）：

- **有 `plan`** → 覆盖写盘后再审批（兼容旧版内联计划的行为）。
- **无 `plan`** → **读盘**：读 `<cwd>/.run-agent/plans/plan-<ts>.md` 作为最终计划（模型 plan 期间 write/edit 打磨的产物）。文件不存在/为空 → 错误结果，提示先 write_file 写计划或传 plan 入参。

调用流程：

1. **用户审批**（`checkPermission` 返回 ask → REPL 弹方向键菜单）：
   - **y（批准计划）** → 工具执行。
   - **e（编辑后批准，0.8.2）** → 打开系统编辑器（`$EDITOR` → `$VISUAL` → Windows `notepad`）改计划文件 → 关闭后重读，与编辑前快照比对：**内容有变** → 批准并经 `updatedInput` 把 `{ plan: 新内容, planWasEdited: true }` 透传给工具；无变化 → 仍批准（`planWasEdited` 不置位）。编辑器不可用/取消 → deny（保守，不静默批准）。
   - **n（拒绝）** → 工具不执行，模型留在 plan 模式继续探索。拒绝语义双保险（0.5.1）：① 系统提示注入「计划被拒 → 立即停止当前工作并等待用户下一条指令，不输出实现内容、不重复尝试执行」；② `exit_plan_mode` 装配专属 `denyMessage`，用户按 `n` 后模型收到的回填是「用户拒绝了你的计划…等待用户下一条指令」，而非通用「权限被拒绝」——避免模型误读为自身状态错误而反复重进 plan 模式。
   - **a（批准并始终记住）** → 写入规则（`{tool: exit_plan_mode, action: allow}`）后批准。
2. 批准后工具做三件事：
   - 把计划**直写**到 `<cwd>/.run-agent/plans/plan-<ts>.md`（`fs.writeFile`，**不经权限管线**——这是系统行为，agent 工具碰不到 `.run-agent`）。读盘路径下文件已存在，直写即覆写同内容。
   - 恢复 `prePlanMode`。
   - 返回「用户已批准计划（用户已编辑，若 planWasEdited）+ 计划全文 + 文件路径」，tool_result 回填计划全文——`/compact` 后上下文重建也能看到计划，模型无需读盘。

## 装配边界（防死锁）

- **one-shot 不装配** `enter_plan_mode` / `exit_plan_mode`，也没有 `/plan`：无审批弹窗时 `exit_plan_mode` 的 ask 必降级 deny，模型进 plan 就出不来（死锁）。不装配 = 模型根本没有入口。
- `buildTools` 的 `planMode` 选项、REPL 的 `planMode` 选项都只在交互 REPL 装配。
- system prompt 动态段只在装配了 plan 工具的会话注入引导（`SystemContext.hasPlanMode`）。

## 工程细节

- `enter_plan_mode` / `exit_plan_mode` 由 `src/tools/plan_mode.ts` 的 `makePlanTools` 工厂装配，注入 `getMode` / `setMode`（repl 闭包读写 `ctx.mode`）；`prePlanMode` 存工厂闭包（单会话单实例）。
- `/plan` 命令调用同一工厂暴露的 `enterPlanManually()`——与 `enter_plan_mode` 共用 `prePlanMode`，两条进入路径行为完全一致。
- 判定在 `src/permissions/engine.ts` 的 plan 分支（危险命令检查之后、其余判定之前）；只读判定经 `hasPermissionsToUseTool` 第 7 参 `readOnlyNames`（缺省 = 内置只读集，REPL 并入 explore——不含 MCP，V8 起 MCP 外部工具 plan 下也 ask，先于只读判定）。
- **计划文件豁免（0.8.2）**：`hasPermissionsToUseTool` 第 8 参 `planFilePath`（`PermissionContext.planFilePath`）；豁免步骤 4.5 在记忆豁免之后、路径危险段之前——精确文件 + `mode === "plan"` + `write_file`/`edit_file`/`read_file` 三工具放行，同目录其它文件照旧段 deny。
- **装配链（0.8.2）**：`makePlanTools` 的 `onEnter(planFilePath)` 回调 → `cli/index.ts` 写入 `ctx.planFilePath` → `makeCheckPermission` 每判定传 engine（实时读 ctx，模型轮内进入 plan 也生效）→ `repl.ts` 每轮 `runTurn` 把 `ctx.mode`/`ctx.planFilePath` 同步进 `systemCtx` → `context.ts` 动态段在 `mode === "plan"` 注入 plan 专用提示词段（状态确认 + 只读纪律 + explore 引导 + 计划文件路径 + 收束）。
- **编辑后批准（0.8.2）**：`resolveAsk` 返回 `PermissionCheckResult`（可含 `updatedInput`），exit 弹窗菜单 `EXIT_OPTIONS` 四项；`execute.ts` 在 allow 且携带 updatedInput 时并入 `item.input` 再走工具（重新 zod 校验）；编辑器经 `openSystemEditor`（`src/utils/editor.ts`）注入，测试用 fake。
