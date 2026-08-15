# Plan V8 — 系统能力完善（权限重构 + 会话持久化 + 可靠性加固）

> 上游:`docs/Plan.md` 路线图 V8 段(279-286 行):「V8 号专做**系统能力完善**——权限加固、可靠性、真实模型验证、性能稳定性等工程强化,后续此类条目一律归本桶。」
> 上一版本交接:`docs/Plan_V7.md`(0.7.0 + 0.7.1 + 0.7.2,多 Agent 编排三件套 + verification + 后台记忆双轨)+ `docs/Bug_V7.md`(13 已解决 + 6 待修权限 P1/P3 优先 + 1 flake)。**V0–V7 全部已实施并发布**(CHANGELOG 0.1.0 → 0.7.2,CI 9 job 全绿)。
> 本版本一句话:把 V8 号从「发布与生态」(整体顺延为 V9)让给**系统能力完善**——权限重构(六分类 + 判定链收口)、会话持久化 + 会话切换、真实模型验证、可靠性兜底等工程强化。
> 触发:2026-08-13 重新规划——原 V8「发布与生态」顺延 V9,V8 专做系统能力完善;权限重构(`docs/expected-permissions.md`)即 V8 首个交付。2026-08-14 补:会话切换(V2.5 推迟项)提前到 V8 完成(0.8.1)。
> 参考实现:`F:\CC_Source\claude-code-sourcemap\restored-src` —— 权限判定链参考 CC `hasPermissionsToUseTool` 的收口单线;会话持久化对齐 CC `sessionStoragePortable.ts`(按 cwd 分目录 + 首行元数据)与 `promptSelect` 方向键菜单(对齐 CC select UI)。本版裁剪其规模、保持零新依赖。

## §0 结论速览

### 前置核验(V0–V7 实施状态,2026-08-13)

- **V8 0.8.0 已发布**:npm latest = 0.8.0;commit `1be0766`(权限重构主体)+ `3909e1b`(grep/glob 跨平台修复)+ `e6fc143`(V7-14 --resume 修复)+ `915eddd`/`ea036ba`(CHANGELOG 回填,**`915eddd` 即 `v0.8.0` tag 指向**);CI 三轮 9 job 全绿(531 用例)。权限重构 = run_bash 六分类 + 判定链收口前置单线 + P1-P5。文档 `docs/permissions.md`、SECURITY.md、CLAUDE.md、README、CHANGELOG 已同步。
- **V8 0.8.1 已 commit 未发版**(2026-08-14):commit `9945887`(566 用例全绿,工作区干净),**用户明确暂不发版**——未 bump/tag/publish,发布流程 = bump 0.8.1 → tag `v0.8.1` → `npm publish`,待日后用户确认。会话按 cwd 分目录 + 首行元数据 + `--list`/`--resume <id>` + REPL `/sessions` + promptSelect 菜单基建(TDZ 与 input 回退两坑已修);时区修复(存储 UTC + 显示本地时区)。文档 `docs/message-persistence.md` 已落盘。
- **V7(0.7.2)已发布**:npm latest = 0.7.2;tag `v0.7.2`;CI 9 job 全绿(480 用例 / 50 文件)。**Bug_V7.md 待修权限 6 条(P1/P3 优先)是 V8 权限重构的输入**——其中 P1(plan 绕过危险目录)、P3(导航工具先于用户 deny)、P4/P5(危险命令变体)已并入 0.8.0 修复批次。

**V8 交付什么(拆两版)**:

**0.8.0「权限重构」**:

