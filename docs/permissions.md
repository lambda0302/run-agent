# 权限与 Trust

V2 引入**权限审批引擎**、**只读并行/写串行**、**Trust 信任边界**（防提示注入）；V4.5（0.4.2）把权限模型收敛为「**危险目录黑名单 + 工作目录白名单 + 专属通道**」三层，并**删除 bypass 模式**。
本篇讲如何用；设计细节见 [Plan_V2.md](Plan_V2.md)、[Plan_V4.5.md](Plan_V4.5.md) 与 [../SECURITY.md](../SECURITY.md)。

## 权限模式

CLI 可选两档：`default` / `acceptEdits`（`bypass` 已于 0.4.2 删除）；外加**会话内动态模式 `plan`**
（0.5.0，强制只读，见下）。两档 CLI 模式的解析优先级：

1. `--mode <default|acceptEdits>`（非法值由 commander 直接报错，`plan` 也报非法——它不是 CLI 可选项）
2. 环境变量 `RUN_AGENT_MODE`
3. `~/.config/run-agent/config.json` 的 `"permissionMode"`
4. 默认 `default`

> 环境变量 / 配置文件里的旧值 `"bypass"`（或其它非法值）会**回退 `default`** 并在启动时打印一条警告（温和降级，不崩溃）。

| 模式          | 只读工具（cwd 内） | 写/改工具（cwd 内） | `run_bash`   |
| ------------- | ------------------ | ------------------- | ------------ |
| `default`     | 免确认             | 询问确认            | 询问确认     |
| `acceptEdits` | 免确认             | 免确认              | 询问确认     |
| `plan`        | 免确认             | **一律拒绝**        | **一律拒绝** |

> 只读工具 = `read_file` / `glob` / `grep` / `repo_map` / `explore`（plan 下也放行，它内部只用只读工具）。
> 交互 REPL 里，需要确认的操作会弹出 `[y=本次允许 / n=拒绝 / a=始终允许]`；选 `a` 会写一条**全局**规则到 `permissions.json`。
> **one-shot（`run-agent "..."`）不弹确认，一律降级拒绝**，避免挂起。

### Plan 模式（0.5.0）

`plan` 是**会话内动态模式**，只由 `enter_plan_mode` 进入、`exit_plan_mode` 退出（用户也可敲 `/plan`
直接进入）。plan 下强制只读：写/改/执行类工具（`write_file` / `edit_file` / `run_bash` / `verify` /
`remember` / MCP 非只读工具）一律 deny；只读工具 cwd 内放行、cwd 外 ask；`enter_plan_mode` 自身放行、
`exit_plan_mode` 放行（它的审批由 REPL 弹窗负责）。`exit_plan_mode` 把计划直写 `.run-agent/plans/`
并弹 `y/n` 审批，批准后恢复进入前的模式（`prePlanMode`）。one-shot 不装配 plan 工具、无 `/plan`。
详见 [plan-mode.md](plan-mode.md)。

### MCP 工具的只读判定（0.5.0 `readOnlyNames`）

权限判定第 7 参 `readOnlyNames`（缺省 = 内置只读 ∪ explore，语义不变）把 **MCP 工具的 readOnlyHint**
并入只读集合：只读 hint 的 MCP 工具按只读对待（cwd 内放行 / plan 下放行），非只读 MCP 工具
`default` 必 ask、`acceptEdits` 放行、**plan 下 deny**。`mcp_connect` 免确认（配置动作），plan 下 deny。
详见 [mcp.md](mcp.md)。

## 三层模型

### 1. 工作目录白名单（cwd 边界）

路径以**工作目录（cwd）**为界：

- 路径在 cwd 内 → 走模式兜底（上表）。
- 路径在 cwd 外（含 `../`、绝对路径、symlink 指出去）→ **只读工具也询问确认**。
  这是对"只读工具无条件放行"缺口的收紧：`read_file ~/.ssh/id_rsa` 这类越界读取不会静默通过。
  越界路径唯一合法通道是**用户 allow 规则**（见下）。

判定对路径做 **realpath 双形态**校验：展开 `~` 并 resolve 后的形态、以及 realpath 解析后的形态，
**两个形态都必须落在 cwd 内**才视为 cwd 内——防 `foo → .run-agent/x`、`foo → /etc/passwd` 这类
symlink 换名逃逸，并兼容 macOS `/var`→`/private/var` 之类的系统 symlink。

### 2. 危险目录黑名单（内置底线）

以下路径段**无条件拒绝**（用户规则无法解除，任何模式都拦）：

