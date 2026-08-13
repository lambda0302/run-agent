# 安全说明（Security）

`run-agent` 让模型能读文件、改文件、执行 shell 命令。安全模型围绕**最小权限**与**信任边界**设计：
默认拦得多、放行得少；高风险操作一律需要显式授权。详细用法见 [docs/permissions.md](docs/permissions.md)。

## 权限模式

> **bypass 已于 0.4.2 删除**：`--dangerously-skip-permissions` / `--mode bypass` 不再可用；
> 旧配置里的 `"bypass"` 值回退 `default` 并警告。现在只有两档：

| 模式              | 只读工具（cwd 内） | 写/改工具（cwd 内） | `run_bash`                                    |
| ----------------- | ------------------ | ------------------- | --------------------------------------------- |
| `default`（默认） | 免确认             | 询问确认            | 六分类分流（`readonly` 自动放行，其余询问）   |
| `acceptEdits`     | 免确认             | 免确认（仅 cwd 内 `write_file`/`edit_file`） | 六分类分流（同 default，不因 acceptEdits 放行） |

- 模式选择优先级：`--mode` > 环境变量 `RUN_AGENT_MODE` > `config.json` 的 `permissionMode` > `default`。
- **工作目录（cwd）白名单**：路径在 cwd 之外时，**只读工具也询问确认**（越界读取唯一合法通道是用户 allow 规则）；`acceptEdits` 的免确认只作用于 cwd 内。
- **非交互（one-shot）场景下不会弹确认**，所有"需确认"的操作自动降级为拒绝——绝不挂起、绝不未经确认执行。

## `run_bash` 六分类（影响半径）

`run_bash` 不再"一律问"，每条命令按影响半径归入六档（`classifyBashCommand`）：

- **`dangerous` → 无条件拒绝**（内置底线，见下）：根删除、格式化、裸设备/系统路径写入、远程拉取执行（`curl|sh`）、强推（`git push --force`）、发布包、`git reset --hard`。
- **`readonly` → 自动放行**（R0 闭集白名单）：仅 `pwd`/`ls`/`echo`/`cat`，且**不含**管道、重定向、命令替换、子 shell、逻辑符（`/[|&;<>`$(){}\n]/` 一票否决）；`cat` 严格单参数纯相对路径。git 系列（含 `git status`/`log`/`diff`）**不入 R0**——仓库级 `.git/config` 可定义 alias/pager 执行任意命令。
- **`network` / `local-exec` / `http-get` / `write` → 询问确认**：网络副作用（git 拉推克隆、装依赖、wget）、本地执行（`node`/`npm test`/`./script.sh`）、curl 采样到 stdout、项目内写/变更（`rm file`、`mkdir`、`sed -i`）与未识别命令兜底。

## 内置安全底线（不可被用户规则解除）

以下操作在任何模式下一律拒绝，即使用户规则写了 allow（判定链里最前几档，`classifyBashCommand` = `dangerous`）：

- **危险 shell 命令**：`rm -rf /` / `rm -rf ~`（根删除，含 `echo x | rm -rf /` 管道变体）、`sudo rm -rf …`、格式化类（`mkfs`/`fdisk`/`mkswap`）、`dd` 写入裸设备或系统路径（含 `of=//dev` 双斜杠变体）、远程拉取执行（`curl … | sh` / `wget … | bash`）、`git push --force`（含 `git -C repo push --force` 前置参数变体）、`git reset --hard`、`npm/pnpm/yarn publish|prune`、`shutdown`/`reboot`/`halt`/`poweroff`。
- **敏感路径（危险目录段）**：任何规范化后含 `.git`、`.claude`、`.run-agent` 路径段的文件操作（仓库元数据与 agent 自身目录），plan 模式下同样生效；`run_bash` 命令文本里引用任一目录段（`DENY_BASH_SEGMENTS_RE`，命令开头或 shell 拼接边界后匹配）同样拒绝——版本库、配置与 agent 的记忆目录对模型完全只读。

## 信任边界（Trust，防提示注入）

- 项目级权限规则位于 `<项目根>/.run-agent/permissions.json`。**只有被信任的项目，其规则才会被加载。**
- 首次进入一个新目录时，交互模式会询问 `是否信任此项目？`；也可用 `run-agent -t` 或 `run-agent trust <path>` 显式信任，`run-agent trust --remove` 撤销。
- 设计意图：一个恶意仓库无法通过在 `permissions.json` 里写 allow 规则来自动获得执行权限。

## 用户规则

规则**deny 先于 allow**：判定链先扫全部 `deny` 规则（同 action 内首条命中即短路），再扫全部 `allow` 规则——用户显式 deny 优先于一切内置放行；作用于单个工具或通配 `*`：

```jsonc
// ~/.config/run-agent/permissions.json（全局）
// 或 <受信任项目>/.run-agent/permissions.json（项目级）
{
  "rules": [
    { "tool": "run_bash", "action": "deny" }, // 禁止一切命令执行
    { "path": "**/secrets/**", "action": "deny" }, // 禁止触碰 secrets 目录
    { "tool": "run_bash", "command": "^git status", "action": "allow" }, // 放行 git status
  ],
}
```

- `tool`：精确工具名或 `*`；`path`：作用于 `file_path`/`path`/`cwd` 的 glob；`command`：作用于 `run_bash.command` 的正则。
- 全局规则存在 `~/.config/run-agent/permissions.json`，用户规则存在全局或项目级均可。

## 密钥与凭证

- API key **永不进入仓库**。通过 `--api-key`、环境变量（如 `DEEPSEEK_API_KEY`）或 `config.json` 的 `apiKeyEnv`（存变量名）提供，`.gitignore` 已覆盖 `.env`、`dist/`、`node_modules/`。
- 建议在专用、隔离的环境变量中管理密钥，不要写入会被提交的文件。

## 报告漏洞

请勿在公开 Issue 中披露。将细节发送至维护者邮箱或私下联系仓库所有者；不要在未授权系统上复现攻击性利用。感谢负责任的披露。
