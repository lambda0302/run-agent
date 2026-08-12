# Bug 记录 · V6「可编程化(Hooks + Skills + 自定义命令 + Headless)」

> 阶段：2026-08-12 ｜ 交付：`0.6.0`（Hooks / Skills / 自定义命令 / Headless）
> 来源：M4 Headless 集成测试 + macOS CI 暴露的 3 个实施期 bug（非真实使用，属测试先行抓出）。
> **V6-1 是 headless JSON 工具轨迹为空的顺序缺陷；V6-2 是 Windows 上 `process.exit()` 的 libuv 断言崩溃；V6-3 是 macOS `/var→/private/var` 系统 symlink 下 `pathInCwd` 误判 cwd 外、headless 降级 deny。均已随 0.6.0 修复。**

| #    | Bug                                                                                          | 类别      | 严重度 | 状态               |
| ---- | -------------------------------------------------------------------------------------------- | --------- | ------ | ------------------ |
| V6-1 | headless JSON `tools` 轨迹恒为空：轨迹并入全局发生在工具 settle 之前                         | 功能/逻辑 | 🟠 高  | ✅ 已解决（0.6.0） |
| V6-2 | headless 收尾 `process.exit()` 在 Windows 触发 libuv `UV_HANDLE_CLOSING` 断言崩溃            | 平台/收尾 | 🟠 高  | ✅ 已解决（0.6.0） |
| V6-3 | macOS `/var→/private/var` 下 `pathInCwd` 把物理化 cwd 与逻辑别名 p 误判 cwd 外 → headless deny | 平台/判定 | 🟠 高  | ✅ 已解决（0.6.0） |

---

## 逻辑：headless JSON 工具轨迹恒为空（V6-1）

- **现象**（M4 集成测试，2026-08-12）：`--print + --json` 跑完 2 轮工具循环后，JSON 里 `reply/messages/turns` 全对，但 `tools` 恒为 `[]`——明明 stderr 上 `⚡ read_file` 已执行。
- **根因**：`src/core/query.ts` 里 `toolCalls.push(...attemptCalls)` 写在 `await executor.getResults()` **之前**。`onToolTrace` 只在 `settle()`（工具真正完成）时触发，而 `StreamingToolExecutor` 是 fire-and-forget——流结束、`push` 那一刻工具还在后台跑，`attemptCalls` 还是空的；等 `getResults()` 把工具等完、`settle` 往 `attemptCalls` 填了轨迹时，合并已经发生过了，且下一轮迭代会重建 `attemptCalls` 数组，上一轮的轨迹彻底丢失。
- **修复**（0.6.0，commit `19d0195`）：把 `toolCalls.push(...attemptCalls)` 移到 `await executor.getResults()` 之后——先等全部工具 settle（轨迹落进 `attemptCalls`），再并入全局。测试 `tests/cli/headless.test.ts` 锁定（只读轨迹 permission=allow、写 deny/allow、截断、max-turns 累积）。
- **教训**：轨迹收集的**触发点（settle）与合并点（getResults 之后）必须严格先后**；「流式边执行」下任何依赖工具完成的集合操作都要等 `getResults()`。

---

## 平台：Windows `process.exit()` 触发 libuv 断言崩溃（V6-2）

