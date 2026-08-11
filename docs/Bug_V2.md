# Bug 记录 · V2「安全与并发 + Trust」

> 阶段：2026-08-11 ｜ 交付：`0.2.0`（权限引擎 + Trust + 工具并发 + 流式重试，95 测试）
> 来源：会话记录、git 提交 `b493449`。**前 4 条是真实安全缺陷，由新增测试矩阵揪出后才修复。** 所有条目均已解决。

| # | Bug | 类别 | 严重度 | 状态 |
| -- | ---------------------------------------------------------- | ---------------- | ------ | ---- |
| V2-1 | `(\/|~)\b` 尾部 `\b` 让 `rm -rf /`、`rm -rf ~` 漏判为安全 | 权限引擎/安全 | 🔴 严重 | ✅ 已解决 |
| V2-2 | `sudo rm -rf /var` 只判到 risky（危险 rm 模式锚定 `^\s*rm`） | 权限引擎/安全 | 🔴 严重 | ✅ 已解决 |
| V2-3 | `wget … \| bash` 判成 safe（管道模式只匹配 `\| sh`） | 权限引擎/安全 | 🟠 高 | ✅ 已解决 |
| V2-4 | `git checkout .` 尾部 `\b` 同款漏判 | 权限引擎 | 🟠 高 | ✅ 已解决 |
| V2-5 | `pathMatchesGlob` 的 `**/` 需字面斜杠，`C:/proj/**/*.ts` 不命中 `a.ts` | 权限引擎 | 🟠 高 | ✅ 已解决 |
| V2-6 | execute 测试 tracker 闭包按值快照 `max`，并发上限测不准 | 测试 | 中 | ✅ 已解决 |
| V2-7 | store 测试 `await import` 用在非 async 回调，typecheck 报错 | 测试 | 低 | ✅ 已解决 |
| V2-8 | 数组字面量 `action: "deny"` 被放宽成 `string` | 测试/类型 | 低 | ✅ 已解决 |
| V2-9 | config 测试读到真实 config.json，不再 hermetic | 测试隔离 | 🟠 高 | ✅ 已解决 |
| V2-10 | cli 测试子进程继承真实 config + 真实 key，发出真实请求 | 测试隔离 | 🔴 严重 | ✅ 已解决 |
| V2-11 | 权限确认在同一 stdin 上新建 readline → 输入一个 y 回显成两三个；`yy` 被旧逻辑判为拒绝 | 权限引擎/交互 | 🟠 高 | ✅ 已解决 |

---

## 权限引擎：真实安全缺陷（V2-1 ~ V2-5）

这些 bug 是同一个教训的多个变体：**正则的"尾部 `\b`"与"锚点"在特定输入下漏判**。全是被权限判定矩阵测试先揪出来、再改引擎修复的——测试先于实现验证的价值体现。

### V2-1 `rm -rf /` / `rm -rf ~` 漏判为不危险（最严重）

- **现象**：最危险的删除命令 `rm -rf /`、`rm -rf ~`（目标在字符串末尾）**不被分类为 dangerous**，绕过了内置无条件 deny。
- **根因**：`DANGEROUS_PATTERNS[0]` 写成 `/^\s*rm\s+(?:…)?(\/|~)\b/i`——末尾的 `\b` 要求字符后存在**词边界**；而 `/` 和 `~` 是非单词字符、且位于串尾时后面没有任何字符，根本不存在词边界 → 不匹配。
- **修复**：去掉尾部 `\b`，改为 `/^\s*rm\s+(?:-[a-z]*[rR][a-z]*\s+)?(\/|~)/i`。
- **教训**：在"目标位于字符串末尾"的场景，`\b` 是危险的——`/`、`~`、`.` 等非词字符都满足不了边界。安全判定正则宁宽勿漏。

### V2-2 `sudo rm -rf /var` 只判到 risky

