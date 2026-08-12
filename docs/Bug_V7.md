# Bug 记录 · V7「多 Agent 编排」— 权限判定待修清单

> 阶段：2026-08-12 ｜ 来源：真实模型 QA 审查（主 agent 委派 `qa` 子 agent 审 `src/permissions/engine.ts` 判定顺序）+ Claude Code 独立实证复核。
> **本文件只记「待修/待确认」的权限发现**——0.7.2 已修的各项（engine 只读闭包、粘贴合并、grep 单文件、空 completion 重试、后台收集接线、收尾轮、预算提示、粘贴末行滞留、来源标签）见 CHANGELOG [0.7.2] 与记忆记录，不在此重复。
> 6 条全部是**权限判定层**（`hasPermissionsToUseTool`，engine.ts:270）问题，属「判定顺序 / 匹配规则 / 覆盖范围」三个子维度。**等用户搞清楚权限控制后统一修**，勿单独零散处理。

| #      | 发现                                                                            | 子维度     | 严重度 | 状态         |
| ------ | ------------------------------------------------------------------------------- | ---------- | ------ | ------------ |
| V7-P1  | plan 分支在危险目录段检查前早退 → plan 下可读 `.git`/`.run-agent` 非 memory 内容 | 判定顺序   | 🟠 高  | ⏳ 待修（优先） |
| V7-P2  | acceptEdits 放行一切无路径工具（`!p` → allow），含 remember/MCP 无 path 工具     | 覆盖范围   | 🟡 中  | 🤔 待确认语义 |
| V7-P3  | 导航工具（enter/exit_plan_mode、mcp_connect）先于用户 deny → deny 规则失效        | 判定顺序   | 🟠 高  | ⏳ 待修（优先） |
| V7-P4  | DANGEROUS_PATTERNS 可绕过（`git -C … push --force`、`echo \| rm -rf /`、`of=//dev`）| 匹配规则   | 🟡 中  | ⏳ 待修（低优先） |
| V7-P5  | AGENT_DIR_BASH_RE 无 `/i` 旗标 → Windows 大小写变体 `.RUN-AGENT` 绕过             | 匹配规则   | 🟡 低  | ⏳ 待修（低优先） |
| V7-P6  | DENY_DIR_SEGMENTS 只认前导点段 → `~/.config/run-agent/` 不在保护范围              | 覆盖范围   | 🟢 低  | ⏳ 待评估     |

**共性问题**：所有「绕过」的实际影响基本都是 **deny→ask**（命令仍会弹窗给用户看），因为 `run_bash` 在 default/acceptEdits 下本就无条件 ask（engine.ts:338）。**唯一静默 allow 是 V7-P1**（plan 下读 `.run-agent`/`.git` 无弹窗直接放行）——最实质。

---

## V7-P1（高，优先修）plan 分支绕危险目录段

- **位置**：`src/permissions/engine.ts:289-303`（plan 分支）在危险目录段检查（:323）之前早退。
- **现象**：plan 模式下只读工具命中 `readOnlyNames + pathInCwd` 即 `allow`（:296-301），而 `.git`/`.run-agent` 危险目录段 deny（:323）根本没机会执行 → plan 下可读 `.run-agent/settings.json`、`.run-agent/skills/**`、`.run-agent/plans/**`、`.git/config`。
- **实证**（Claude Code 直跑 engine）：
  - `plan + read_file .run-agent/settings.json` = **allow**（default 下 = deny）
  - `plan + read_file .git/config` = **allow**（default 下 = deny）
  - `plan + read_file .run-agent/memory/x.md` = allow（memory 豁免，属预期）
  - `plan + agent`（无路径入参） = allow → 主 agent 在 plan 下可委派，子 agent 继承 plan 权限间接读
- **与设计矛盾**：engine.ts:14 注释声明 `.run-agent` 「写全禁 + 读仅 memory 专属通道」，plan 分支把「读仅 memory」这条打破了。`.run-agent/skills/settings` 内容可能含提示注入文本——plan 下可读等于重开读通道。
- **修复方向**：plan 分支内对 `.run-agent` 非 memory 路径仍 deny——把豁免收口到 `isMemoryReadExempt`（`forms.every`），只有 memory 通道放行；其余 `.run-agent`/`.git`/`.claude` 在 plan 下同样 deny。另评估 plan 下是否允许 `agent` 委派（借委派间接读的旁路）。
- **前提已验证**：`agent` 在 `readOnlyNames` 闭包内属实（cli/index.ts:365，V5 决策 B4）。

## V7-P2（中，待确认语义）acceptEdits 放行无路径工具

- **位置**：`src/permissions/engine.ts:340-347`（`!p` 分支），:344 `if (mode === "acceptEdits") return "allow"`。
- **现象**：无 `file_path`/`path`/`cwd` 入参的工具在 acceptEdits 模式下**无条件 allow**，MCP 工具（多数无 path 字段）、`remember`（写记忆）都命中。
- **实证**：`acceptEdits + remember`（无路径）= allow。
- **是否算漏洞**：取决于「acceptEdits = 接受编辑」的语义边界——如果它只应预授权 cwd 内文件写，那无路径工具（尤其 `remember` 写 `.run-agent/memory/`）不该一并放行。**需人工确认后再定**。

## V7-P3（高，优先修）导航工具先于用户 deny