1. **run_bash 六分类影响半径**(`classifyBashCommand` 重写):命令从「命令黑名单」改为**类别识别**——`dangerous`(R2 系统级写 / R3b 远程拉取执行 / R4b 发布强推,无条件 deny)/ `readonly`(R0 闭集自动 allow)/ `network`(R4a 普通网络,ask)/ `local-exec`(R3a 本地执行,ask)/ `http-get`(curl 采样,engine 层 ask)/ `write`(R1 项目内写,兜底 ask)。**本地执行类从免确认改为询问**(`node --version`/`npm test`/`python3 x.py` 等);**git 系列不入 R0**(仓库级 `.git/config` 可定义 alias/pager/external-diff 执行任意命令)。
2. **判定链收口前置单线**(`hasPermissionsToUseTool` 重排):用户 deny → 内置危险命令 → 命令文本危险段 → 记忆豁免 → 路径危险段 → plan 分支 → 导航工具 → 用户 allow → 白名单兜底。**P1** 堵 plan 绕过危险目录、**P3** 用户 deny 提到导航工具前、**P4** 危险命令变体(`git -C` 强推 / `dd of=//dev` / 管道 rm)、**P5** 命令文本危险段扩到三目录段 + `/i`。
3. **acceptEdits 语义收口**(P2):只预授权 cwd 内 `write_file`/`edit_file`,不再无条件放行无路径工具(remember/verify 等)与 MCP 写工具;**acceptEdits 不放行 bash**。
4. **verification / verify 同步六分类**:`makeVerificationCheckPermission` 放行 readonly/local-exec/http-get 检查命令(构建/测试/lint/curl 采样不弹窗)、deny 危险命令与项目内写、`/tmp` 临时脚本放行;`verify` 只放行 readonly/local-exec。
5. **跨平台遗留修复**:grep 单文件 + glob 在 POSIX 绝对路径误报未找到(glob 过滤改用文件名判定);`--resume` 误选子 agent transcript(过滤 `SUBAGENT_FILE_PREFIX`)。

**0.8.1「会话持久化 + 会话切换」**:

6. **会话按 cwd 分目录**(修跨项目串会话):`sessions/<sanitized-cwd>/`,`sanitizePath` 非字母数字 → `-`、超长截断 200 + sha256 8 位 hash(对齐 CC `sessionStoragePortable`)。旧文件不迁移。
7. **会话首行元数据**:第 1 行写 `{ ts, meta: { cwd, model, provider, version } }`;第 2 行起才是消息行。
8. **`--list` / `--resume <id>` / REPL `/sessions`**:只列当前项目会话、每文件只读头 8192B、输出 `id model 时间 首条 prompt 截断 60`;`--resume` 正则防路径穿越;`/sessions` 方向键菜单切入(加载历史替换 messages + 更新 sessionFile 指针)。
9. **promptSelect 方向键菜单基建**(`src/ui/keypress.ts` + `src/ui/select.ts`):`parseKeypress` 纯函数(ANSI → KeyEvent,裸 ESC 60ms 兜底)、`nextFocus` 纯函数、readline 静音协议(stdin 唯一所有权);权限确认与 Trust 确认升级为方向键菜单。
10. **会话权限收紧 + 时区修复**:目录 `0o700` / 文件 `0o600`;存储保持 UTC(文件名字典序==时间序不变式),展示用 `sessionIdTime(id)` 转本地时区(UTC+8 即北京时间)。

**技术栈增量**:

- **零新依赖**:全部复用 engine.ts / sessionStorage.ts / readline + 现有 UI 层;promptSelect 用 Node 原生 readline + ANSI 转义,无 Ink。
- 新增文件:`src/ui/keypress.ts`、`src/ui/select.ts`(promptSelect 基建);会话层改动集中在 `src/utils/sessionStorage.ts`(分目录 + 元数据 + `--list` 只读头 + id 定位)。
- 新增文档:`docs/session-persistence.md` §5(V8 落地设计)、`docs/message-persistence.md`(总览)、`docs/permissions.md`(权限重构行为文档)、`docs/expected-permissions.md`(设计稿归档)。

**不做的事(留待后续,诚实标注)**:

- **记忆来源分级**(user 指令级 / agent 参考级)→ 后续:agent 自写内容与用户同权,是持久化注入的远期核心缺口(`expected-permissions.md` §4 挂点 B)。
- **记忆校验层**(格式 / 上限 / 损坏 / 落盘原子)→ 后续:当前提取已有成功才推进游标,但无格式校验层。
- **MCP readOnlyHint 免确认 → 全 ask** → 后续:现状更宽松,目标更保守,评估影响面后定。
- **沙箱** → 远期(V8+ 桶):跨平台成本极大(Windows 无原生 chroot、macOS sandbox-exec 已弃用),Linux/macOS 优先轻量隔离(bubblewrap),Windows 降级静态判定;纵深防御最终层,不取代静态分层。
- **TUI 打磨**(Ink 渲染 / 工具执行可视化)→ V9。
- **发布流水线自动化 / IDE 集成 / 评测公开 / 沙箱 / 可观测** → V9。

