# Plan V4.5 — 权限模型重构:bypass 删除 + 黑/白/专属通道三合一(交付 0.4.2)

> 上游:`docs/Plan.md` 权限持续演进 + `docs/permissions.md`(V2 权限语义)。
> 上一版本交接:`docs/Plan_V4.md`(0.4.0 记忆读豁免 / 0.4.1 代码理解)。**本版与 V4 记忆方案的读豁免有交集,实施顺序建议 V4 先行**(见 §5)。
> 本版本一句话:把「路径段黑名单 + 命令正则黑名单」这套尽力而为的防线,重构为「**危险目录黑名单 + 工作目录白名单 + 专属通道**」三层明确模型,并**删除 bypass 模式**——权限收敛到可论证、可测试。
> 触发:2026-08-11 安全审计(会话记录)发现 5 类接缝/缺口——① `glob`/`grep` 内部遍历不查 `.run-agent`(遍历层 ≠ 权限层);② `run_bash` 正则黑名单可被 shell 拼接绕过(`.run''-agent`、变量拼接等);③ symlink / 大小写可绕过路径段黑名单;④ 只读工具可读 **cwd 外任意文件**(`read_file ~/.ssh/id_rsa` 直接 allow);⑤ `--mode bypass` 一条命令击穿全部防线(engine 第一行短路,比 Claude Code 更裸——Claude Code 的 bypass 背后还有 OS 沙箱 + dangerousPatterns 兜底)。对照 Claude Code 源码(`F:\CC_Source\claude-code-sourcemap\restored-src\src\utils\permissions\*`)确认其采用混合模型,本版对齐。
> 工期参考:≈ 1 周,交付 `0.4.2`。

## §0 结论速览

**交付什么**:

- **删除 bypass 模式**(决策 A):`PERMISSION_MODES` 去掉 `bypass`;删 `--mode bypass` / `--dangerously-skip-permissions` 两个入口;engine 删除 `if (mode === "bypass") return "allow"` 短路。这是 5 类缺口里**最值钱**的一条——一行短路让所有黑名单/白名单/专属通道全部失效,不先删它,其余都是白搭。
- **工作目录白名单**(决策 B):权限判定引入 **cwd 边界**。路径在 cwd 内 → 按现有 mode 兜底(只读 allow、acceptEdits 写 allow、default 写 ask);**cwd 外 → 只读工具也 ask**(one-shot `canPrompt=false` 时降级 deny),除非用户 allow 规则或专属通道。修掉缺口 ④。
- **危险目录黑名单收窄 + 专属通道**(决策 C):`DENY_DIR_SEGMENTS` 语义明确为「cwd 内的危险子目录,工具一律不可读写」,保留 `.git`/`.claude`/`.run-agent`;`.run-agent/memory/**` 读豁免(V4 已设计)正式化为**专属通道**,判定顺序在危险目录 deny **之前**放行(仿 Claude Code `checkReadableInternalPath` 的 internal-path carve-out)。
- **统一判定顺序**(决策 D):bypass 删除后重排 `hasPermissionsToUseTool` 为「内置危险命令 → 用户 deny → 专属通道 → 危险目录 → 白名单 → 用户 allow → 兜底 ask」,与 Claude Code `checkRead/WritePermissionForTool` 的「deny 先于一切 allow」对齐。
- **硬化项学 Claude Code**(决策 E):realpath 双形态检查(防 symlink)、路径段小写化比较(防大小写)、Windows 路径模式检测(ADS/8.3/长前缀/尾随点/UNC → ask)、**遍历层对齐**(决策 F):`glob`/`grep` 的 `ALWAYS_IGNORE` 加 `.run-agent`,修缺口 ①。
- **明确不做**(诚实标注):`run_bash` 完整 AST 解析——零依赖下**可行但工程量过大**(Claude Code 用 4436 行纯 TS 重实现 tree-sitter-bash 验证过,见决策 E 4b),收益与既有防线(必 ask + 危险命令 deny)不匹配,不进本版;`AGENT_DIR_BASH_RE` 保持「第二道防线」定位,文档注明它不是保证。

