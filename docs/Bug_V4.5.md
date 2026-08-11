# Bug 记录 · V4.5「权限模型重构」（交付 0.4.2）

> 阶段：2026-08-11 ｜ 交付：`0.4.2`（bypass 删除 + 黑/白/专属通道三合一 + 判定顺序重排，235 测试）
> 来源：0.4.2 实施会话（`hasPermissionsToUseTool` 重构 + 测试重写）。
> **V4.5-3 是唯一真正值钱的安全缺口（symlink 别名逃逸，测试设计阶段拦截，未上线）；V4.5-1/2 是构建期类型错误；V4.5-6 是语义变更带来的旧断言迁移；V4.5-9 是发布后 CI 暴露的环境路径误判（0.4.3 修复）；其余是测试/工程细节。** 除 V4.5-8 外均已解决。

| #      | Bug                                                                                 | 类别              | 严重度  | 状态            |
| ------ | ----------------------------------------------------------------------------------- | ----------------- | ------- | --------------- |
| V4.5-1 | commander `.choices()` 挂在 `Option` 而非 `Command` → TS2339                          | 构建/类型         | 🟡 中   | ✅ 已解决        |
| V4.5-2 | `rule.path` 属性访问在闭包内不被 TS 窄化 → TS2345                                    | 构建/类型         | 🟡 低   | ✅ 已解决        |
| V4.5-3 | realpath 双形态对「新文件写」失效 → symlink 别名逃过 `.run-agent` deny                | 权限/安全         | 🔴 严重 | ✅ 已解决（未上线） |
| V4.5-4 | 尾随空格可疑路径被 `inputPath` trim 掉 → engine 层检测不可达                          | 权限/测试设计     | 🟡 中   | ✅ 已解决        |
| V4.5-5 | 测试用 `C:/proj/a.ts` 平台相关路径（POSIX/Windows 白名单判定不同）                    | 测试              | 🟡 低   | ✅ 已解决        |
| V4.5-6 | 规则语义由「首条命中短路」改为「deny 优先」，旧断言 `[allow,deny]`→allow 失效          | 行为变更/测试迁移 | 🟠 高   | ✅ 已解决        |
| V4.5-7 | `let dirs` 从不重赋值 → eslint `prefer-const`                                        | 工程/lint         | ⚪ 低   | ✅ 已解决        |
| V4.5-8 | 全量并行下 `collectGitContext` 单条 git 命令 800ms 超时偶发超限（既有 flaky 复现）      | 测试稳定性        | 🟡 中   | ⏳ 已知，未修    |
| V4.5-9 | 可疑检查作用于「整个解析后路径」→ cwd 位于 8.3 短名路径下（CI runner `RUNNER~1`）cwd 内全误判 ask | 权限/CI           | 🟠 高   | ✅ 已解决（0.4.3） |

---

## 安全：realpath 双形态对「新文件写」失效（V4.5-3，最严重）

- **现象**：V4.5 决策 E 引入 realpath 双形态防 symlink 换名逃逸。但测试设计时发现：`pathForms` 的整路径 `realpathSync` 在**最终组件不存在**时抛错——而这是**新建文件写入的正常场景**。一旦整路径解析失败、回退到字面形态 `dir/alias/inner/new.txt`（无 `.run-agent` 段），`alias → .run-agent` 这类 symlink 目录别名就能在**写新文件时逃过危险目录 deny**（默认允许、acceptEdits 也允许），与决策意图相悖。
- **根因**：realpath 失败时直接把原样形态当成唯一形态，丢掉了"父目录里的 symlink"这一信息。
- **修复**：`pathForms` 回退链补一层——整路径 realpath 失败 → `path.join(realpathSync(path.dirname(resolved)), path.basename(resolved))`（父目录解析 + 文件名拼接），连父目录都不可解析才保持字面。这样文件级 symlink（整路径）与**目录别名 + 新文件**（dirname）都逃不掉。配套测试：`write_file alias/inner/new.txt`（alias→`.run-agent`）在 acceptEdits 下断言 deny。
- **教训**：realpath/规范化防御的失败回退路径本身就是攻击面。**任何"解析不了就按原样处理"的分支都要问：不可解析是否恰恰是攻击者构造出来的？**（新建文件、悬空 symlink 都是"合法不可解析"。）

---

## 构建期：commander `.choices()` 挂错对象（V4.5-1）

- **现象**：typecheck 报 `TS2339: Property 'choices' does not exist on type 'Command'`——commander v15 的 `.choices()` 是 `Option` 的方法，**不是** `Command` 的。直接链在 `.option(...)` 后（返回 `this` 即 Command）编译不过。
- **修复**：改用 `new Option("-M, --mode <mode>", ...).choices([...PERMISSION_MODES])` + `.addOption(...)`。
- **教训**：带校验的选项值校验（choices/enum）要查该版本 API 的挂载对象；commander 上 `.choices` 挂在 `Option`。

