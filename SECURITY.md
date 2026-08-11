# 安全说明（Security）

`run-agent` 让模型能读文件、改文件、执行 shell 命令。安全模型围绕**最小权限**与**信任边界**设计：
默认拦得多、放行得少；高风险操作一律需要显式授权。详细用法见 [docs/permissions.md](docs/permissions.md)。

## 权限模式

| 模式                                         | 只读工具 | 写/改工具 | `run_bash` |
| -------------------------------------------- | -------- | --------- | ---------- |
| `default`（默认）                            | 免确认   | 询问确认  | 询问确认   |
| `acceptEdits`                                | 免确认   | 免确认    | 询问确认   |
| `bypass`（`--dangerously-skip-permissions`） | 全部放行 | 全部放行  | 全部放行   |

- 模式选择优先级：`--dangerously-skip-permissions` > `--mode` > 环境变量 `RUN_AGENT_MODE` > `config.json` 的 `permissionMode` > `default`。
- **非交互（one-shot）场景下不会弹确认**，所有"需确认"的操作自动降级为拒绝——绝不挂起、绝不未经确认执行。

## 内置安全底线（不可被用户规则解除）

以下操作在任何模式下（`bypass` 除外）一律拒绝，即使用户规则写了 allow：

- **危险 shell 命令**：`rm -rf /` / `rm -rf ~`（根删除）、`sudo rm -rf …`、格式化类（`mkfs`/`fdisk`/`mkswap`）、`dd` 写入裸设备或系统路径、`git push --force`、`npm/pnpm/yarn publish|prune`、`shutdown`/`reboot`/`halt`/`poweroff`。
- **敏感路径**：任何规范化后含 `.git`、`.claude`、`.run-agent` 路径段的文件操作（仓库元数据与 agent 自身目录）；`run_bash` 命令里引用 `.run-agent` 段同样拒绝——agent 的记忆目录对模型完全只读。

## 信任边界（Trust，防提示注入）

- 项目级权限规则位于 `<项目根>/.run-agent/permissions.json`。**只有被信任的项目，其规则才会被加载。**
- 首次进入一个新目录时，交互模式会询问 `是否信任此项目？`；也可用 `run-agent -t` 或 `run-agent trust <path>` 显式信任，`run-agent trust --remove` 撤销。
- 设计意图：一个恶意仓库无法通过在 `permissions.json` 里写 allow 规则来自动获得执行权限。

## 用户规则

规则按首条命中短路，作用于单个工具或通配 `*`：

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
