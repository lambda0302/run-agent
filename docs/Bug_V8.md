# Bug 记录 · V8「系统能力完善」

> 阶段：2026-08-13 ~ 2026-08-15 ｜ 交付：`0.8.0`（权限重构——run_bash 六分类 + 判定链收口前置单线）+ `0.8.1`（会话持久化 + 会话切换 + verify 移除，已发布 v0.8.1）。
> 来源：会话记录、git 提交 `3909e1b`（0.8.0 CI 跨平台修复）/ `9945887`（0.8.1 主体）、CI 9 job 暴露、CHANGELOG [0.8.0]/[0.8.1]、Plan_V8.md §2。
> **V8 共记录 5 个已解决 bug + 2 个待修开放项。** 集中在「跨平台 / REPL 交互 / 会话展示」三条线。

## 总览

| #      | Bug                                                                                                    | 类别         | 严重度 | 状态           |
| ------ | ------------------------------------------------------------------------------------------------------ | ------------ | ------ | -------------- |
| V8-1   | grep 单文件 + glob 在 POSIX 绝对路径误报未找到（CI 6 job 挂，Windows 侥幸通过）                           | 工具/跨平台  | 🟠 高  | ✅ 已解决（3909e1b） |
| V8-2   | promptSelect 声明前引用后声明的 `rl` → TDZ ReferenceError，调用即抛                                     | 交互/UI      | 🟡 中  | ✅ 已解决       |
| V8-3   | promptSelect 缺省 input 回退 `process.stdin`，漏听 REPL 注入流 → 嵌入场景菜单收不到按键                  | 交互/UI      | 🟠 高  | ✅ 已解决       |
| V8-4   | 会话时间直接 slice 文件名字戳（UTC）→ `--list`/`/sessions` 显示偏早 8 小时                              | 会话/展示    | 🟡 中  | ✅ 已解决       |
| V8-5   | sanitizePath 测试用 Windows 路径字面量 → POSIX 拼 cwd 断言失败（CI 6 job 挂，Windows 侥幸通过）           | 测试/跨平台  | 🟠 高  | ✅ 已解决       |
| V8-P1  | REPL 兜底抛错无接盘：compact 兜底链 `throw e` 成 unhandledRejection → Node 20+ 默认 throw，REPL 崩溃    | 可靠性/REPL  | 🟠 高  | ⏳ 待修         |
| V8-P2  | 子 Agent 权限统一分析：extractMemories 只读三件套无条件 allow，绕过主引擎路径危险段判定（理论漏洞面）    | 权限/子Agent | 🟡 中  | 🤔 待整理（非 hotfix） |

---

## 一、已解决

### V8-1（高）grep 单文件 + glob 在 POSIX 绝对路径误报未找到

- **现象**（CI 暴露）：0.8.0 CI **6 job 挂**（Linux/macOS × Node 20/22/24），Windows 3 job 过。单文件搜索 + glob 过滤组合下，Linux/macOS 误报「未找到匹配」，Windows 正常。
- **根因**：单文件分支的 glob 过滤用**用户传入的绝对路径**去匹配 `**/*.ts` 这类 glob。`globToRegExp("**/*.ts")` 生成 `^(?:[^/]+/)*…`，正则锚定字符串开头——POSIX 绝对路径以 `/` 开头，`[^/]+` 无法从 `/` 起配 → 永远不匹配 → 误报「未找到」。Windows 盘符路径以字母开头（`C:\…`），`[^/]+` 能配字母 → **侥幸通过**。CI 只在非 Windows 挂，正是「正则锚定语义 × 平台路径形态」的分歧。
- **修复**（`src/tools/grep.ts`，commit `3909e1b`）：单文件分支的 `globRel` 改用 `path.basename(file)`（等价于「按父目录搜索时该文件的相对路径」），目录分支本就相对搜索根、行为不变；`globToRegExp` 导出 + 回归测试锁定「POSIX 绝对路径不匹配 / 相对与文件名匹配」。
- **教训**：跨平台路径行为不能靠「某平台侥幸通过」当验证——测试要显式覆盖 POSIX 绝对路径形态（`/` 开头），而不能只覆盖 Windows 盘符。

### V8-2（中）promptSelect 声明前引用 `rl` → TDZ ReferenceError

- **现象**：调用 `promptSelect` 即抛 `ReferenceError`（TDZ）。
- **根因**：`input` 缺省解析引用了**后声明**的 `rl`（`const rl = …` 在 input 表达式之后）——`let`/`const` 在初始化前访问触发 TDZ，是确定性的 TypeError，不是 undefined。
- **修复**（`src/ui/select.ts`）：`rl` 先声明，再解析 `input` 缺省。
- **教训**：缺省参数/默认表达式的求值顺序是「用前先算」——引用的变量必须在求值点之前已初始化；TDZ 错误要当作编译期级别的顺序问题来查，别先怀疑运行时。

### V8-3（高）promptSelect 缺省 input 回退 `process.stdin`，漏听 REPL 注入流