- **现象**（M4 集成测试，Windows）：headless JSON 已完整写到 stdout，随后子进程崩溃，退出码 `3221226505`（0xC0000409），stderr 末行 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76`。
- **根因**：`runHeadless` 在 `process.stdout.write(payload, cb)` 回调里直接 `process.exit(...)`。此时 undici fetch 的连接关闭、会话文件 fs 操作等 libuv 句柄仍处于 closing 状态，Windows libuv 在句柄关闭中途强退循环触发断言。非 Windows 平台同样路径不炸（libuv 行为差异）。
- **修复**（0.6.0，commit `19d0195`）：headless 收尾**不调用 `process.exit()`**——先 `await agentOpts.mcpManager?.closeAll()`（回收 MCP 子进程句柄，否则卡住事件循环），再 `process.stdout.write(payload, cb)`，回调里只设 `process.exitCode = errors.length ? 1 : 0`，让事件循环自然退出（确定性退出码 0/1）。启动期错误（无 key、flag 互斥等）仍在 `.action` catch 里 `process.exit`——彼时无工具执行、无 in-flight 句柄，行为不变。
- **教训**：CLI 收尾**能用 `process.exitCode` + 自然退出就绝不 `process.exit()`**；Windows libuv 对「句柄关闭中途强退」是断言崩溃而非温和失败。头less 下必须显式回收会持活事件循环的资源（MCP 子进程）再自然退出。

---

## 平台：macOS `/var→/private/var` 下 `pathInCwd` 误判 cwd 外（V6-3）

- **现象**（macOS CI，2026-08-12）：3 个 OS 里只有 macOS 的 headless 集成测试全挂——`read_file`（allow 路径）与 `write_file`（acceptEdits 路径）都从 permission=allow 跌成 `deny`，消息截断测试的 `endsWith` 断言也失败。CI 临时目录在 `/var/folders/...`（macOS 的 `/var` 是 → `/private/var` 的系统 symlink）。
- **根因**：POSIX `getcwd()` 在进程 `chdir` 进入符号链接后返回的是**物理路径**。`mkdtempSync(tmpdir())` 拿到的 `/var/folders/...` 是逻辑形态，但子进程 `cwd: dir` 后 `process.cwd()` 已是 `/private/var/folders/...`。旧 `pathInCwd` 要求 p 的**所有形态**（expand+resolve / realpath）都落在 cwd 的**某个形态**内：文件入参是逻辑别名 `/var/folders/...`，匹配不上已物理化的 cwd → 判 cwd 外 → 走 ask → headless 无交互降级 deny。Windows/Ubuntu 临时目录不是 symlink，两侧形态本就一致，故不炸。
- **修复**（0.6.0）：`pathInCwd` 改为**只比较 realpath 形态**——`real(p)` 等于 `real(cwd)` 或在其子路径内即判 cwd 内。两侧都做 `realpath` 归一后，macOS 的 `/var` 别名自然对上。逃逸拦截不退化：换名逃逸（foo → /etc/passwd）下 `real(p)` 越出 `real(cwd)` → 仍 false；逃进 `.git`/`.run-agent` 的另一个方向由 `hasDeniedDirSegment` 对双形态 `forms.some` 各自兜底、memory 豁免由 `forms.every` 守住，都不依赖本函数。回归测试 `tests/permissions/engine.test.ts`（符号链接别名 vs realpath 形态的 cwd → 判 cwd 内，V6-3 场景）。
- **教训**：**凡涉及「路径是否在 cwd 内」的判定，一律以 realpath 物理位置为准**——`process.cwd()`/`getcwd()` 进过符号链接后就是物理形态，拿逻辑形态去比必然错；系统级 symlink（macOS `/var`）会让「两种形态都要匹配」这类看似严谨的双重校验反而误伤，因为 cwd 侧可能只有物理形态、p 侧可能只有逻辑形态。

---

## 小结

- **实施期 bug 3 个**（V6-1 轨迹空、V6-2 Windows 崩溃、V6-3 macOS 路径误判），V6-1/2 由 M4 集成测试先行抓出、V6-3 由 macOS CI 抓出，均随 0.6.0 修复——测试优先在无真实 key 的 hermetic 环境 + 三 OS CI 里把 headless 契约与路径判定锁死，省掉了发布后的线上炸雷。
- **共性教训**：① 依赖「工具完成」的结果收集必须排在 `getResults()` 之后；② CLI 强退用 `process.exitCode` + 自然退出，别用 `process.exit()`；③ cwd 内判定以 realpath 物理位置为唯一基准，别用逻辑别名互比。