**技术栈增量**:零新依赖(realpath/大小写/路径模式检测全是 Node 内置 + 正则)。

**不做的事(留待后续)**:

- `additionalWorkingDirectories`(多工作目录)→ 后续版本;V4.5 只做单一 cwd,cwd 外访问的唯一通道是用户 allow 规则。
- `run_bash` 完整 AST 解析(PowerShell/Bash 语法树提取路径)→ 后续评估(见决策 E 4b——Claude Code 证明确能纯 TS 重实现,但工程量巨大、收益不匹配,留待单独版本)。
- 危险命令白名单降级/可配置 → 保持现状(内置不可覆盖)。
- V4/V4.1 的计划内容本身不变,本版只重构权限层。

---

## §1 架构决策

### 决策 A:删除 bypass 模式

- `src/permissions/types.ts`:`PermissionMode = "default" | "acceptEdits" | "bypass"` → `"default" | "acceptEdits"`。
- `src/cli/index.ts:25`:`PERMISSION_MODES = ["default", "acceptEdits"]`;删 `-M, --mode <mode>` 的 bypass 选项值与 `--dangerously-skip-permissions` flag。
- `src/permissions/engine.ts:142`:删除 `if (mode === "bypass") return "allow";`。
- **兼容处理**:`config.json` / env 已有 `mode: "bypass"` → `resolveMode`(cli/index.ts:91)遇未知/非法值**回退 `"default"` 并在启动时打印一条警告**(不静默、不崩溃);`--mode bypass` 直接报 commander 非法值错误。
- **文档同步**:`README` / `docs/usage.md` / `docs/permissions.md` 移除 bypass 提及;`docs/Plan_V4.md` §1 决策 A 里 "`bypass` 无条件" 的表述同步改掉(那是 V4 记忆写通道对权限引擎行为的假设)。
- **测试**:`tests/permissions/engine.test.ts` 删除 bypass 短路用例;`tests/cli.test.ts` 的 `--dangerously-skip-permissions` / `--mode bypass` 用例改为断言"非法参数 / 回退 default"。

### 决策 B:工作目录白名单(cwd 边界)

**动机**:现状 `engine.ts:152` 兜底 `READ_ONLY_TOOLS → allow` **不校验路径位置**——`read_file /etc/shadow`、`grep ~/.ssh` 全部放行。这是独立于 `.run-agent` 的真实缺口。

**判定**:`hasPermissionsToUseTool` 增加 cwd 参数(PermissionContext 注入),新增 `pathInCwd(path, cwd)`:

- 路径在 cwd 内 → 走现有兜底(只读 allow;`acceptEdits` 写 allow;`default` 写 ask)。
- **路径在 cwd 外** → 只读工具**不再 allow**,与写类一样 `ask`(`canPrompt=false` 时降级 deny);除非命中用户 allow 规则(第 7 步)或专属通道。
- `acceptEdits` 收窄:现状"写/改免确认"不看路径,改为**仅 cwd 内免确认**;cwd 外写仍 ask(对齐 Claude Code `acceptEdits && isInWorkingDir`)。

**realpath 双形态**(防 symlink,决策 E 的一部分,此处一并):判定用 `[expandPath(path), realpath(path)]` 两个形态,**两者都必须在 cwd 内**才算 cwd 内;任一在 cwd 外 → 视为 cwd 外。防 `foo`(symlink → `.run-agent/x`)这类换名逃逸。macOS `/var → /private/var` 之类的系统 symlink 用「resolve 后与 resolve 后的 cwd 比较」(对齐 Claude Code `pathInWorkingPath` 的对称 resolve)。

**逃生通道**:cwd 外访问的唯一合法途径 = 用户 allow 规则(现有 `PermissionRule` 机制)。文档写明:one-shot(不弹窗)下读 cwd 外会被直接 deny,需要用户预先配置 allow 规则——这是安全优先的取舍。

### 决策 C:危险目录黑名单收窄 + 专属通道