- **现象**：带 `sudo` 前缀的根删除只被判为 risky（ask），而没进内置 deny。
- **根因**：危险 `rm` 模式锚定在 `^\s*rm`，被 `sudo ` 前缀躲过。
- **修复**：新增独立模式 `/\bsudo\b.*\brm\s+(?:-[a-z]*[rR][a-z]*\s+)?(\/|~)/i` 覆盖 sudo 前缀。
- **教训**：命令开头有修饰词（`sudo`/`env`/`timeout` 等）时，`^` 锚点会漏；对高风险命令要同时覆盖"裸命令"与"被前缀包裹"两种形态。

### V2-3 `wget … | bash` 判成 safe

- **现象**：`curl/wget … | bash` 没有被识别为风险命令（原先只拦 `| sh`）。
- **根因**：管道到 shell 的模式只写了 `\|\s*sh\b`，漏了 `bash`。
- **修复**：扩展到 `\|\s*(?:sh|bash)\b`。
- **教训**：shell 别名形态要枚举全（`sh`/`bash`/`zsh` 等），"管道给解释器执行"是经典高危形态。

### V2-4 `git checkout .` 尾部 `\b` 同款漏判

- **现象**：`git checkout .`（点位于串尾）漏掉 risky 判定，与 V2-1 同类。
- **根因**：`RISKY_PATTERNS` 里 `git checkout .` 同样挂了尾部 `\b`，串尾的 `.` 无词边界。
- **修复**：去掉 `/\b(git\s+reset\s+--hard|git\s+checkout\s+\.)\b/` 的尾部 `\b`。
- **教训**：同一个缺陷模式出现在清单多处——修一个就要全局排查所有 pattern 的尾部 `\b`。

### V2-5 `**/` glob 需字面斜杠

- **现象**：`pathMatchesGlob("C:/proj/a.ts", "C:/proj/**/*.ts")` 返回 false——`**/` 应能匹配**零级**目录。
- **根因**：`**/` 的实现要求目标里必须有一个字面斜杠。
- **修复**：`**/` 生成 `(?:.*/)?`（零级或多级目录均可命中）。
- **教训**：glob 的 `**/` 语义是"可零可多"，实现时最容易写成"至少一级"。

---

## 测试隔离：测试污染真实环境的严重问题（V2-9 / V2-10）

### V2-10 cli 测试子进程继承真实 config + 真实 key（最严重）

- **现象**：`tests/cli.test.ts` 里"缺 baseURL 应报错"的用例不再报错，进程反而退出码 0、**拿用户真实的 DeepSeek key 对真实 API 发了请求**。
- **根因**：测试子进程通过 `execFile` 继承了进程环境，**读到了用户真实 `~/.config/run-agent/config.json`**——里面配好了 baseURL 和 `apiKeyEnv`，于是"缺参数"分支走不到，还触发了真实模型调用。
- **修复**：用 `USERPROFILE`/`HOME` 指向临时目录**沙箱化子进程环境**，让子进程读不到真实 config；清理临时目录于 `afterEach`。修复时误删了 `promisify` 导入，一并恢复。
- **教训**：配置类库的测试必须隔离真实用户配置；**测试环境里绝不能允许发出真实 API 请求**。这是测试 hermeticity 的底线。

### V2-9 config 测试读到真实 config.json

- **现象**：`tests/config.test.ts` 的"无任何来源时回退默认 provider=anthropic"用例读到了用户真实 config（openai-compatible），断言失败。
- **根因**：测试走默认路径，而用户机器上已存在 `~/.config/run-agent/config.json`。
- **修复**：该用例显式传入**不存在的临时 configPath**，使测试与真实环境无关。
- **教训**：一旦用户开始真实使用工具，默认路径测试就会漂移；配置类测试一律显式指定路径。

---

## 其它（V2-6 ~ V2-8）

### V2-6 execute 测试 tracker 闭包按值快照 `max`

