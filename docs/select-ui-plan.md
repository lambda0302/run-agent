# 方向键 + Enter 选择菜单 · 调研与实施方案

> 状态：**调研完成，方案待批准，未实现**（对应任务 #31）
> 目标：把「输入 y/n/a」的权限/Trust 确认，升级成 Claude Code 式的「上下键切换 + Enter 确认」菜单。

---

## 1. Claude Code 是怎么做的（源码实证）

源码位置：`F:\CC_Source\claude-code-sourcemap\restored-src\src\`。分层如下：

### 1.1 按键解析层（事件源）

- Ink 的 `useInput((input, key) => {...})` 把原始字节流解析成 `key` 对象，带布尔开关：`key.upArrow / downArrow / return / escape / tab` 及 `ctrl/shift/meta`（`src/ink/parse-keypress`）。
- CC 自己的事件层 `src/ink/events/keyboard-event.ts` 定义 `KeyboardEvent`：可打印字符 `key` 是字面字符（`'a'`、`'3'`），特殊键是名字（`'down'`、`'return'`、`'escape'`），判断可打印字符惯用法 `e.key.length === 1`。

### 1.2 键位 → 语义动作的注册表（解耦的关键）

`src/keybindings/defaultBindings.ts` 把**物理键**映射到**语义 id**，Select 上下文里：

```
up / k / ctrl+p  →  select:previous   （上一个选项）
down / j / ctrl+n → select:next       （下一个选项）
enter / space    →  select:accept     （确认当前项）
escape           →  select:cancel     （取消）
```

好处：改键、加 vim/ctrl 快捷键只需改注册表，组件代码不变。

### 1.3 订阅层 `useKeybindings`

`src/keybindings/useKeybinding.js`：组件按**语义 id** 注册处理函数，带 `{ context, isActive }` 开关；并用 `useRegisterOverlay('select')` 注册「浮层」，保证 Select 打开时 **Escape 不被全局取消处理器抢走**。

### 1.4 焦点导航状态（纯 reducer）

`src/components/CustomSelect/use-select-navigation.ts` + `use-select-state.ts`：

- state：`focusedValue`（当前焦点）+ `visibleFromIndex/visibleToIndex`（可视窗口，默认 5 条）。
- action：`focus-next-option` / `focus-previous-option` / `focus-next-page` / `focus-previous-page` / `set-focus` / `reset`。
- **焦点到末尾回绕到开头**（wrap），窗口自动滚动；disabled 选项跳过。
- 这段是**纯函数 reducer**，可脱离 TTY 单测——是整块最值得复制的设计。

### 1.5 渲染 `select.tsx`

- 每项渲染成 `<SelectOption isFocused isSelected>`：焦点项显示指针 `❯` + `suggestion` 高亮色；已选项显示 `✓` + `success` 色；disabled 置灰；支持 `label + description` 两栏。
- 选中回调：`select:accept` → `state.selectFocusedOption()` + `onChange(focusedValue)`。
- 真实接线（`BashPermissionRequest.tsx`）：`<Select options={…} onChange={onSelect} onCancel={…} />`，`onSelect(value)` 把 `yes / no / always` 等选项值映射成 `onDone()` / `onReject()`。

---

## 2. run-agent 落地方案（零依赖，不引入 Ink）

run-agent 是**零运行时依赖**的纯 Node CLI，且 **stdin 由 REPL 的 readline 独占**——这两点决定不能照搬 Ink/React。方案拆四块：

### 2.1 `src/ui/keypress.ts` — 键位解析（纯函数，可单测）

```ts
export interface KeyEvent { name: "up" | "down" | "enter" | "escape" | "char"; char?: string; ctrl?: boolean }
export function parseKeypress(chunk: Buffer): KeyEvent[] | null;
```

- 解析 ANSI 序列：`\x1b[A`→up、`\x1b[B`→down、`\r`→enter、`\x1b`→escape；普通字符→`char`。
- 同 CC 注册表思想，提供 `isPreviousKey / isNextKey / isAcceptKey / isCancelKey` 判词，未来加 `j/k`、`ctrl+n/p`、`tab` 只需改这里。

### 2.2 `src/ui/select.ts` — `promptSelect<T>`（通用方向键菜单）

```ts
export interface SelectOption<T> { label: string; value: T; description?: string; disabled?: boolean }
export async function promptSelect<T>(
  options: SelectOption<T>[],
  opts?: { out?: NodeJS.WritableStream; initial?: number },
): Promise<T | undefined>;   // undefined = Escape 取消
```

**实现要点**：
1. 进入前：`rl.pause()`，`process.stdin.setRawMode(true)`，挂一次性 `data` 监听；结束恢复 `setRawMode(false)` + `rl.resume()`。
2. **重绘策略**：先打印全部选项，每次按键用 ANSI `\x1b[A`（上移一行）+ `\x1b[2K`（清行）只重画焦点行——选项数 ≤4 时开销可忽略，且不依赖终端宽度。
3. 焦点移动逻辑做成**纯函数** `nextFocus(index, delta, options): number`（越界回绕、跳过 disabled）——照抄 CC 的 reducer 语义，单测锁定。
4. `enter` → resolve 焦点项；`escape` → resolve `undefined`。

### 2.3 替换现有两处交互

- `resolveAsk`（`src/permissions/prompt.ts`）：`[y/n/a]` 单字符 → `promptSelect` 三项菜单：
  ```
  ❯ ✓ 允许（本次执行）
      ✓ 允许并始终记住（写入规则）
      ✗ 拒绝
  ```
  返回后按原逻辑分支（选「始终记住」→ `addRule`）。
- `askTrustProject`：`[y/n]` → 两项菜单 `信任此项目 / 不信任`。

### 2.4 与 REPL readline 的共存（本方案最大风险点）

**stdin 唯一所有权**是铁律——这次的「双 y 回显」bug 正是同一 stdin 上出现第二个 reader 造成的。因此：

- `promptSelect` 必须**显式接收**当前 `rl`（由 REPL 传入），执行 `rl.pause()` → raw mode → 收集 → 恢复 → `rl.resume()`，全程只有 readline + 菜单一个「临时」读者，且严格串行。
- `makeCheckPermission` 里注入的 `ask` 从「`rl.question` 读一行」换成「调 `promptSelect`」即可，REPL 外的调用路径（无 TTY）保持不变。

### 2.5 测试策略

- **纯函数**：`parseKeypress`（各 ANSI 序列）、`nextFocus`（回绕/disabled 跳过）——不碰 TTY，快。
- **菜单行为**：`promptSelect` 注入一个假的 `data` 事件源（把按键字节喂给它），断言返回值和重绘输出；TTY 只留一条手动冒烟。
- **端到端**：权限菜单选「拒绝」→ `makeCheckPermission` 返回 deny + 输出原因（沿用现有 `tests/permissions/prompt.test.ts` 框架）。

---

## 3. 范围建议与不做的事

**建议本次做**：`keypress.ts` + `select.ts` + `resolveAsk`/`askTrustProject` 接入 + 单测。改动集中在 `src/ui/` 与 `prompt.ts`，不影响 `core/` 与 `engine.ts`，风险可控。

**不做**（留给后续版本）：
- 全 REPL 进入 raw mode + 自绘行编辑器（改动面大，需要重写 line 处理）。
- Ink/React 类完整渲染层（与零依赖原则冲突）。
- 多选、模糊搜索、数字快捷键——等菜单稳定后按需扩展。
- 历史命令选择（`↑` 翻历史）——复用同一 `promptSelect` 即可，非本次范围。

---

## 4. 验收

- [ ] `promptSelect` 在 REPL 里：`↑/↓` 移动焦点、`Enter` 确认、`Escape` 取消，选中项无回显乱码
- [ ] 权限确认从「输入 y/n/a」变成菜单选择；「始终允许」仍写入规则
- [ ] Trust 对话用菜单
- [ ] `npm run typecheck && npm run lint && npm test` 全绿（新增 keypress/select 纯函数单测）
- [ ] 菜单期间 REPL 无 stdin 挂起/丢输入回归（复用既有 readline 单实例）