**黑名单语义明确为「危险目录」**:`DENY_DIR_SEGMENTS = {".git", ".claude", ".run-agent"}` 保留,但文档/注释从「agent 自身目录不可读写」升级为 Claude Code 式语义——**cwd 内的敏感/易被用于代码执行或数据外泄的目录,工具一律不可读写**(含 `.run-agent`,它在 cwd 内,白名单天然覆盖不到,必须单独封)。`run_bash` 命令文本含 `.run-agent` 段(`AGENT_DIR_BASH_RE`)保留;危险命令 `DANGEROUS_PATTERNS` 保留且**在 bypass 删除后成为最高级不可绕过保护**。

**专属通道(internal-path carve-out,仿 Claude Code `checkEditableInternalPath` / `checkReadableInternalPath`)**:

| 通道                                        | 放行                                              | 门控                          | 判定位置                 |
| ------------------------------------------- | ------------------------------------------------- | ----------------------------- | ------------------------ |
| `.run-agent/memory/**` 读                   | `read_file`/`glob`/`grep`                         | Trust 会话                    | **在危险目录 deny 之前** |
| `.run-agent/memory/**` 写                   | 仅 `remember` 工具(无路径入参,天然绕过 inputPath) | Trust + 权限引擎 + scope 门控 | V4 已设计,不变           |
| `.run-agent/CLAUDE.md` / `permissions.json` | 不放行                                            | —                             | 仍 deny                  |

判定顺序关键:**专属通道必须在危险目录检查之前放行**,否则 memory 在 `.run-agent` 下,先被危险目录拦掉,豁免形同虚设。对齐 Claude Code 的注释规则 "internal-path carve-out MUST come before the dangerous-directory check"。

### 决策 D:统一判定顺序(新 `hasPermissionsToUseTool`)

```
1. 内置危险命令(run_bash → DANGEROUS_PATTERNS 命中)→ deny        # 最高级,任何模式/规则不可覆盖
2. 用户 deny 规则 → deny                                          # 用户显式 deny 优先于一切
3. 专属通道:isMemoryReadExempt(只读 × .run-agent/memory/** × Trust)→ allow
4. 危险目录段(.git/.claude/.run-agent, 未豁免)→ deny             # 内置,规则不可覆盖
5. run_bash AGENT_DIR_BASH_RE → deny                              # 第二道防线(尽力而为,见决策 E)
6. 白名单:pathInCwd(realpath 双形态)
   ├─ cwd 内:只读工具 → allow;acceptEdits → 写 allow;default → 写 ask
   └─ cwd 外:继续
7. 用户 allow 规则 → allow                                        # cwd 外唯一授权通道
8. 兜底 → ask(run_bash / 只读工具 / 写一律 ask)
```

与现状(bypass → 内置 deny → 用户规则首条 → 兜底)的差异:① 删除 bypass;② 内置 deny 拆成「危险命令 + 危险目录 + bash 正则」三段,专属通道插在危险目录前;③ 兜底从「只读 allow」改为「白名单内外分流」。**用户 deny 规则提前到专属通道之前**——用户显式 deny 优先于一切内置放行(Claude Code 同样 "read deny rules MUST come before any allow")。

### 决策 E:硬化项(学 Claude Code)