- `.git` / `.claude` / `.run-agent`：比较时**段小写化**（`.RUN-AGENT` 一样被拦）；
  任一 realpath 形态命中即 deny。
- `run_bash` 命令文本里引用 `.run-agent` 段同样收口（agent 的记忆目录对模型完全只读）。
  > 局限：这是**第二道防线**（尽力而为），只匹配已识别的 shell 拼接形态，不承诺穷尽
  > 所有拼接绕过——真正可靠的是工具层本身拒绝触碰 `.run-agent`（`read_file` 等路径工具按段 deny）。

### 3. 专属通道：记忆读豁免

唯一的、有意的放宽：**Trust 会话内**，`read_file` / `glob` / `grep` 三个只读工具对
`.run-agent/memory/**` **放行**——这是「索引 → 按需 read/grep 读记忆」的前提。
未 Trust 会话豁免不生效，`.run-agent/memory/` 对 agent 完全不可见（同款 Trust 门控）。
写记忆只能走 `remember` 工具（写类，走权限引擎）；`write_file`/`edit_file`/`run_bash` 对
`.run-agent/**` 依旧全禁。

## 统一判定顺序（V4.5 决策 D）

`hasPermissionsToUseTool` 按以下顺序短路（与 Claude Code 的「deny 先于一切 allow」对齐）：

1. **内置危险命令**（`rm -rf /`、`mkfs`、`git push --force`、`npm publish` 等）→ deny（最高级）
2. **用户 deny 规则** → deny（用户显式 deny 优先于一切内置放行）
3. **专属通道**（记忆读豁免）→ allow
4. **危险目录段**（`.git`/`.claude`/`.run-agent`）→ deny
5. **`run_bash` 引用 `.run-agent`** → deny
6. **用户 allow 规则** → allow（cwd 外访问的唯一授权通道）
7. **白名单 + 模式兜底**：`run_bash` 一律问；Windows 可疑路径（UNC / ADS / 8.3 短名 /
   长前缀 / 尾随点空格 / DOS 设备名 / 三连点）→ 问；无路径工具按 V2 语义；cwd 内只读
   allow / `acceptEdits` 写 allow / `default` 写问；cwd 外只读也问。

内置底线（1/4/5）与专属通道（3）**不可被用户规则解除**；2 与 6 是用户可控的两档。

## 用户规则

两条规则来源，按统一判定顺序评估（deny 先于 allow）：

- 全局：`~/.config/run-agent/permissions.json`
- 项目级：`<项目根>/.run-agent/permissions.json`（**仅当项目被信任才加载**）

规则字段（全部可选，缺省即对该维度不设限）：

| 字段      | 类型                     | 作用于                                                                             |
| --------- | ------------------------ | ---------------------------------------------------------------------------------- |
| `tool`    | 精确工具名或 `*`         | 工具名                                                                             |
| `path`    | glob（`*`/`**`/`?`）     | 工具入参的 `file_path` / `path` / `cwd`（resolve 归一化，realpath 双形态各查一遍） |
| `command` | 正则                     | `run_bash` 的 `command`                                                            |
| `action`  | `allow` / `ask` / `deny` | 命中时的决策                                                                       |

示例：

```jsonc
{
  "rules": [
    { "tool": "run_bash", "action": "deny" },
    { "tool": "run_bash", "command": "^git (status|log|diff)", "action": "allow" },
    { "path": "**/secrets/**", "action": "deny" },
    { "tool": "edit_file", "path": "**/docs/**", "action": "allow" },
  ],
}
```

规则与内置底线的关系：**内置 deny 优先于规则**（安全底线不可被规则解除）。

## Trust 信任边界

`run-agent trust` 子命令管理受信任项目列表（存于 `~/.config/run-agent/trust.json`）：

```bash
run-agent trust                  # 信任当前目录
run-agent trust <path>           # 信任指定目录
run-agent trust --list           # 列出全部
run-agent trust <path> --remove  # 撤销
run-agent -t                     # 启动时一次性信任当前目录（跳过 Trust 提问）
```

信任的意义：**项目级规则与记忆读豁免只在受信任项目里生效**。这样，从一个不受信任的仓库运行 agent 时，
仓库里 `.run-agent/permissions.json` 写什么规则都不会自动获得执行权限——阻断"恶意仓库自我授权"。

信任判定：`cwd` 等于受信任路径或位于其子目录即视为受信任。

## 与工具并发的交互

V2 同时引入了只读并行/写串行（见 [architecture.md](architecture.md)）。权限校验发生在每个
工具执行前：被拒绝的工具会得到"权限被拒绝"结果并回填给模型，不会中断整批调用。