- **现象**：测试/嵌入场景下权限菜单、Trust 确认、`/sessions` 菜单**收不到按键**，静默卡住。
- **根因**：`promptSelect` 缺省 `input` 回退到 `process.stdin`，而 REPL 用**注入的 readline 输入流**（不是 process.stdin）驱动——菜单监听错了流，按键全落在别处。违反「stdin 唯一所有权」铁律。
- **修复**：显式 `input` 优先，否则回退 `rl.input`（Node `Interface` 类型不暴露 `input`，用窄化断言取）。
- **教训**：REPL 的 stdin 唯一所有权——权限弹窗/菜单必须复用 REPL 的 readline 流；缺省回退**不能假设 process.stdin**，注入流场景下会静默失效（无声失败比抛错更隐蔽）。

### V8-4（中）会话时间显示为 UTC，UTC+8 用户偏早 8 小时

- **现象**：`--list` / `/sessions` 显示的会话时间比本地时间偏早 8 小时。
- **根因**：展示层直接 slice 文件名字戳——`toISOString()` 输出的是 **UTC**，没有转本地时区。
- **修复**：**存储保持 UTC**（文件名字戳字典序==时间序，排序不变式依赖它），展示改用 `sessionIdTime(id)`（`src/utils/sessionStorage.ts`）转**本地时区**（地区自适应，跟随系统时区），`--list`/`/sessions` 换用。
- **教训**：存储格式与展示格式解耦——时间戳存储必须守恒（排序不变式），时区本地化只在显示层做，绝不在存储层转。

### V8-5（高）sanitizePath 测试用 Windows 路径字面量 → POSIX 拼 cwd 断言失败

- **现象**（CI 暴露）：0.8.1 CI **6 job 挂**（Linux/macOS × Node 20/22/24），Windows 3 job 过。`sessionStorage.test.ts` 两处断言失败：
  - `sanitizePath("C:/My/Project")` 期望 `C--My-Project`，实际 `-home-runner-work-run-agent-run-agent-C--My-Project`（被拼上 runner cwd）；
  - 超长截断测试 `s.slice(0, 200)` 期望 `/^C--/`，实际以 `-` 开头。
- **根因**：测试把 `"C:/…"` 当「任何平台都是绝对路径」。`sanitizePath` 内部 `path.resolve(p)`——POSIX 下 `C:` 只是相对路径段，`resolve` 会拼上 `process.cwd()`；Windows 盘符开头是绝对路径、`resolve` 幂等 → **侥幸通过**。实现本身正确（生产永远传绝对 `process.cwd()`），错在测试的 Windows 假设。
- **修复**（`tests/utils/sessionStorage.test.ts`，测试-only）：输入改 `path.resolve("My", "Project")` 派生绝对路径，期望用同一路径 `replace(/[^a-zA-Z0-9]/g, "-")` 计算；超长用例改 `path.resolve("/", "a".repeat(300), "b".repeat(100))`，截断断言改 `/^[A-Za-z-]+$/`（平台无关）。发布 0.8.1 后才发现（首次推批次到 CI），npm 包不受影响（测试不进 `files:["dist"]`）。
- **教训**：与 V8-1 同族——测试里不能把 Windows 盘符路径当绝对路径喂给 `path.resolve`/`sessionsDir` 等解析函数。凡是路径入参，先 `path.resolve` 再断言，否则 POSIX 静默拼 cwd。

---

## 二、待修开放项

### V8-P1（高）REPL 兜底抛错无接盘 → 整个 REPL 崩溃

- **现象**：compact 兜底链最终 `throw e` 时，REPL 进程直接崩溃退出。
- **根因**：`query.ts:271` / `:298` 抛出的 context_too_long 原始错误在 REPL 下无 catch 接盘——`runTurn`（`repl.ts:418`）→ `processPrompt` → `dequeue`（`repl.ts:690-701`，仅 try/finally）→ `void dequeue()` 成 **unhandledRejection**，全项目无 `unhandledRejection` 处理器 → Node 20+ 默认 throw → 进程崩溃。headless 有接盘（非 json：`index.ts:99-106` 打 `✗` 退出 1；`--json`：进 `errors[]`）；子 agent 最健壮（`execute.ts:188` catch 成「工具执行错误」回填主循环）。
- **修复方向**：给 REPL 的 turn 加顶层 catch（渲染红字错误 + 保留 REPL 存活 + 恢复 `promptLine`），或注册全局 `unhandledRejection` 兜底。修复后更新本条状态与 commit。
- **记录在**：`docs/Plan_V8.md` §2 待修清单。

### V8-P2（中）子 Agent 权限统一分析（理论漏洞面）

- **现象**：extractMemories 子 agent 的 `makeExtractMemCheckPermission`（`src/services/agents/builtin/extractMemories.ts:37-51`）对 `read_file`/`glob`/`grep` **无条件 allow**，绕过主权限引擎的路径危险段判定；而 `src/tools/read.ts:30` 的 read_file 工具本身**零路径校验**——安全完全依赖 checkPermission。
- **风险面**：增量消息夹带的提示注入可诱导提取器读任意敏感路径。当前缓解仅靠 Trust 门控 + 4 工具白名单。
- **推迟原因**（非 hotfix）：与子 Agent 系统相关，待整理子 Agent 系统时把 extractMemories / explore / verification / 自定义类型**所有内置子 agent 的权限统一分析和控制**（只读 allow 范围、路径白名单），不单独修。
- **记录在**：`docs/Plan_V8.md` §2 待整理清单 + 记忆索引。