---

## §1 架构决策

### 决策 A:run_bash 六分类影响半径(`classifyBashCommand` 重写)

**动机**:V7 权限审查发现 `classifyBashCommand` 是「命令黑名单」(V7-P4 可绕过)、无「项目内写 R1 vs 系统级写 R2」区分。黑名单追不上 shell 拼接,必须改成**类别识别**——结构性,不依赖分析精度。

**A1. 五层影响半径**(`BashDanger` 枚举):

| 类别 | 影响半径 | 判定 |
|------|----------|------|
| `dangerous` | R2 系统级写(`rm 根`/`mkfs`/`fdisk`/重定向写 `/etc`)· R3b 远程拉取执行(`curl\|sh`)· R4b 发布强推(`git push --force`/`npm publish`/`git reset --hard`) | **无条件 deny**(内置不可覆盖) |
| `readonly` | R0 纯只读闭集(`pwd`/`ls`/`echo` 无重定向/`cat` 单参数纯相对路径) | **自动 allow**(全模式共享) |
| `local-exec` | R3a 本地执行(`node`/`python`/`perl`/`eval`/`source`/`bash -c`) | ask(plan 下 deny) |
| `network` | R4a 普通网络(`curl`/`wget` 下载、`git fetch/pull/clone`、`npm install`、`gh`) | ask(plan 下 deny) |
| `http-get` | curl 采样 | engine 层 ask;verification 子 agent 放行 |
| `write` | R1 项目内写(闭集外兜底) | **ask**,绝不静默 allow |

**A2. 关键决策**:

1. **git 系列不入 R0**:仓库级 `.git/config` 可定义 alias / pager / external-diff 执行任意命令——`git status`/`log`/`diff` 一律按 `write` 兜底 ask,不赌仓库配置可信。
2. **R0 闭集证明制**:白名单是枚举闭集(每条命令 + 合法 flag 集合),能证明是 R0 才放行;证明不了默认往 R1 以上算。失败方向 = ask/deny,分析不准只是多问一次,不是漏放。
3. **acceptEdits 不放行 bash**:路径工具的 `file_path` 是显式入参可可靠判定;bash 的目标藏在字符串里不可可靠判定。**写 allow 只对路径工具成立**。
4. **本地执行类从免确认变为询问**:`node --version`/`npm test`/`python3 x.py` 等(R3a 执行任意代码,影响半径大)——编码 agent 核心能力保留知情放行路径,不静默。

**A3. 与 V7 黑名单的本质区别**:黑名单列具体命令、追不上拼接(`git -C repo push --force`、`dd of=//dev`、`echo x | rm -rf /`);类别识别按影响半径分层,P4 变体自动落入对应类别,新增命令也天然归类,无需逐条枚举。

### 决策 B:判定链收口前置单线(`hasPermissionsToUseTool` 重排)

**动机**:V7 审查发现「先放行、后收口」形态——P1(plan 分支提前返回可静默放行 `.run-agent` 段只读)、P3(导航工具先于用户 deny)。P1 是一类模式不是单个 bug,必须结构消解而非打补丁。

**B1. 收口单线**(`engine.ts`):

```
用户 deny → 内置危险命令 → 命令文本危险段(DENY_BASH_SEGMENTS_RE,三目录段 + /i)
  → 记忆豁免(只读 × .run-agent/memory/** × Trust,forms.every)
  → 路径危险段(.git/.claude/.run-agent,plan 下也跑)
  → plan 分支 → 导航工具 → 用户 allow → 白名单兜底
```