---

## 构建期：闭包内属性访问不被 TS 窄化（V4.5-2）

- **现象**：`if (rule.path) { forms.some((f) => pathMatchesGlob(f, rule.path)) }` 报 `TS2345: string | undefined is not assignable to string`——TS 不窄化**闭包内的属性访问**（`rule.path` 是 `rule` 的可变属性，不能保证进闭包时未变）。
- **修复**：先捕获局部变量 `const rulePath = rule.path;`，闭包内用它。
- **教训**：`exactOptionalPropertyTypes` + 严格模式下的通例：属性访问要窄化请先提到局部变量，别指望闭包继承窄化。

---

## 权限/测试设计：尾随空格可疑路径检测不可达（V4.5-4）

- **现象**：`hasSuspiciousPathPattern` 单测覆盖「尾随空格」，但 engine 层测试 `hasPermissionsToUseTool("read_file", { file_path: "file " })` 拿到的是 **allow 而非预期 ask**——`inputPath` 先 `trim()` 掉首尾空白，尾随空格根本走不到可疑模式检测。
- **根因**：`inputPath` 的清洗（trim）在可疑检测之前发生，两者不在同一输入面。
- **处理**：这是可接受的取舍——被 trim 掉尾随空格后，路径指向的就是 trim 后的文件本身，无逃逸；真正危险的模式（尾随**点**、8.3 短名、UNC/ADS）都经 resolve 保留。修复口径：engine 层测试改用经 `inputPath` 解析后仍保留可疑形态的 `PROGRA~1`（8.3 短名 → `~\d`）断言 ask；尾随空格/UNC/ADS 类由 `hasSuspiciousPathPattern` 单测直接覆盖，并在测试注释里注明两类检测面不同。
- **教训**：安全检测要和上游清洗（trim/normalize）明确分工——**检测跑在清洗后还是清洗前，要在代码与测试里说清楚**，否则会出现"检测函数是对的、但永远不会被触发"的假安全。

---

## 测试：平台相关路径断言（V4.5-5）

- **现象**：prompt.test.ts 用 `file_path: "C:/proj/a.ts"` 造"cwd 外"用例——POSIX 上 resolve 后落到进程 cwd 内（判 allow），Windows 上落在 cwd 外（判 ask），平台不同断言不同，CI 矩阵必有一边挂。
- **修复**：改相对路径 `"a.ts"`（cwd 内语义在平台间一致），cwd 外用 `"../outside-secret.txt"`（两边都判 cwd 外）。
- **教训**：绝对路径的"内外"判定是平台相关的；跨平台测试优先用相对路径表达目录关系，别用写死的盘符路径。

---

## 行为变更：规则语义从「首条命中短路」改为「deny 优先」（V4.5-6）

- **现象**：V4.5 决策 D 把判定顺序重排为「用户 deny 先于一切内置放行」。旧测试 `[allow, deny]` 两条规则期望首条命中 → **allow**，新语义下 deny 先于 allow → **deny**，且与规则顺序无关。旧断言直接失效。
- **根因**：这不是缺陷，是**预期的语义变更**（对齐 Claude Code「deny 先于一切 allow」），但旧测试把 V2 的首条命中语义锁死了。
- **处理**：更新断言为 `deny`，并补反向顺序用例证明与规则顺序无关；在测试名里写明「决策 D：deny 优先于 allow，与规则顺序无关」。
- **教训**：语义变更一定要先排查被旧行为锁死的断言；「首条命中」和「deny 优先」在有 allow/deny 共存时会给出不同结果，是安全相关的行为差异，必须显式测试。

---

## 工程：`let dirs` 从不重赋值触发 prefer-const（V4.5-7）

- **现象**：lint 报 `'dirs' is never reassigned. Use 'const' instead`——`afterEach` 里用 `dirs.splice(0)` 原位清空，从不重赋值，`let` 应改 `const`。
- **修复**：改 `const dirs: string[] = []`。
- **教训**：集合的「清空」用 `splice(0)` / `.length = 0` 是原位操作，不属于重赋值；按 lint 提示收敛。

---

## 测试稳定性：`collectGitContext` 800ms 单条命令超时复现（V4.5-8）

