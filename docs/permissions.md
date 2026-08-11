# 权限与 Trust

V2 引入：**权限审批引擎**、**只读并行/写串行**、**Trust 信任边界**（防提示注入）。
本篇讲如何用；设计细节见 [Plan_V2.md](Plan_V2.md) 与 [../SECURITY.md](../SECURITY.md)。

## 权限模式

启动时可选 `default` / `acceptEdits` / `bypass`，解析优先级：

1. `--dangerously-skip-permissions`（等价 `--mode bypass`）
2. `--mode <default|acceptEdits|bypass>`
3. 环境变量 `RUN_AGENT_MODE`
4. `~/.config/run-agent/config.json` 的 `"permissionMode"`
5. 默认 `default`

| 模式          | 只读工具 | 写/改工具 | `run_bash` |
| ------------- | -------- | --------- | ---------- |
| `default`     | 免确认   | 询问确认  | 询问确认   |
| `acceptEdits` | 免确认   | 免确认    | 询问确认   |
| `bypass`      | 全部放行 | 全部放行  | 全部放行   |

> 只读工具 = `read_file` / `glob` / `grep`。交互 REPL 里，需要确认的操作会弹出
> `[y=本次允许 / n=拒绝 / a=始终允许]`；选 `a` 会写一条全局规则到 `permissions.json`。
> **one-shot（`run-agent "..."`）不弹确认，一律降级拒绝**，避免挂起。

## 内置安全底线

`bypass` 之外的所有模式，以下**无条件拒绝**（用户规则无法解除）：

- 危险命令：`rm -rf /`、`rm -rf ~`、`sudo rm -rf …`、`mkfs`/`fdisk`/`mkswap`、
  `dd … of=/dev|/etc|/var`、`git push --force`、`npm|pnpm|yarn publish|prune`、`shutdown` 等。
- 敏感路径：路径含 `.git` / `.claude` / `.run-agent` 段；`run_bash` 命令文本里引用 `.run-agent`
  段同样收口（agent 的记忆目录对模型完全只读）。

`run_bash` 的命令还会按风险分级：`dangerous` → 直接拒绝；`risky`（如 `rm -rf ./dist`、
`sudo …`、`curl … | sh`、`> /etc/…`、`git reset --hard`、`git checkout .`）→ 需要确认；
`safe` → 仍需要确认（命令执行是最高风险面，默认一问）。

## 用户规则

两条规则来源，按"首条命中短路"合并评估：

- 全局：`~/.config/run-agent/permissions.json`
- 项目级：`<项目根>/.run-agent/permissions.json`（**仅当项目被信任才加载**）

规则字段（全部可选，缺省即对该维度不设限）：

| 字段      | 类型                     | 作用于                                                       |
| --------- | ------------------------ | ------------------------------------------------------------ |
| `tool`    | 精确工具名或 `*`         | 工具名                                                       |
| `path`    | glob（`*`/`**`/`?`）     | 工具入参的 `file_path` / `path` / `cwd`（先 resolve 归一化） |
| `command` | 正则                     | `run_bash` 的 `command`                                      |
| `action`  | `allow` / `ask` / `deny` | 命中时的决策                                                 |

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

信任的意义：**项目级规则只在受信任项目里生效**。这样，从一个不受信任的仓库运行 agent 时，
仓库里 `.run-agent/permissions.json` 写什么规则都不会自动获得执行权限——阻断"恶意仓库自我授权"。

信任判定：`cwd` 等于受信任路径或位于其子目录即视为受信任。

## 与工具并发的交互

V2 同时引入了只读并行/写串行（见 [architecture.md](architecture.md)）。权限校验发生在每个
工具执行前：被拒绝的工具会得到"权限被拒绝"结果并回填给模型，不会中断整批调用。

## 一键跳过（不推荐）

```bash
run-agent --dangerously-skip-permissions "随便做什么"
```

仅用于完全可信、一次性、隔离的环境。**任何把 agent 暴露给不可信输入（网页、下载的脚本、外部
prompt）的场景都不应使用**。