- **位置**：`src/permissions/engine.ts:308-309`（enter/exit_plan_mode、mcp_connect 无条件 allow）在用户 deny 循环（:311-314）之前。
- **现象**：用户配置 `{"action":"deny","tool":"mcp_connect"}` 永不生效——mcp_connect 有真实副作用（发起外部服务连接），却被无条件放行。
- **实证**：`default + mcp_connect + deny 规则` = **allow**。
- **与设计矛盾**：engine.ts:260 注释「用户 deny 规则 → deny（用户显式 deny 优先于一切内置放行）」，文件头 :4 却把导航工具列在用户 deny 之前——**两处注释互相矛盾**，代码跟了前者。
- **修复方向**：用户 deny 循环提到导航工具之前（enter_plan_mode 等模式切换工具被 deny 后语义自洽——用户显式配置优先）；或至少 `mcp_connect` 遇显式 deny 规则让路。注意 plan 分支内的 enter/exit（:291-293）在 `mode === "plan"` 下已先处理，非 plan 下的导航检查只针对切换动作。

## V7-P4（中，低优先）DANGEROUS_PATTERNS 可绕过

- **位置**：`src/permissions/engine.ts:59-69`（DANGEROUS_PATTERNS）。
- **现象**：部分危险命令变体不命中，deny 降级为 ask。
- **实证**（Claude Code 直跑 `classifyBashCommand`）：
  - `git -C repo push --force` = **safe**（`git\s+push` 要求相邻，中间隔 `-C repo` 不命中）→ 真绕过
  - `echo x | rm -rf /` = risky（开头不是 `rm`，dangerous 不命中；RISKY `\brm\b.*-rf` 兜住）→ 降 ask
  - `dd if=x of=//dev/sda` = **safe**（`of=` 后是 `//dev` 双斜杠，`(\/dev|\/etc|\/var)\b` 不命中）→ 真绕过
  - **`rm -rF /` = dangerous（命中）**——⚠️ **qa 子 agent 声称「不命中」是错的，主 agent 复核也复述了这个错误**：`/i` 旗标让 `[a-z]*` 吃掉大写 `F`（`[a-z]*`+"r"+`[a-z]*`="F"），正则完整匹配 `-rF /`。两条 LLM 都在「推演正则」，全错。
- **影响**：deny→ask，非静默放行（default 下 run_bash 本就 ask，engine.ts:338）；注释 :22 自认「不承诺穷尽 shell 拼接绕过，尽力而为」。
- **修复方向**：补宽松正则（`git\s+-\S+\s+push.*--force`、`of=//dev` 变体等）。低优先。
- **教训**：正则类审查**必须实跑引擎验证**（verification 子 agent 可 `run_bash` 跑 `classifyBashCommand` 戳穿），推演正则不可靠。`qa` 类型只配 `read_file`/`grep`、无 `run_bash`，这类审查天生劣势。

## V7-P5（低，低优先）AGENT_DIR_BASH_RE 无 `/i`

- **位置**：`src/permissions/engine.ts:24`（`AGENT_DIR_BASH_RE`）。
- **现象**：命令文本里 `.RUN-AGENT\...` 大小写变体不命中（Windows/PowerShell 访问大小写不敏感），且与 DANGEROUS_PATTERNS 全带 `/i` 不一致。
- **影响**：绕过也只到 ask（run_bash 兜底 ask）；Windows 下需实测确认。
- **修复方向**：补 `/i` 旗标（一行）。注意 `.run-agent` 后紧跟 `(?![\w-])` 的 lookahead 与 `(?<=^|[\s\\/'"`=(;|&])` 前缀约束照旧保留。

## V7-P6（低，待评估）用户级配置目录不在保护范围

- **位置**：`src/permissions/engine.ts:16`（`DENY_DIR_SEGMENTS = {".git",".claude",".run-agent"}`）。
- **现象**：`~/.config/run-agent/settings.json` 的段是 `.config`/`run-agent`（后者无前导点）→ 不 deny；常态下路径在 cwd 外 → 靠兜底 ask 挡住。
- **实证**：`default + read_file C:/Users/…/.config/run-agent/settings.json`（cwd 外）= ask。
- **评估**：属纵深防御缺口，低危（ask 兜底在）。是否纳入待定——`settings.json` 含 hook 命令（读不执行），且用户级目录本就不该纳入项目 cwd 的 deny 语义。**留给统一修时一并评估**。

---

## 验证方法（Claude Code 独立复核）

以上实证全部是**直跑真实 engine** 得出，非推演：

```bash
npx tsx -e '…'   # import hasPermissionsToUseTool / classifyBashCommand
```

- 判定顺序类（P1/P2/P3/P6）：调 `hasPermissionsToUseTool(tool, input, mode, rules, isTrusted, cwd, readOnlyNames)`，`readOnlyNames` 闭包按 cli/index.ts:362-368 复刻（内置只读 + explore + 三件套 + MCP hint）。
- 匹配规则类（P4/P5）：直接调 `classifyBashCommand` / `new RegExp(...).test(...)` 逐命令实证。

## 修复批次建议

统一修时按这个顺序（改动最小 → 收益最大）：
1. **V7-P1 + V7-P3**：判定顺序收口（plan 分支内 `.run-agent` 非 memory 仍 deny；用户 deny 提到导航工具前）。
2. **V7-P4 + V7-P5**：补正则（`/i` + `git -C`/`of=//dev` 变体）。
3. **V7-P2 + V7-P6**：确认语义 / 评估纵深后决定（可能「不改」也成立）。
