# Bug 记录 · V7「多 Agent 编排」

> 阶段：2026-08-12 ｜ 交付：`0.7.0`（多 Agent 基建 + 协调者三件套）+ `0.7.1`（verification + 后台记忆提取）+ `0.7.2`（异常修复批 + 预算提示 + 来源标签 + 动态类型列出，480 用例）。
> 来源：会话记录、git 提交 `d28b254` / `f96202b` / `56ece71`、用户真实模型实测（3 次反馈子 agent 空结论）+ 真实模型 QA 审查 + Claude Code 独立实证复核。
> **V7 共记录 13 个已解决 bug + 6 个待修权限发现 + 1 个已知未修。** 全部集中在「权限判定 / 子 agent 编排 / REPL 交互」三条线。

## 总览

| #      | Bug                                                                                    | 类别         | 严重度 | 状态         |
| ------ | -------------------------------------------------------------------------------------- | ------------ | ------ | ------------ |
| V7-1   | engine step-7 用硬编码只读集 → 协调者三件套/explore 在 default 下必 ask（首调被拒）       | 权限/编排    | 🟠 高  | ✅ 已解决     |
| V7-2   | REPL 多行粘贴逐 line 触发并发 runTurn + 无换行残留污染权限弹窗答案                        | 交互/REPL    | 🟠 高  | ✅ 已解决     |
| V7-3   | grep 单文件路径用 readdir 抛错被吞 → 永远「未找到匹配」→ 取证证据链断裂                   | 工具/取证    | 🟠 高  | ✅ 已解决     |
| V7-4   | 空 completion 无兜底 → 子 agent 静默空结论                                              | 编排         | 🟡 中  | ✅ 已解决     |
| V7-5   | 后台收集接线缺失：onBackgroundDone 未传 runQuery → 协调者委派后闭嘴不汇总                | 编排         | 🟠 高  | ✅ 已解决     |
| V7-6   | 子 agent 空结论真根因：预算撞顶只回末轮工具调用前的文本片段（用户 3 次反馈）               | 编排         | 🟠 高  | ✅ 已解决（收尾轮） |
| V7-7   | 两行粘贴末行滞留成下一条「待输入」                                                        | 交互/REPL    | 🟡 中  | ✅ 已解决     |
| V7-8   | 自定义 agent 缺 frontmatter 开头 `---` → 加载器解析失败、启动告警跳过                    | 配置/加载    | 🟡 中  | ✅ 已解决     |
| V7-9   | agent 类型发现缺口：模型看不见 `.run-agent/agents/*.md` → 猜/搜/试图创建被拒              | 编排/UX      | 🟡 中  | ✅ 已解决（动态列类型） |
| V7-10  | `--max-turns` 契约：撞顶仍在调工具时 reply 是半截话                                      | CLI          | 🟡 中  | ✅ 已解决     |
| V7-11  | `PermissionCheckResult` 联合类型直接 `.decision` → TS2339                               | 工程/TS      | 🟢 低  | ✅ 已解决     |
| V7-12  | `buildExtractPrompt` 单条超限用 break → 超长首条丢弃后续全部                             | 记忆提取     | 🟢 低  | ✅ 已解决     |
| V7-13  | 测试 FakeClient 未浅拷贝 `[...messages]` → 请求数组被后续污染                            | 测试         | 🟢 低  | ✅ 已解决     |
| V7-P1  | plan 分支在危险目录段检查前早退 → plan 下可读 `.git`/`.run-agent` 非 memory 内容          | 权限判定     | 🟠 高  | ⏳ 待修（优先） |
| V7-P2  | acceptEdits 放行一切无路径工具（`!p` → allow），含 remember/MCP 无 path 工具              | 权限判定     | 🟡 中  | 🤔 待确认语义 |
| V7-P3  | 导航工具（enter/exit_plan_mode、mcp_connect）先于用户 deny → deny 规则失效                | 权限判定     | 🟠 高  | ⏳ 待修（优先） |
| V7-P4  | DANGEROUS_PATTERNS 可绕过（`git -C … push --force`、`echo \| rm -rf /`、`of=//dev`）       | 权限判定     | 🟡 中  | ⏳ 待修（低优先） |
| V7-P5  | AGENT_DIR_BASH_RE 无 `/i` 旗标 → Windows 大小写变体 `.RUN-AGENT` 绕过                     | 权限判定     | 🟡 低  | ⏳ 待修（低优先） |
| V7-P6  | DENY_DIR_SEGMENTS 只认前导点段 → `~/.config/run-agent/` 不在保护范围                      | 权限判定     | 🟢 低  | ⏳ 待评估     |
| V7-K1  | `context.test.ts` collectGitContext git 命令偶发超时（隔离跑绿，CI 偶红）                  | 测试稳定性   | 🟡 中  | ⚠️ 已知未修   |