- **所有 deny 点(危险段、R3/R4 整类、用户 deny)先跑,所有 allow/ask 后跑**;不分叉、不每个分支自包含再查一遍(否则新分支再加放行条件时会再次漏同步)。
- **豁免必须比收口更窄**:记忆豁免是唯一允许出现在收口之前的点,且用 `forms.every`(所有形态都是豁免路径)而非 `forms.some` 自证更窄。
- **用户 deny 先于一切内置放行**(P3):用户显式规则优先于 `mcp_connect`/`enter_plan_mode` 等导航工具。

**B2. 防复发铁律**(`expected-permissions.md` §10):

1. 收口前置单线管线(判定是单线,先收口后放行)
2. 豁免必须比收口更窄(`forms.every`)
3. 放行绑定工具语义审计,不绑定工具名(只读工具偷偷加写能力 = 放行条件静默变宽)
4. 判定矩阵测试(穷举「每个放行点 × 每个危险输入 × 每个模式」,把 P1 复发从运行时提前到 CI)

### 决策 C:acceptEdits 语义收口(P2)

- **只预授权 cwd 内文件写**(`write_file`/`edit_file`,pathInCwd 判定);不再无条件放行无路径工具(`remember`/MCP 无 path 工具)与系统级写(R2+ 仍 ask)。
- 三层单调递进保持:`plan`(写 deny)⊂ `default`(写 ask)⊂ `acceptEdits`(写信任内 allow)。**读侧三模式完全同一策略——读不是放宽对象。**

### 决策 D:verification / verify 同步六分类

- `makeVerificationCheckPermission(cwd)`:readonly/local-exec/http-get **自动放行**(构建/测试/lint/curl 采样不弹窗)、dangerous 与命令文本危险段 deny、network/write deny 但允许 `/tmp`·`$TMPDIR` 重定向写临时脚本、write/edit 兜底 deny。
- `verify` 只放行 readonly/local-exec 检查命令。
- 语义对齐后,verification 子 agent 的「禁写项目文件」承诺与六分类一致——不再走 V7 的专用白名单。

### 决策 E:会话持久化 + 会话切换(`docs/session-persistence.md` §5)

**E1. 存储层改造**(`src/utils/sessionStorage.ts`):

- **按 cwd 分目录**:`sessions/<sanitized-cwd>/`。`sanitizePath` 非字母数字 → `-`、超长截断 200 字符 + sha256 8 位 hash 后缀——对齐 CC `sessionStoragePortable`。旧文件不迁移(未存 cwd 无从对应)。
- **首行元数据**:新建会话第 1 行写 `{ ts, meta: { cwd, model, provider, version } }`,resume 可知上次配置;`loadSession` 跳过 meta 行、按 compact 哨兵重置加载点。
- **权限收紧**:目录 `0o700` / 文件 `0o600`(Node 的 mode 只对新文件生效)。

**E2. 会话列表 + 切换**:

- **`--list`**:只列当前项目会话,每文件只读头 8192B(渐进式),输出 `id  model  时间  首条 prompt 截断 60`;无需配置 / API key。
- **`--resume <id>`**:无 id 续当前项目最新;带 id 按 id 定位(正则防路径穿越),替代「只续最新」。
- **REPL `/sessions`**:promptSelect 方向键菜单 → 切入(加载历史替换 messages + 更新 sessionFile 指针,后续追加写新会话)。

**E3. promptSelect 基建**(`src/ui/keypress.ts` + `src/ui/select.ts`,对齐 CC select UI):

- `parseKeypress` 纯函数:ANSI 转义序列 → KeyEvent,含裸 ESC 60ms 兜底;
- `nextFocus` 纯函数:回绕 + 跳过 disabled;
- **readline 静音协议**:`rl.pause()` + 临时移除 line 监听(stdin 唯一所有权,防输入回显成多字符);结束恢复;
- `input` 缺省回退 `rl.input`(显式 `input` 优先)——REPL 注入输入流场景;
- 权限确认(`resolveAsk` 三项菜单)与 Trust 确认(`askTrustProject` 两项菜单)升级为方向键菜单。

**E4. 时区修复**:存储保持 UTC(文件名字典序==时间序排序不变式依赖它),展示用 `sessionIdTime(id)` 转**本地时区**(地区自适应,UTC+8 即显示北京时间)。修 `--list`/`/sessions` 直接 slice 文件名字戳导致的 UTC+8 偏早 8 小时。

