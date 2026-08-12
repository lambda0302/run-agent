# Bug 记录 · V6「可编程化(Hooks + Skills + 自定义命令 + Headless)」

> 阶段：2026-08-12 ｜ 交付：`0.6.0`（Hooks / Skills / 自定义命令 / Headless）
> 来源：M4 Headless 集成测试暴露的 2 个实施期 bug（非真实使用，属测试先行抓出）。
> **V6-1 是 headless JSON 工具轨迹为空的顺序缺陷；V6-2 是 Windows 上 `process.exit()` 的 libuv 断言崩溃。均已随 0.6.0 修复。**

| #    | Bug                                                                               | 类别      | 严重度 | 状态               |
| ---- | --------------------------------------------------------------------------------- | --------- | ------ | ------------------ |
| V6-1 | headless JSON `tools` 轨迹恒为空：轨迹并入全局发生在工具 settle 之前              | 功能/逻辑 | 🟠 高  | ✅ 已解决（0.6.0） |
| V6-2 | headless 收尾 `process.exit()` 在 Windows 触发 libuv `UV_HANDLE_CLOSING` 断言崩溃 | 平台/收尾 | 🟠 高  | ✅ 已解决（0.6.0） |

---

## 逻辑：headless JSON 工具轨迹恒为空（V6-1）

- **现象**（M4 集成测试，2026-08-12）：`--print + --json` 跑完 2 轮工具循环后，JSON 里 `reply/messages/turns` 全对，但 `tools` 恒为 `[]`——明明 stderr 上 `⚡ read_file` 已执行。
- **根因**：`src/core/query.ts` 里 `toolCalls.push(...attemptCalls)` 写在 `await executor.getResults()` **之前**。`onToolTrace` 只在 `settle()`（工具真正完成）时触发，而 `StreamingToolExecutor` 是 fire-and-forget——流结束、`push` 那一刻工具还在后台跑，`attemptCalls` 还是空的；等 `getResults()` 把工具等完、`settle` 往 `attemptCalls` 填了轨迹时，合并已经发生过了，且下一轮迭代会重建 `attemptCalls` 数组，上一轮的轨迹彻底丢失。
- **修复**（0.6.0，commit 待填）：把 `toolCalls.push(...attemptCalls)` 移到 `await executor.getResults()` 之后——先等全部工具 settle（轨迹落进 `attemptCalls`），再并入全局。测试 `tests/cli/headless.test.ts` 锁定（只读轨迹 permission=allow、写 deny/allow、截断、max-turns 累积）。
- **教训**：轨迹收集的**触发点（settle）与合并点（getResults 之后）必须严格先后**；「流式边执行」下任何依赖工具完成的集合操作都要等 `getResults()`。

---

## 平台：Windows `process.exit()` 触发 libuv 断言崩溃（V6-2）

- **现象**（M4 集成测试，Windows）：headless JSON 已完整写到 stdout，随后子进程崩溃，退出码 `3221226505`（0xC0000409），stderr 末行 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76`。
- **根因**：`runHeadless` 在 `process.stdout.write(payload, cb)` 回调里直接 `process.exit(...)`。此时 undici fetch 的连接关闭、会话文件 fs 操作等 libuv 句柄仍处于 closing 状态，Windows libuv 在句柄关闭中途强退循环触发断言。非 Windows 平台同样路径不炸（libuv 行为差异）。
- **修复**（0.6.0，commit 待填）：headless 收尾**不调用 `process.exit()`**——先 `await agentOpts.mcpManager?.closeAll()`（回收 MCP 子进程句柄，否则卡住事件循环），再 `process.stdout.write(payload, cb)`，回调里只设 `process.exitCode = errors.length ? 1 : 0`，让事件循环自然退出（确定性退出码 0/1）。启动期错误（无 key、flag 互斥等）仍在 `.action` catch 里 `process.exit`——彼时无工具执行、无 in-flight 句柄，行为不变。
- **教训**：CLI 收尾**能用 `process.exitCode` + 自然退出就绝不 `process.exit()`**；Windows libuv 对「句柄关闭中途强退」是断言崩溃而非温和失败。头less 下必须显式回收会持活事件循环的资源（MCP 子进程）再自然退出。

---

## 小结

- **实施期 bug 2 个**（V6-1 轨迹空、V6-2 Windows 崩溃），均由 M4 集成测试先行抓出、随 0.6.0 修复——测试优先在无真实 key 的 hermetic 环境里把 headless 契约锁死，省掉了发布后的线上炸雷。
- **共性教训**：① 依赖「工具完成」的结果收集必须排在 `getResults()` 之后；② CLI 强退用 `process.exitCode` + 自然退出，别用 `process.exit()`。