---

## 一、已解决（0.7.1 开发期 + 0.7.2 修复批）

### V7-1（高）engine step-7 硬编码只读集 → 协调者三件套/explore 在 default 下必 ask

- **现象**（用户实测）：`--coordinator` 并行 explore 子 agent 的**首调被拒「未获授权」**。
- **根因**：engine step-7 兜底用硬编码 `READ_ONLY_TOOLS`（`src/permissions/engine.ts`），而 REPL/CLI 装配的 `readOnlyNames` **扩展闭包**（内置只读 ∪ explore ∪ 协调者三件套 ∪ MCP readOnlyHint）只传给 `hasPermissionsToUseTool` 的第 7 参，step-7 没用到 → 三件套/explore 不归只读，default 下必 ask。
- **修复**：engine.ts 两处（`!p` 分支与 `pathInCwd` 分支）改用 `readOnlyNames(tool)`（现 :345/:349，:342 有注释说明）。`tests/permissions/engine.test.ts` +2 用例。
- **教训**：权限判定闭包必须**单一来源**——扩展集合只能由装配层注入，判定函数内部不得再硬编码另一份。

### V7-2（高）REPL 多行粘贴逐 line 触发并发 runTurn + 残留污染弹窗答案

- **现象**：多行粘贴被 readline 拆成逐 line 事件，每行触发一次并发 `runTurn`；无换行末行残留滞留在缓冲，随后权限弹窗的答案被残留污染。
- **根因**：REPL 没有行收集/合并机制，且弹窗前不冲刷 readline 残留。
- **修复**（repl.ts）：收集器 300ms 防抖 + 串行队列 + ask 弹窗前 `rl.write("\n")` 冲残留。新文件 `tests/repl_paste.test.ts` 5 用例。
- **教训**：stdin 交互必须假设用户会粘贴多行文本，逐行即处理是最坏实现。

### V7-3（高）grep 单文件路径 readdir 抛错被吞 → 永远「未找到匹配」

- **现象**：explore 子 agent 按「文件:行号」grep 取证全部失败，证据链断裂 → 空/半截结论。
- **根因**：`grep` 工具 `path` 指向**单个文件**时，`collectFiles` 对文件路径调 `readdir` 抛错被静默吞掉 → 永远返回「未找到匹配」。
- **修复**（grep.ts）：`stat` 判断单文件直接搜（:91-92 `isSingleFile`）、显示路径用用户传入 path（:103）、glob 同 rel 判定。`tests/tools/grep.test.ts` +4 用例。
- **教训**：工具对「路径是文件还是目录」必须显式分流；静默吞异常会让工具永远返回看似合理实则错误的结果，最伤取证类工作流。

### V7-4（中）空 completion 无兜底 → 子 agent 静默空结论

- **现象**：子 agent 偶发 `end_turn` 无文本无工具 → 返回空结论，协调者拿到 `[<类型> 结论]\n` 误以为成功。
- **修复**（query.ts）：end_turn 空响应 → 有界重试 `MAX_EMPTY_RETRIES=2`/`EMPTY_RETRY_DELAY_MS=400`，放在 `onBackgroundDone` 之后防后台汇总被空重试吞掉；agent.ts 空 reply 给「子 agent 空结论——重试后仍无文本输出」明确提示。`tests/core/query.test.ts` +3 用例。
- **教训**：空响应是快模型常态，必须有「重试 + 明确失败语义」双保险，不能把空当成功。

### V7-5（高）后台收集接线缺失 → 协调者委派后闭嘴不汇总