### 决策 F:跨平台遗留修复(0.8.0 附带)

- **grep 单文件 + glob POSIX 绝对路径误报未找到**(0.7 引入):单文件搜索的 glob 过滤原用绝对路径匹配 `**/*.ts`(正则无法从开头 `/` 起配)→ Linux/macOS 误报、Windows 盘符侥幸通过(CI 6 job 挂 / Windows 3 job 过)。修复:单文件分支的 glob 改用文件名判定;`globToRegExp` 导出 + 回归测试锁定「POSIX 绝对路径不匹配 / 相对与文件名匹配」。
- **`--resume` 误选子 agent transcript 作主会话**(V7-14):`subagent-*.jsonl` 与主会话同目录,倒序字典序下字母开头的 `subagent-*` 恒排时间戳(数字开头)之前(`'s'>'2'`,与时间先后无关)→ 确定性误选。修复:过滤 `SUBAGENT_FILE_PREFIX` 前缀(sessionStorage.ts 定义、registry.ts 复用统一常量)。

---

## §2 待修与待整理(当前开放项)

> 以下条目持续开放,后续归本桶处理。

- **真实模型手动验证(需 key)**:六分类下 REPL 实际弹窗行为、verification 放行/拒绝、R0 自动放行、plan 下危险段 deny;`/sessions` 方向键菜单与 `--list`/`--resume <id>` 实机验证。每个版本验收尾项。
- **REPL 兜底抛错无接盘(待修)**:compact 兜底链最终 `throw e`(`query.ts:271` / `:298` 抛出的 context_too_long 原始错误)在 REPL 下无 catch 接盘——`runTurn`(`repl.ts:418`)→ `processPrompt` → `dequeue`(`repl.ts:690-701`,仅 try/finally)→ `void dequeue()` 成 **unhandledRejection**,全项目无 `unhandledRejection` 处理器 → Node 20+ 默认 throw → **整个 REPL 进程崩溃退出**。headless 有接盘(非 json:`index.ts:99-106` 打印 `✗` 退出 1;`--json`:`runHeadless` 进 `errors[]`);子 agent 最健壮(`execute.ts:188` catch 成 `工具执行错误` 回填主循环)。修复方向:给 REPL 的 turn 加顶层 catch(渲染红字错误 + 保留 REPL 存活 + 恢复 `promptLine`),或注册全局 `unhandledRejection` 兜底。**已记录为 `docs/Bug_V8.md` V8-P1(待修)**——修复后回填状态与 commit。
- **V7 权限遗留(`docs/Bug_V7.md` 待修,P1/P3 优先)**:剩余条目修完并入 V8。
- **子 Agent 权限统一分析(待整理,非 hotfix)**:提取子 agent 的 `makeExtractMemCheckPermission`(`src/services/agents/builtin/extractMemories.ts:37-51`)对 `read_file`/`glob`/`grep` 无条件 allow,**绕过主权限引擎的路径危险段判定**(`src/permissions/engine.ts` P1),而 `src/tools/read.ts:30` 的 read_file 工具本身零路径校验——安全完全依赖 checkPermission。理论漏洞面:增量消息夹带的提示注入可诱导提取器读任意敏感路径。当前缓解仅靠 Trust 门控 + 4 工具白名单。**推迟原因**:与子 Agent 系统相关,待后续整理子 Agent 时把 extractMemories / explore / verification / 自定义类型**所有内置子 agent 的权限统一分析和控制**(含只读 allow 范围、路径白名单),不单独修。
- **后续系统能力完善桶**:权限 / 可靠性 / Bug 修复 / 性能稳定性等工程强化条目在此积累。

---

## §3 DoD 验收清单

