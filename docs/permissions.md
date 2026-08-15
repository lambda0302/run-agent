# 权限与 Trust

V2 引入**权限审批引擎**、**只读并行/写串行**、**Trust 信任边界**（防提示注入）；V4.5（0.4.2）删除 bypass 模式，
把权限模型收敛为「危险目录黑名单 + 工作目录白名单 + 专属通道」三层。本版**重构 `run_bash` 语义**：
从「一律问」改为**六分类影响半径判定**（`dangerous` 硬拒 / `readonly` 自动放行 / 其余询问），判定链
**收口前置单线**（用户 deny 最先、命令文本危险段在 plan 分支前，见下）。设计细节见
[Plan_V2.md](Plan_V2.md)、[Plan_V4.5.md](Plan_V4.5.md)、[expected-permissions.md](expected-permissions.md)（**归档设计稿**，
0.8.0 已落地，未落地的远期方向见其顶部）与 [../SECURITY.md](../SECURITY.md)。

## 权限模式

CLI 可选两档：`default` / `acceptEdits`（`bypass` 已于 0.4.2 删除）；外加**会话内动态模式 `plan`**
（0.5.0，强制只读，见下）。两档 CLI 模式的解析优先级：

1. `--mode <default|acceptEdits>`（非法值由 commander 直接报错，`plan` 也报非法——它不是 CLI 可选项）
2. 环境变量 `RUN_AGENT_MODE`
3. `~/.config/run-agent/config.json` 的 `"permissionMode"`
4. 默认 `default`

> 环境变量 / 配置文件里的旧值 `"bypass"`（或其它非法值）会**回退 `default`** 并在启动时打印一条警告（温和降级，不崩溃）。

| 模式          | 只读工具（cwd 内） | 写/改工具（cwd 内） | `run_bash`                                       |
| ------------- | ------------------ | ------------------- | ------------------------------------------------ |
| `default`     | 免确认             | 询问确认            | 六分类分流（`readonly` 自动放行，其余询问）      |
| `acceptEdits` | 免确认             | 免确认（仅 `write_file`/`edit_file`） | 六分类分流（同 default，不因 acceptEdits 放行） |
| `plan`        | 免确认             | **一律拒绝**        | **一律拒绝**                                     |

> 只读工具 = `read_file` / `glob` / `grep` / `repo_map` / `explore`（plan 下也放行，它内部只用只读工具）。
> 交互 REPL 里，需要确认的操作会弹出 `[y=本次允许 / n=拒绝 / a=始终允许]`；选 `a` 会写一条**全局**规则到 `permissions.json`。
> **one-shot（`run-agent "..."`）不弹确认，一律降级拒绝**，避免挂起。

### Plan 模式（0.5.0）

`plan` 是**会话内动态模式**，只由 `enter_plan_mode` 进入、`exit_plan_mode` 退出（用户也可敲 `/plan`
直接进入）。plan 下强制只读：写/改/执行类工具（`write_file` / `edit_file` / `run_bash` /
`remember` / MCP 非只读工具）一律 deny；只读工具 cwd 内放行、cwd 外 ask；`enter_plan_mode` 自身放行、
`exit_plan_mode` 放行（它的审批由 REPL 弹窗负责）。`exit_plan_mode` 把计划直写 `.run-agent/plans/`
并弹 `y/n` 审批，批准后恢复进入前的模式（`prePlanMode`）。one-shot 不装配 plan 工具、无 `/plan`。
详见 [plan-mode.md](plan-mode.md)。

### MCP 工具的只读判定（0.5.0 `readOnlyNames`）

权限判定第 7 参 `readOnlyNames`（缺省 = 内置只读 ∪ explore，语义不变）把 **MCP 工具的 readOnlyHint**
并入只读集合：只读 hint 的 MCP 工具按只读对待（cwd 内放行 / plan 下放行）；非只读 MCP 工具
`default` 与 `acceptEdits` 都必 ask（P2 收窄：`acceptEdits` 只预授权 cwd 内 `write_file`/`edit_file`，
**不放行 MCP 写工具**）、**plan 下 deny**。`mcp_connect` 免确认（配置动作），plan 下 deny。
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
- `run_bash` 命令文本里引用 **`.git` / `.claude` / `.run-agent`** 任一目录段同样收口
  （`DENY_BASH_SEGMENTS_RE`，命令开头或任意 shell 拼接边界后匹配，`/i` 不区分大小写；
  后缀 `(?![\w-])` 防 `.gitignore` / `.gitattributes` 误伤）。agent 的记忆目录、版本库、
  配置目录对模型完全只读。
  > 局限：这是**第二道防线**（尽力而为），只匹配已识别的 shell 拼接形态，不承诺穷尽
  > 所有拼接绕过——真正可靠的是工具层本身拒绝触碰 `.git`/`.claude`/`.run-agent`
  > （`read_file` 等路径工具按段 deny）。

### 3. 专属通道：记忆读豁免