- **现象**（用户复测）：协调者 spawn 2 个后台 explore 后 `end_turn`，**只说「等待它们返回后我会汇总结果」就闭嘴**——后台结果完成也没人收集。
- **根因**：`onBackgroundDone` 从未传给 `runQuery` → `awaitAll` 没被调用，后台汇总注入点根本没接线。
- **修复**（repl.ts）：queryOpts 加 `onBackgroundDone: () => opts.backgroundTasks!.awaitAll()`，REPL 与 headless 共用。`tests/cli/background-collect.test.ts` 2 用例。
- **教训**：回调挂点必须在**两个入口**（REPL + headless）都接线，只接一处等于没接。

### V7-6（高）子 agent 空结论真根因：预算撞顶只回末轮片段（收尾轮）

- **现象**（用户第 3 次反馈「子 agent 还是会返回空内容」）：explore 子 agent 把 8 轮全花在取证、末轮仍是「Let me get exact line numbers… + grep tool_use」→ `runQuery` 撞 `maxIterations` 返回的 `reply` 只含末轮工具调用前的文本片段。
- **根因**：撞顶返回 `reply` = 末轮 stream 累积文本，而末轮是工具调用、结论还没说出口 → 半截话被当成结论。
- **修复**（query.ts）：`finalizing` 收尾轮——预算耗尽且末轮仍 `tool_use`/`max_tokens`/`error`、或空重试耗尽 → 注入「请给出最终结论」指令 + **`tools: []`** 再流一轮（有界，只多一轮），`reply` 即结论；收尾轮内再截断/出错/空/调工具 → 直接有界返回防 `while(finalizing)` 死循环。explore 预算上调 medium 8→12/very thorough 12→16（quick=4）。
- **教训**：子 agent 拿不到「我的轮数快用完了」的信号，把预算全押在取证上是天然倾向——治本靠预算提示（V7-6 的 L1 注入），兜底靠收尾轮。

### V7-7（中）两行粘贴末行滞留成下一条「待输入」

- **现象**（用户实测）：下一轮 `run-agent>` 提示符上出现自己没输入的文本（末行滞留），甚至被误提交。
- **根因**：末行无换行收尾的粘贴只发 `n-1` 个完整 line 事件，旧 drain 门槛 `inputBuf.length>=2` 不触发 → 末行滞留在 readline 内部缓冲。Node v24 的公共 getter `rl.line` 在事件时刻已置空，残留存于 `Symbol(_line_buffer)`（Node ≤22 是 `_line` 字段）。
- **修复**（repl.ts）：line 事件后 `setImmediate` 查 readline 残留（版本容错 helper `readlineTail`），同 chunk 有残留 → 标记 `pasteTailPending` → flush 并入本 prompt；「提交后新输入」是独立 chunk、事件时刻残留为空 → 不误收。`tests/repl_paste.test.ts` 新用例（l1\nl2 断言单条 prompt `"l1\nl2"`，修复前只得 `"l1"`）。
- **教训**：readline 内部字段跨版本改名，查内部状态必须版本容错；残留判断要靠「同一 chunk」区分粘贴尾 vs 新输入。

### V7-8（中）自定义 agent 缺 frontmatter 开头 `---` → 加载器解析失败

- **现象**：`.run-agent/agents/qa.md` 启动时被报「非法 agent 定义」跳过，模型始终拿不到 `qa` 类型。
- **根因**：`loader.ts` `parseAgentFile` 正则 `/^---\r?\n/` 要求**开头就是 frontmatter 定界符**，qa.md 缺失开头的 `---`（文件首行直接是内容）→ 解析失败。
- **修复**：补上开头的 `---`。loader 测试 8/8 通过。
- **教训**：frontmatter 格式错误的表现是「静默跳过 + 启动告警」，用户看不到原因；文档示例与解析器要求必须一致。

### V7-9（中）agent 类型发现缺口 → 模型猜/搜/试图创建类型

- **现象**（用户贴 transcript）：主 agent 因为看不见 `qa` 类型，glob/grep 搜 `.run-agent/agents/**/*.md` 无果 → 断定类型不存在 → 试图 `write_file .run-agent/agents/qa.md` 创建 → 被引擎硬拒。
- **根因**：`glob`/`grep` 的 `ALWAYS_IGNORE` 默认跳过 `.run-agent`（搜索工具结构性盲区）；`agent` 工具描述里没列出自定义类型；写 `.run-agent/` 被引擎 deny → 三面碰壁。
- **修复**：`makeAgentTool` 顶部从 registry 快照类型名注入 description（`registry.list().map(t=>t.name).join(" / ")`）——模型直接见 `agentType` 可选值。`tests/tools/agent.test.ts` +1 用例。
- **教训**：任何「模型需要知道但工具看不见」的类型/配置，必须在工具 schema 或 system 里显式披露，不能指望模型去文件系统考古。