- [x] `run_bash` 六分类:`dangerous` deny / `readonly` R0 闭集自动 allow / `network`·`local-exec`·`http-get`·`write` 兜底 ask(0.8.0,单测)
- [x] 判定链收口前置单线:用户 deny → 危险命令 → 危险段 → 记忆豁免 → 路径危险段 → plan → 导航 → allow → 白名单(0.8.0,单测)
- [x] P1 堵 plan 绕过危险目录、P3 用户 deny 最前、P4 危险命令变体、P5 三目录段命令文本收口(0.8.0,单测)
- [x] acceptEdits 只预授权 cwd 内 `write_file`/`edit_file`、不放行无路径工具与 bash(0.8.0,单测)
- [x] verification / verify 同步六分类(0.8.0,单测)
- [x] grep 单文件 + glob POSIX 绝对路径修复 + `globToRegExp` 回归测试(0.8.0,CI 全绿)
- [x] 会话按 cwd 分目录 + 首行元数据 + 权限 `0o700`/`0o600`(0.8.1 已实现,单测)
- [x] `--list` 只读头 8192B / `--resume <id>` 正则防穿越 / REPL `/sessions` 方向键菜单(0.8.1 已实现,单测)
- [x] promptSelect 基建:parseKeypress / nextFocus / readline 静音协议 / input 回退 rl.input(0.8.1 已实现,单测)
- [x] 时区:存储 UTC + `sessionIdTime` 本地时区展示(0.8.1 已实现,单测)
- [ ] **0.8.1 发布**:bump / tag / `npm publish`(待用户确认后执行)
- [ ] **真实模型手动验证(需 key)**:六分类弹窗行为、verification 放行/拒绝、R0 自动放行、plan 危险段 deny、`/sessions` 菜单实机(验收尾项)
- [ ] **REPL 兜底抛错无接盘**:修复(已记录 `docs/Bug_V8.md` V8-P1)
- [ ] **子 Agent 权限统一分析**:与子 Agent 系统整理一并处理

## §4 风险与注意

1. **六分类的不可判定边界**:shell 拼接(`$(...)`/管道/`env VAR=cmd`)语义分类不可判定——失败方向 = ask/deny 吸收,方案完整性不依赖判定准、依赖默认值保守(`expected-permissions.md` §2)。
2. **R0 白名单每加一条都要审计全部 flag**:`git -c alias.x='!sh'` 能让 git 变成执行任意代码——git 系列因此不入 R0,白名单极保守,宁可多 ask。
3. **P1 复发是模式不是 bug**:判定链必须保持单线,任何新分支加放行条件都要过铁律四条;判定矩阵测试把复发前置到 CI。
4. **会话分目录的兼容**:旧文件不迁移(未存 cwd 无从对应);`--resume` 语义变化(带 id 定位 vs 只续最新)需文档说明。
5. **readline 唯一所有权**:权限弹窗 / promptSelect 复用 REPL 的 readline,绝不在同一 stdin 上另建 readline;promptSelect 进入时 `rl.pause()` + 临时移除 line 监听、结束恢复,`input` 缺省回退 `rl.input`。
6. **时区双轨不变量**:文件名字戳必须保持 UTC(字典序==时间序),展示层才做本地时区转换;若改存储格式会破坏排序不变式。
7. **提示注入 via 恶意记忆**:project/local CLAUDE.md 仅 Trust 注入;子 agent 只读 allow 面扩大是已知理论风险,靠 Trust + 白名单缓解,统一分析挂 §2。
8. **工程纪律**:`exactOptionalPropertyTypes` 条件 spread、`verbatimModuleSyntax` `import type`、读文件剥 BOM——沿用 V0–V7 纪律。

## §5 交接(给 V9)

- **0.8.1 待发布**:已 commit `9945887`(566 用例全绿,工作区干净),**用户明确暂不发版**——发布流程 = bump 0.8.1 → tag `v0.8.1` → `npm publish`,均待用户日后确认后执行,发布后同步 CHANGELOG / docs / README / 记忆索引。
- **V9 承接**:原 V8「发布与生态」——发布流水线自动化、TUI 打磨、评测公开(SWE-bench 子集)、IDE 集成、沙箱、可观测、社区运营。
- **长期缺口(在 V8+ 桶积累)**:记忆来源分级(user 指令级 / agent 参考级)、记忆校验层、MCP readOnlyHint → 全 ask、沙箱(远期,纵深防御最终层)。