- **现象**：并发上限用例断言 `t.max <= 10`，但 `t.max` 恒为 0——并发度测不出来。
- **根因**：对象字面量 `{ run, max }` 把 `max` 这个数字**按值**快照进返回对象；之后 `max` 再增长，快照里仍是初始 0。且 delay 的 sleep 放在 tracker 之外，并发度根本测不到。
- **修复**：改成 `currentMax: () => max` 的 **getter**（闭包读最新值）；把 sleep 移进 `tracker.run` 内。
- **教训**：闭包捕获变量要暴露 getter 而非值快照；并发测试必须让延迟发生在被测对象内部才能度量并发度。

### V2-7 store 测试 `await import` 用在非 async 回调

- **现象**：typecheck 报错——`await import("node:fs")` 出现在非 async 的 `it()` 回调里。
- **修复**：把 `writeFileSync` 等提到文件顶部同步 `import`。
- **教训**：测试文件顶层能用同步 import 就不要动态 `await import`。

### V2-8 数组字面量 `action: "deny"` 被放宽成 `string`

- **现象**：typecheck 报错——`const deny = [{ …, action: "deny" }]` 把 `action` 推断成宽泛的 `string`，不再满足 `PermissionRule`。
- **修复**：显式注解 `const deny: PermissionRule[] = […]`。
- **教训**：字面量数组的类型收窄要靠显式注解，别依赖推断。

---

## 交互：双 y 回显（V2-11）

- **现象**：REPL 内权限确认时，**输入一个 `y` 屏幕上却回显出两三个 `y`**；且任务完成后用户输入 `y` 会被当成新 prompt 让模型再跑一遍上一任务（后者是 REPL 语义，不是 bug，见下）。
- **根因**：`resolveAsk`（`src/permissions/prompt.ts`）每次弹确认都在 `process.stdin` 上**新建一个 `readline` interface**，而 REPL 已经有一个 `rl` 独占 stdin——同一流两个 reader → 字节回显重复，输入一个 `y` 变成 `yy`/`yyy`。
- **功能后果**：旧逻辑只认精确 `y`/`yes`，回显产生的 `yy` 被判为**拒绝**（用户看到 `✗ 已拒绝执行 run_bash`）。
- **修复**（V2 收尾）：`resolveAsk` 增加可注入的 `ask` 函数，REPL 用 `rl.question` 复用**唯一 readline**；`checkPermission` 构造移入 `repl.ts` 的 `makeCheckPermission(ctx, out, ask)`，`index.ts` 只传 `ctx`。同时容忍纯 `y` 串（`yy`/`yyy` → 允许）。配 `tests/permissions/prompt.test.ts` 10 条回归锁定。
- **区分**：「任务完成后输入 `y` 又执行上一任务」是 REPL 语义——任务结束返回 `run-agent>` 提示符后，任何输入（含 `y`）都是新 prompt，带全量上下文发给模型。真正的困惑是**没有「任务结束」的视觉标记**，已用 REPL 任务完成分隔线解决（非本 bug 修复范围）。

---

## 小结

V2 的 bug 有**三个主题**：

1. **安全正则漏判**（V2-1 ~ V2-5）——全是"尾部 `\b` / 开头 `^` 锚点 / 别名不全 / glob 语义"这几个正则反模式，且**全部由权限判定矩阵测试先揪出**。这直接证明 V2"先写测试矩阵再实现引擎"的做法是对的。
2. **测试 hermeticity**（V2-9 / V2-10）——用户开始真实使用后，默认路径/环境继承的测试开始漂移甚至**发出真实 API 请求**，必须沙箱化。
3. **stdin 所有权**（V2-11）——`process.stdin` 同时存在两个 reader（REPL readline + 弹窗自建 readline）导致输入回显错乱。铁律：**stdin 只能有一个读者**；交互组件复用 REPL 的 readline，而不是另起炉灶。

前 4 条是**真实安全缺陷**，修完后 `rm -rf /`、`rm -rf ~`、`sudo rm -rf …`、`wget | bash` 全部进入内置无条件 deny。这些经验（`\b` 反模式、`**/` 语义、环境隔离）已固化进 CLAUDE.md 与引擎注释。