### V7-10（中）`--max-turns` 契约：撞顶调工具时 reply 半截

- **现象**：headless `--max-turns` 撞顶且模型仍在调工具时，`reply` 是半截话。
- **修复**：撞顶仍调工具 → 多跑一轮纯文本收尾（`turns` 含该轮），保证 `reply` 是结论。契约变为「N 轮工具循环 + 至多 1 轮收尾」（headless.test.ts 断言 turns=3/tools=3 且收尾轮工具走「未知工具」轨迹）。

### V7-11（低）`PermissionCheckResult` 联合类型直接 `.decision` → TS2339

- **现象**：`PermissionCheckResult` 是 `Decision | {decision, reason?}` 联合，直接 `.decision` 在字符串分支编译报 TS2339。
- **修复**：用 `decisionOf()` 辅助函数窄化（src/core/execute.js）。

### V7-12（低）`buildExtractPrompt` 单条超限用 break → 丢后续全部

- **现象**：记忆提取 prompt 构造时，首条消息超限就 `break` → 后续所有增量消息全部丢弃。
- **修复**：改 `continue` 跳过超长单条。`tests/services/extract/extract.test.ts` 覆盖。

### V7-13（低）测试 FakeClient 未浅拷贝 `[...messages]` → 请求数组污染

- **现象**：`runQuery` 无 system 时 `requestMessages` 与内部 `messages` 同引用，`pushConversation` 污染已记录数组 → 测试断言错乱。
- **修复**：测试 FakeClient 必须浅拷贝 `[...messages]`。

---

## 二、待修/待确认（真实模型 QA 权限发现）

来源：主 agent 委派 `qa` 子 agent 审 `src/permissions/engine.ts` 判定顺序 + Claude Code 独立实证复核（直跑 engine，非推演）。全部是权限判定层问题，**等用户搞清楚权限控制后统一修**，勿零散处理。

**共性问题**：所有「绕过」的实际影响基本都是 **deny→ask**（命令仍会弹窗给用户看），因为 `run_bash` 在 default/acceptEdits 下本就无条件 ask（engine.ts:338）。**唯一静默 allow 是 V7-P1**（plan 下读 `.run-agent`/`.git` 无弹窗直接放行）——最实质。

### V7-P1（高，优先修）plan 分支绕危险目录段

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

### V7-P2（中，待确认语义）acceptEdits 放行无路径工具

- **位置**：`src/permissions/engine.ts:340-347`（`!p` 分支），:344 `if (mode === "acceptEdits") return "allow"`。
- **现象**：无 `file_path`/`path`/`cwd` 入参的工具在 acceptEdits 模式下**无条件 allow**，MCP 工具（多数无 path 字段）、`remember`（写记忆）都命中。
- **实证**：`acceptEdits + remember`（无路径）= allow。
- **是否算漏洞**：取决于「acceptEdits = 接受编辑」的语义边界——如果它只应预授权 cwd 内文件写，那无路径工具（尤其 `remember` 写 `.run-agent/memory/`）不该一并放行。**需人工确认后再定**。

### V7-P3（高，优先修）导航工具先于用户 deny

- **位置**：`src/permissions/engine.ts:308-309`（enter/exit_plan_mode、mcp_connect 无条件 allow）在用户 deny 循环（:311-314）之前。
- **现象**：用户配置 `{"action":"deny","tool":"mcp_connect"}` 永不生效——mcp_connect 有真实副作用（发起外部服务连接），却被无条件放行。
- **实证**：`default + mcp_connect + deny 规则` = **allow**。
- **与设计矛盾**：engine.ts:260 注释「用户 deny 规则 → deny（用户显式 deny 优先于一切内置放行）」，文件头 :4 却把导航工具列在用户 deny 之前——**两处注释互相矛盾**，代码跟了前者。
- **修复方向**：用户 deny 循环提到导航工具之前（enter_plan_mode 等模式切换工具被 deny 后语义自洽——用户显式配置优先）；或至少 `mcp_connect` 遇显式 deny 规则让路。注意 plan 分支内的 enter/exit（:291-293）在 `mode === "plan"` 下已先处理，非 plan 下的导航检查只针对切换动作。

