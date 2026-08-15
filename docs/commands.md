# 自定义命令（0.6.0）

> V6「可编程化」三件套之一。把高频操作固化成一条斜杠命令——`prompt` 形态是模板
> （展开后走 agent 循环），`local` 形态是脚本（解释器直跑、输出展示）。路径用 run-agent
> **自有路径**（无 `.claude/`）。

## 放哪

- **用户级** `~/.config/run-agent/commands/<name>.md|.py|.js|.ts`——始终加载（用户自写）。
- **项目级** `<cwd>/.run-agent/commands/<name>.md|.py|.js|.ts`——**仅 Trust 会话加载**。
- 命令名 = 文件名去扩展名，须不含空白。同名去重：**用户级优先**。
- `local-jsx` 形态（React/Ink 渲染）**不落地**，推 V9 TUI。

## 两种形态

| 形态     | 扩展名                | 行为                                                                         |
| -------- | --------------------- | ---------------------------------------------------------------------------- |
| `prompt` | `.md`                 | 模板文本展开（`@file` 内联 + 参数追加），**展开后作为 prompt 走 agent 循环** |
| `local`  | `.py` / `.js` / `.ts` | 解释器直跑脚本，参数走 argv，**stdout 直接展示、不自动回喂模型**             |

### prompt 形态

```markdown
# 审查本次改动

先跑 `git diff` 找出改动文件，逐个审查，输出按严重度排序的问题清单。
@src/core/query.ts
```

- `@<path>` 在模板内内联为 `--- <abs> ---\n<content>`（复用 read_file 约束：≤4MB、≤2000 行、
  二进制跳过；缺文件/超限 → 占位说明，不中断展开）。**仅模板内**展开，参数里的 `@` 是字面量。
- 参数（`/命令名 参数...`）以行尾追加进展开文本。

### local 形态

```python
#!/usr/bin/env python3
import sys
print("收到参数:", sys.argv[1:])
```

- 参数 whitespace 切分走 argv；stdin 无输入。注入 `RUN_AGENT_CWD` / `RUN_AGENT_PROMPT` 让脚本感知会话。
- `.ts` 用 `--experimental-strip-types`（Node 22.6+ 原生支持；Node 20 无此 flag 则去掉）。
- 超时/输出截断复用 `run_bash` 的 120s / 30k 上限；`.py` 解释器回退：Windows `python → py`，
  POSIX `python3 → python`。
- **不经工具权限管线**（用户显式发起，同 `/plan` 语义）。

## 用户侧：斜杠命令

- `/commands`：列出全部自定义命令（名 + prompt 模板/脚本形态 + 用户级/项目级）。
- `/<命令名> [参数]`：执行命令。
- **内置命令优先**：命令名与内置斜杠命令冲突时内置赢（与技能/MCP「内置优先」同语义）。

## 示例

```bash
mkdir -p ~/.config/run-agent/commands
# 写 ~/.config/run-agent/commands/review.md …
run-agent                     # 进 REPL
run-agent> /review            # prompt 模板 → agent 循环执行
run-agent> /review src/       # 带参数（追加为模板末行）
run-agent> /my-script.py x y  # local 脚本 → stdout 展示
```

## 安全

- `.md` 模板 ≤ 100KB，超限跳过；项目级命令仅 Trust 加载（防提示注入）。
- local 命令是**用户显式发起**的脚本执行，不走工具权限弹窗；脚本是任意代码，仅放你自己
  信任的内容（与 `run_bash` 同理）。