1. **realpath 双形态**(缺口 ③-symlink):`inputPath()` 之后对每个待查路径生成 `[原样, realpath]`,黑名单/白名单/用户规则**对每个形态各查一遍**。`src/utils/fsOperations` 若无 `safeResolvePath`,在 `src/permissions/` 内新增纯函数(realpathSync,失败回退原样)。
2. **路径段小写化比较**(缺口 ③-大小写):段比较与 `DENY_DIR_SEGMENTS` 统一 `toLowerCase()`(仿 Claude Code `normalizeCaseForComparison`,**所有平台统一小写**,注释明确为何不分平台)。
3. **Windows 路径模式检测 → ask**(缺口 ③-平台):新增 `hasSuspiciousPathPattern(path)`,命中即 ask(不归一化,仿 Claude Code 的「检测而非归一化」理由:TOCTOU、不存在的文件无法归一化、依赖外部状态):
   - NTFS ADS(`:` 在盘符后出现)、8.3 短名(`~` + 数字)、长路径前缀(`\\?\`、`\\.\`、`//?/`、`//./`)、尾随点/空格(`.run-agent.`、`.run-agent `)、DOS 设备名(`CON`/`PRN`/`AUX`/`NUL`/`COM1-9`/`LPT1-9` 后缀)、三个以上连续点、UNC 路径(`\\`/`//` 开头)。
   - **全平台跑**(NTFS 可被挂载到 Linux/macOS)。
4. **`run_bash` 不做完整 AST 解析——明确标注为已知局限**:PowerShell 有内置 AST 解析器但需起子进程;Bash 的 AST 解析需要解析器,而本版不引入。**缓解**:`AGENT_DIR_BASH_RE` 仍是第二道防线,第一道防线是危险目录 deny(路径工具) + 白名单;`run_bash` 本身 default 下必 ask,用户有最后确认。文档(`docs/permissions.md`)明确「run_bash 命令文本黑名单是尽力而为,不承诺穷尽 shell 拼接」,并把「解析不出就 ask」列为后续增强。

   **参考证据(2026-08-11 源码核实):Claude Code 用「纯 TS 重实现 tree-sitter-bash」做 AST 解析——但本版不做此实现。** Claude Code 的 bash 安全解析(`F:\CC_Source\claude-code-sourcemap\restored-src\src\utils\bash\`)路线是「tree-sitter 语义、零原生依赖」:
   - `bashParser.ts`(4436 行):纯 TypeScript 手写 bash 解析器,产出 **tree-sitter-bash 兼容 CST**(`TsNode { type, text, startIndex, endIndex, children }`,`startIndex` 为 UTF-8 字节偏移);`ensureParserInitialized` 为 no-op,生产跑的就是纯 TS 版。
   - 验证:拿真实 **WASM parser 当 oracle,生成 3449 条输入的 golden corpus** 对拍;内置对抗输入防护(50ms 解析超时 + 5 万节点预算)。
   - 下游:`treeSitterAnalysis.ts`(506 行)分析引用上下文/复合结构/危险模式 → `ParsedCommand.ts` 遍历 → `BashTool/bashSecurity.ts` + `pathValidation.ts` 做权限判定。
   - 结论:零依赖下 AST 解析**可行**,代价是「工程量换特性」。

   **本版明确不做**:
   - 工程量量级:4436 行手写 parser + golden corpus 对拍 + 时序防护 ≈ 重做一遍 V4.5 本身,且只服务 `run_bash` 一条通道;
   - 收益不匹配:V4.5 的 `run_bash` 已「default 必 ask + 危险命令最高级 deny + 白名单兜底」,AST 只提升「命令文本静态识别」这一尽力而为层;
   - 关联约定:代码理解(0.4.1,`docs/Plan_V4.md` 决策 D)同样不用 tree-sitter——符号扫描用 `git ls-files` + 两遍排序 + 轻量符号 regex 已够,不需要 CST 级解析;
   - **若后续补**(如 `run_bash` 成为重点攻击面):唯一零依赖路线就是 Claude Code 这条「纯 TS 重实现 + WASM golden 对拍」,单独版本评估,不进 V4.5。

### 决策 F:遍历层对齐(修 glob/grep 接缝,缺口 ①)

**问题**:`glob`/`grep` 的 `ALWAYS_IGNORE` 只有 `.git`/`node_modules`,内部递归遍历会钻进 `.run-agent`;且 `glob` 的 pattern 路径段 / `grep` 的 `glob` 过滤参数不经 `inputPath()`(只查 `path` 字段),从 cwd 遍历时 `path="."` 天然通过黑名单。

**修法**(决策 B 的对称问题——deny/豁免边界下沉到遍历层):

- `src/tools/glob.ts` / `src/tools/grep.ts`:`ALWAYS_IGNORE` 加 `.run-agent`。**从任何上级目录遍历时不钻进 `.run-agent`**(无论 pattern/path 怎么写)。
- **Trust 会话检索记忆的合法路径**:`grep` 显式 `path=".run-agent/memory"`(root 本身在 memory 内)→ 遍历合法,且该调用经专属通道(决策 C)放行。实现:遍历起点(root)**若已在 `.run-agent/memory/**` 内 → 跳过 `.run-agent` 目录段限制**;root 在其外 → 一律不钻进。
- 由此 V4 读豁免的语义变得干净:**豁免在「路径参数层」放行显式路径(inputPath 查得到);遍历层负责「不意外钻进」**——两层都要有。

---

## §2 里程碑 M1 — 0.4.2 实现

**文件**:

- `src/permissions/types.ts`:`PermissionMode` 去 `bypass`;`PermissionContext` 加 `cwd: string`。
- `src/permissions/engine.ts`:
  - `DENY_DIR_SEGMENTS` 注释改「危险目录」语义;段比较 `toLowerCase()`。
  - 新增 `pathInCwd(path, cwd)`(realpath 双形态)、`hasSuspiciousPathPattern(path)`、`isMemoryReadExempt(tool, path, isTrusted)`(从 V4 决策 A 移入)。
  - `hasPermissionsToUseTool` 签名加 `cwd`、`isTrusted`;按决策 D 重排;删除 bypass 分支。
- `src/cli/index.ts`:mode 解析去 bypass + 非法值回退警告;`PermissionContext` 装配时传 `cwd`、`isTrusted`(已有)。
- `src/cli/repl.ts`:`makeCheckPermission` 透传新 context 字段(链路不变)。
- `src/permissions/prompt.ts`:ask 弹窗文案补「该路径在允许的工作目录之外」的说明(提示用户可用 allow 规则)。
- `src/tools/glob.ts` / `src/tools/grep.ts`:`ALWAYS_IGNORE` 加 `.run-agent`;root 在 `.run-agent/memory/**` 内时放行遍历(仅 Trust,经专属通道判定)。
- 文档:`docs/permissions.md` 重写权限模型章节(三层模型 + 判定顺序 + bypass 移除 + run_bash 局限注明);`README` / `docs/usage.md` 移除 bypass;`docs/Plan_V4.md` 决策 A 的 "bypass 无条件" 表述同步。

**测试**:

- `tests/permissions/engine.test.ts`(大改):白名单内外分流(只读工具 cwd 内 allow / cwd 外 ask)、realpath 双形态(symlink 逃逸被拦)、大小写(`.RUN-AGENT` 被拦)、Windows 模式检测(ADS/8.3/长前缀/尾随点/UNC → ask)、专属通道在危险目录前放行(memory 读 Trust 放行 / 未 Trust deny)、用户 deny 优先于专属通道、`acceptEdits` 收窄到 cwd 内、bypass 删除。
- `tests/tools/glob.test.ts` / `tests/tools/grep.test.ts`:`.run-agent` 目录在上级 root 遍历时被跳过;root 显式指 `.run-agent/memory` 时能读(Trust)。
- `tests/cli.test.ts`:非法 mode 回退 default + 警告;`--dangerously-skip-permissions` 报错。
- `tests/permissions/engine.test.ts` 现有 18/18 用例逐条审计迁移。

**验收**:

- `--mode bypass` / `--dangerously-skip-permissions` 不可用;`mode: "bypass"` 配置回退 default 并警告。
- 只读工具读 cwd 外文件 → ask(REPL)/ deny(one-shot);allow 规则可授权。
- symlink 指向 `.run-agent` 的路径在 realpath 后命中 deny;`.RUN-AGENT` 大小写变体被拦。
- `glob **` / `grep .` 从 cwd 遍历**扫不到 `.run-agent`**;Trust 会话 `grep path=.run-agent/memory` 能检索记忆。
- 危险命令(`rm -rf /`、`npm publish` 等)在无 bypass 后不可被任何规则解除。
- 现有 V2/V3 权限语义(ask/deny/allow 规则、Trust project rules)回归不破。

---

## §3 0.4.2 DoD 验收清单

- [ ] bypass 删除:类型/flag/engine/文档全移除;非法 mode 回退 default + 警告(单测/CLI 冒烟)
- [ ] 白名单:`hasPermissionsToUseTool` 带 cwd;只读工具 cwd 外 ask/deny;`acceptEdits` 收窄到 cwd 内(单测)
- [ ] realpath 双形态:symlink 指向 `.run-agent`/cwd 外的路径被拦(单测)
- [ ] 大小写:段比较 toLowerCase,`.RUN-AGENT` 变体被拦(单测)
- [ ] Windows 路径模式:ADS/8.3/长前缀/尾随点/UNC/三点 → ask(单测)
- [ ] 专属通道:`isMemoryReadExempt` 在危险目录 deny 前放行 memory 读(Trust);未 Trust deny;非 memory 路径仍 deny(单测)
- [ ] 判定顺序:用户 deny 优先于专属通道与白名单;内置 deny 优先于用户 allow(单测)
- [ ] 遍历层:glob/grep 从上级 root 不钻进 `.run-agent`;显式 memory root 可读(单测)
- [ ] 危险命令在无 bypass 下不可被规则解除(单测回归)
- [ ] 文档:permissions.md 三层模型 + bypass 移除;README/usage/Plan_V4 同步;run_bash 局限注明
- [ ] 0.4.2 发布:CHANGELOG / package.json 0.4.2 / CI 三 OS × Node 20/22/24 全绿 / tag / `npm pack` / `npm publish --access=public`

## §4 风险与注意

1. **白名单默认行为变化破坏现有工作流**:只读工具读 cwd 外从 allow → ask/deny,可能影响"agent 读用户 home 配置/其它项目"的既有用法。缓解:allow 规则逃生 + 文档提前写明;one-shot 用户需预配规则。属安全优先的取舍,明确可接受。
2. **realpath 假阴性**(macOS `/var → /private/var`):resolve 后与 resolve 后的 cwd 对称比较(决策 B),并保留系统 symlink 白名单(/private/var、/private/tmp);失败回退原样形态再判一次。
3. **Windows 模式检测误伤**:尾随点/8.3/长前缀检测全平台跑,可能拦正常路径 → 设计为 ask(人工确认)而非 deny,把误伤成本降到"多一次确认"。
4. **遍历层跳过 `.run-agent` 后记忆检索受限**:Trust 会话必须显式 `path=.run-agent/memory` 才能搜记忆——文档注明(模型经 MEMORY.md 索引已经知道路径,影响小)。
5. **`run_bash` 正则黑名单不可穷尽**(缺口 ②残留):AST 解析零依赖下可行但工程量巨大(见决策 E 4b),V4.5 不做;缓解靠危险命令 deny(最高级)+ run_bash 必 ask + 文档标注局限。若后续引入解析器,单独版本。
6. **删除 bypass 对既有用户**:可能有人依赖 bypass 跑批量任务 → 文档迁移指引(改用 allow 规则 + acceptEdits);非法 mode 回退 default 是温和降级,不崩溃。
7. **工程纪律**沿用 V3:`exactOptionalPropertyTypes` 条件 spread、`verbatimModuleSyntax` `import type`、zod v4 `instanceof` 窄化、读文件剥 BOM。

---

## §5 交接(V4 → V4.5 实施顺序)

**建议先做 V4(0.4.0 记忆)再 V4.5(0.4.2 权限)**:

- 0.4.0 建立 `.run-agent/memory/` 目录与 `remember` 专属写通道,`isMemoryReadExempt` 在 V4 决策 A 已定义;0.4.2 把它**并入统一的专属通道判定**(决策 C/D),不必重写逻辑。
- 0.4.2 的遍历层对齐(决策 F)反过来是 V4 读豁免的**前置条件**——不先堵「glob 从 cwd 能钻进 `.run-agent`」,V4 的"未 Trust 记忆不可见"保证就漏。所以若 0.4.2 在 0.4.0 之后实施,0.4.0 发布时要在 `docs/memory.md` 注明「读豁免依赖 0.4.2 的遍历层对齐」;若并版实施则无此问题。
- 0.4.1(代码理解)与权限层正交,不受影响。

**0.4.2 → 后续**:

- `additionalWorkingDirectories`(多工作目录)、`run_bash` AST 解析(唯一零依赖路线 = Claude Code 式纯 TS 重实现,见决策 E 4b)、OS 级沙箱(seatbelt/bubblewrap)列为后续评估——前两者是工程增强,沙箱是「权限引擎之上的最后一道 OS 兜底」,与 V4.5 的权限模型正交,不进本版。