- **现象**：全量并行跑时，`tests/core/context.test.ts` 的 `collectGitContext` 用例偶发失败（`ctx.branch` undefined）——`collectGitContext` 内部单条 git 命令带 800ms 超时，并行负载高时 git 超限被静默置 undefined。
- **根因**：V4-3（Windows 并行 git 超时）只把 **vitest testTimeout** 提到 30s，但 `collectGitContext` 每条 git 命令自己的 **execFile 超时仍是 800ms**——测试外框够长、内框不够，负载一高就超。单跑/复跑均通过，属 flaky。
- **处理**：暂未修（本版聚焦权限重构）；建议把 `collectGitContext` 的命令超时从 800ms 调大（如 3~5s），或对超时失败重试一次。
- **教训**：双层超时（框架超时 vs 内部命令超时）要一起看——只抬外层，内层仍是瓶颈。

---

## 权限/CI：cwd 位于 8.3 短名路径下时 cwd 内访问全误判 ask（V4.5-9）

- **现象**：0.4.2 发布后 CI 在**全部 3 个 Windows job** 失败（macOS/Ubuntu 绿），且三版 Node（20/22/24）失败完全一致——`tests/permissions/engine.test.ts:281` 与 `:322` 断言 `hasPermissionsToUseTool("read_file"/"write_file", { file_path: "a.ts" }, ..., false, dir)` 期望 `allow` 拿到 `ask`。本地 Windows（`C:\Users\19113\AppData\Local\Temp`）跑 235 例全绿，无法直出。
- **复现**：把测试进程的 `TMP`/`TEMP` 指向一个**名字里含 `~1` 的目录**（`...\RUNNER~1\AppData\Local\Temp`）即精确复现同样的 2 例失败——GitHub Actions Windows runner 的 `os.tmpdir()` 正好落在 8.3 短名路径 `RUNNER~1` 下，Vitest 工作目录建在其下。
- **根因**：`hasPermissionsToUseTool` 第 7 步对 `pathForms(p)` 的**整个解析后形态**跑 `hasSuspiciousPathPattern`——决策 E 本来就是「命中即保守 ask」，而 8.3 短名规则（`~\d`）会把 **cwd 前缀里**的环境短名（`RUNNER~1`）也命中。cwd 一旦位于短名路径下，cwd 内一切读/写/改都被误判 ask，白名单（决策 B）形同虚设。
- **修复**：新增 `suspiciousOutsideCwd(p, cwd)`——可疑检查只作用于「cwd 之外的用户输入部分」：cwd 内 → 只查相对部分（`a.ts` → 干净 → allow）；cwd 外（含 symlink 换名逃逸的 real 形态）→ 仍全路径检查（逃逸路径的短名/设备名照拦）。纯函数 `hasSuspiciousPathPattern` 本身不改（单测直测字符串）。
- **配套测试**：新增「cwd 自身在含 `~1` 的短名路径下 → cwd 内访问不误判」回归用例（`RUNNER~1/work/a.ts` → allow；用户输入部分自带 `PROGRA~1` → 仍 ask），跨平台复刻 CI 环境形状。
- **教训**：对「用户输入 + 环境前缀」拼接后的路径做安全检测，**检测必须限定在用户输入那一部分**，否则环境本身（CI 临时目录、8.3 短名、UNC 挂载）会被当成攻击输入。发布时「看全平台 CI」的价值再次得到验证——这类环境依赖的 bug 本地根本复现不出，只有 CI 的 runner 环境能暴露。

---

## 小结

- **真 bug 9 个**：1 个安全缺口（V4.5-3，最关键，未上线即拦截）、2 个构建期类型错误（V4.5-1/2）、1 个语义变更迁移（V4.5-6）、1 个发布后 CI 暴露的环境路径误判（V4.5-9）、2 个测试设计问题（V4.5-4/5）、2 个工程/稳定细节（V4.5-7/8）。
- **共性教训**：① 规范化/realpath 的**失败回退路径**是攻击面（V4.5-3）；② 安全检测要明确跑在清洗前还是后，避免「函数对、永不触发」（V4.5-4）；③ 语义变更先排查旧断言（V4.5-6）；④ 双层超时一起调（V4.5-8）。
- **设计取舍（非 bug）**：计划字面顺序是「白名单 → 用户 allow」，实现把用户 allow **提前到白名单之前**——为保留 V2「`a`（始终允许）对 cwd 内 default 写也放行」的语义（DoD「现有 V2/V3 权限语义回归不破」）；已写进 `src/permissions/engine.ts` 头注释，不视为缺陷。
- **关联**：V4.5-8 关联 [Bug_V4.md](Bug_V4.md) V4-3（同一 git 超时问题的内层残留）；V4.5-3 的「新文件写」思路同样适用于 V4-2 的 macOS 路径教训（双形态比较天然兼容）。
