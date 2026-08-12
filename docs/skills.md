# Skills（0.6.0）

> V6「可编程化」三件套之一。Skills 是预写的专业工作流——把一段固定的指令 + 可选工具限制
> 打包成「技能」，模型用 `SkillTool` 加载并执行，或你在 REPL 里直接 `/技能名` 触发。
> 路径用 run-agent **自有路径**（无 `.claude/`）。

## 放哪

- **用户级** `~/.config/run-agent/skills/<name>/SKILL.md`——始终加载（用户自写）。
- **项目级** `<cwd>/.run-agent/skills/<name>/SKILL.md`——**仅 Trust 会话加载**（防提示注入）。
- 每个技能是一个目录，`SKILL.md` 是技能定义。同名去重：**用户级优先**，项目级同名丢弃。

## SKILL.md 格式

frontmatter（YAML 子集，只认三个键）+ 正文（技能指令文本）：

```markdown
---
name: code-review
description: 对改动文件做一轮代码审查，输出问题清单
allowed-tools:
  - read_file
  - glob
  - grep
  - run_bash
---

# 代码审查工作流

1. 先跑 `git diff` 找改动文件
2. 逐个读关键文件，找 bug / 隐患 / 风格问题
3. 输出问题清单，按严重度排序
```

| 键              | 必填 | 说明                                                               |
| --------------- | ---- | ------------------------------------------------------------------ |
| `name`          | ✅   | 技能名，`^[a-z0-9][a-z0-9_-]*$`，被 `SkillTool` 与 `/技能名` 引用  |
| `description`   | ✅   | 一行描述，注入 system 清单 + `SkillTool` 未知技能时的提示          |
| `allowed-tools` |      | 限制本技能可用工具（支持 `mcp__*` 通配）；**内置只读工具始终保留** |
| （正文）        |      | 技能指令，模型调用时以 tool_result 全文返回                        |

- 单文件上限 100KB，非法 frontmatter / 超限 → 跳过并告警（不阻断启动）。
- 加载器直接 fs 直读（`.run-agent` 是内置 deny 段），模型没有任何工具能偷看技能文件。

## 模型侧：SkillTool

- 有技能时会装配 **`SkillTool`** 工具（`inputSchema: { name, args? }`）：
  1. 按 `name` 找技能；未找到 → 返回「未知技能」+ 可用技能清单。
  2. 命中 → 从磁盘**现读** SKILL.md，把**全文**回填 tool_result，模型接下来按指令执行。
  3. 激活技能：本 turn 剩余可用工具 = `allowed-tools ∩ 工具池`（无 `allowed-tools` 则不限制）。
- **body 惰性加载（渐进式披露，对齐 Claude Code）**：registry 只持有「frontmatter + 文件路径」，
  **启动不读 body**；`SkillTool` 调用 / `/技能名` 时才经 `readSkillBody` 从磁盘现读——内存不膨胀，
  改 SKILL.md 无需重启即热更新。system 只注入「技能名 + 描述」清单（一行一个），body 不塞 token。
- **只读工具**：`SkillTool` 无副作用（只回填文本），归内置只读——default 模式 / headless
  （`--print`）免确认直接 allow（否则 headless 无弹窗会降级 deny，技能加载全废）。
- `SkillTool` 改变工具池状态 → 串行（`isConcurrencySafe: false`）。

## 用户侧：斜杠命令

- `/skills`：列出可用技能（名 + 描述 + 用户级/项目级）。
- `/<技能名> [参数]`：手动加载技能后执行一轮（body 直接作为 prompt，参数追加）。
- **内置命令优先**：技能名与内置斜杠命令冲突时内置赢（与 MCP「内置优先」同语义）。

## 示例

```bash
mkdir -p ~/.config/run-agent/skills/release
# 写 ~/.config/run-agent/skills/release/SKILL.md …
run-agent                      # 进 REPL
run-agent> /release 0.6.0      # 或 /skills 查看后手动触发
run-agent> 用 SkillTool 加载 code-review 技能做一轮审查
```