唯一的、有意的放宽：**Trust 会话内**，`read_file` / `glob` / `grep` 三个只读工具对
`.run-agent/memory/**` **放行**——这是「索引 → 按需 read/grep 读记忆」的前提。
未 Trust 会话豁免不生效，`.run-agent/memory/` 对 agent 完全不可见（同款 Trust 门控）。
写记忆只能走 `remember` 工具（写类，走权限引擎）；`write_file`/`edit_file`/`run_bash` 对
`.run-agent/**` 依旧全禁。

## `run_bash` 六分类（影响半径）

`classifyBashCommand` 把每条 bash 命令按影响半径归入六档，`readonly` 是唯一自动放行档、
`dangerous` 是唯一无条件拒绝档，其余四档在 engine 层一律 ask（`acceptEdits` 不放行）：

| 分类 | 影响半径 | 例子 | engine 兜底 |
| ---- | -------- | ---- | ----------- |
| `dangerous` | R2 系统级写 / R3b 远程拉取执行 / R4b 发布强推 | `rm -rf /`、`mkfs`、`dd of=/dev/sda`、`curl … \| sh`、`git push --force`、`git reset --hard`、`npm publish` | **无条件 deny** |
| `readonly` | R0 纯只读（闭集白名单） | `pwd`、`ls -la`、`echo hi`、`cat ./a.ts` | **自动 allow** |
| `network` | R4a 网络副作用 | `git fetch/pull/clone/push`、`npm install`、`wget`、`gh` | ask |
| `local-exec` | R3a 本地执行 | `node --version`、`npm test`、`python3 x.py`、`./script.sh`、`eval` | ask |
| `http-get` | R4a 只读采样 | `curl https://…`（到 stdout，无 `-o`/`-O`/`-J`/`-C`） | ask |
| `write` | R1 项目内写 / 变更 / 兜底 | `rm file.txt`、`mkdir`、`sed -i`、`git commit`、`echo x > f`、未识别命令 | ask |

分类只做字符串模式识别，PowerShell 别名/全名（`Remove-Item`、`Get-ChildItem` 等）模式未命中时
归 `write` 兜底 ask，由用户规则收口。

**R0 闭集证明制**：只收 `pwd`/`ls`/`echo`/`cat`，且命令**不含**管道、重定向、命令替换、子 shell、
逻辑符、换行（`/[|&;<>`$(){}\n]/` 一票否决）；`cat` 严格单参数纯相对路径（拒绝绝对/`~`/`$`/`..`/通配符）。
**git 不入 R0**：仓库级 `.git/config` 可定义 alias/pager/external-diff 执行任意命令，git 系列
（含 `git status`/`git log`/`git diff`）一律按 `write` 兜底 ask——宁可多问一次，不赌仓库配置可信。

## 统一判定顺序（收口前置单线）

`hasPermissionsToUseTool` 按以下顺序短路（与 Claude Code 的「deny 先于一切 allow」对齐）——

```
用户 deny → 内置危险命令 → 命令文本危险段 → 记忆豁免 → 路径危险段 → plan 分支
         → 导航工具 → 用户 allow → 白名单兜底
```

1. **用户 deny 规则** → deny（用户显式 deny 优先于一切内置放行，含导航工具）
2. **内置危险命令**（`classify` = `dangerous`）→ deny（任何规则/模式不可覆盖）
3. **命令文本危险段**（`DENY_BASH_SEGMENTS_RE`：`.git`/`.claude`/`.run-agent`）→ deny
4. **专属通道**（记忆读豁免）→ allow
5. **路径危险段**（`.git`/`.claude`/`.run-agent` 段，小写化比较）→ deny
   ——**plan 下也跑**（危险段/记忆豁免在 plan 分支前统一处理，堵 plan 绕过）
6. **plan 分支**：`enter_plan_mode` 放行 / `exit_plan_mode` ask / 只读工具 cwd 内放行、cwd 外
   ask / 其余（写类、`run_bash`、`remember`、MCP 非只读）deny
7. **导航工具**（`enter_plan_mode`/`exit_plan_mode`/`mcp_connect`）→ allow
8. **用户 allow 规则** → allow（cwd 外访问的唯一授权通道；也可显式放行 `run_bash`）
9. **白名单 + 模式兜底**：`run_bash` 按六分类分流（`readonly` allow / 其余 ask）；Windows 可疑
   路径（UNC / ADS / 8.3 短名 / 长前缀 / 尾随点空格 / DOS 设备名 / 三连点）→ ask；无路径工具
   `readOnlyNames` allow / 其余 ask；cwd 内只读 allow / `acceptEdits` 仅 `write_file`/`edit_file`
   allow / 其余 ask；cwd 外只读也 ask。

内置底线（2/3/5）与专属通道（4）**不可被用户规则解除**；1 与 8 是用户可控的两档。
行为变化：`node --version`/`npm test`/`git status` 等从「免确认」变为 ask（执行类/仓库配置面
兜底），`curl` 采样本就 ask 归 `http-get`（verification 子 agent 放行）。

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