### V7-P4（中，低优先）DANGEROUS_PATTERNS 可绕过

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

### V7-P5（低，低优先）AGENT_DIR_BASH_RE 无 `/i`

- **位置**：`src/permissions/engine.ts:24`（`AGENT_DIR_BASH_RE`）。
- **现象**：命令文本里 `.RUN-AGENT\...` 大小写变体不命中（Windows/PowerShell 访问大小写不敏感），且与 DANGEROUS_PATTERNS 全带 `/i` 不一致。
- **影响**：绕过也只到 ask（run_bash 兜底 ask）；Windows 下需实测确认。
- **修复方向**：补 `/i` 旗标（一行）。注意 `.run-agent` 后紧跟 `(?![\w-])` 的 lookahead 与 `(?<=^|[\s\\/'"`=(;|&])` 前缀约束照旧保留。

### V7-P6（低，待评估）用户级配置目录不在保护范围

- **位置**：`src/permissions/engine.ts:16`（`DENY_DIR_SEGMENTS = {".git",".claude",".run-agent"}`）。
- **现象**：`~/.config/run-agent/settings.json` 的段是 `.config`/`run-agent`（后者无前导点）→ 不 deny；常态下路径在 cwd 外 → 靠兜底 ask 挡住。
- **实证**：`default + read_file C:/Users/…/.config/run-agent/settings.json`（cwd 外）= ask。
- **评估**：属纵深防御缺口，低危（ask 兜底在）。是否纳入待定——`settings.json` 含 hook 命令（读不执行），且用户级目录本就不该纳入项目 cwd 的 deny 语义。**留给统一修时一并评估**。

---

## 三、已知未修

### V7-K1（中）`context.test.ts` collectGitContext git 命令偶发超时

- **现象**：全量测试偶发失败——临时 `git init` 仓库里 `collectGitContext` 返回 `branch` 为 `undefined`（断言 `expect(ctx.branch).toBeTruthy()` 挂）。**隔离跑必然全绿**。
- **根因**：git 首次调用要初始化配置/索引，Windows 下子进程启动开销大，并行跑时 `execFile` 的 800ms 超时不够（与 V4-3/V4.5-8 同源）。
- **状态**：已知 flake，不修（测试超时已有缓解：vitest testTimeout 30s；根治要动 `collectGitContext` 内部超时，收益低）。**重跑确认绿即可，勿当作新 bug 排查。**

---

## 验证方法（Claude Code 独立复核）

以上权限实证全部是**直跑真实 engine** 得出，非推演：

```bash
npx tsx -e '…'   # import hasPermissionsToUseTool / classifyBashCommand
```

- 判定顺序类（P1/P2/P3/P6）：调 `hasPermissionsToUseTool(tool, input, mode, rules, isTrusted, cwd, readOnlyNames)`，`readOnlyNames` 闭包按 cli/index.ts:362-368 复刻（内置只读 + explore + 三件套 + MCP hint）。
- 匹配规则类（P4/P5）：直接调 `classifyBashCommand` / `new RegExp(...).test(...)` 逐命令实证。

## 修复批次建议（待修项）

统一修时按这个顺序（改动最小 → 收益最大）：
1. **V7-P1 + V7-P3**：判定顺序收口（plan 分支内 `.run-agent` 非 memory 仍 deny；用户 deny 提到导航工具前）。
2. **V7-P4 + V7-P5**：补正则（`/i` + `git -C`/`of=//dev` 变体）。
3. **V7-P2 + V7-P6**：确认语义 / 评估纵深后决定（可能「不改」也成立）。

> 附注：CHANGELOG [0.7.2] Fixed 段只记了 3 条（收尾轮 / --max-turns / 粘贴滞留），本文件的 V7-1/2/3/4/5 已在 commit `56ece71` 里但 CHANGELOG 漏记——如后续出 0.7.3 可一并回填。
