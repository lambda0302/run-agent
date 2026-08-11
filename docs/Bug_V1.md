# Bug 记录 · V1「ReAct MVP + 多提供商」

> 阶段：2026-08-10 ｜ 交付：`0.1.0`（ReAct loop + 4 适配器 + 6 工具 + 配置 + REPL + 会话持久化，58 测试）
> 来源：会话记录、CHANGELOG `[0.1.0] Fixed`、git 提交。所有条目均已解决。

| #    | Bug                                                                   | 类别       | 严重度 | 状态      |
| ---- | --------------------------------------------------------------------- | ---------- | ------ | --------- |
| V1-1 | OpenAI 流式 `tool_calls` 跨 chunk 分片聚合                            | 适配器     | 高     | ✅ 已解决 |
| V1-2 | Anthropic 流式 `input_json_delta` 聚合 + `tool_result` 块             | 适配器     | 高     | ✅ 已解决 |
| V1-3 | Edit 工具处理不了不可见 BOM 字符（源码里还混入了字面 BOM）            | 文件工具   | 中     | ✅ 已解决 |
| V1-4 | glob `**` 分支漏子文件且结果重复                                      | 文件工具   | 中     | ✅ 已解决 |
| V1-5 | `latestSessionFile` 返回 `undefined`，`--resume` 续不上               | 会话持久化 | 中     | ✅ 已解决 |
| V1-6 | zod v4 移除 `_def.typeName`，`zodToJsonSchema` 崩                     | 工具机制   | 高     | ✅ 已解决 |
| V1-7 | strict TS 约束：`exactOptionalPropertyTypes` / `verbatimModuleSyntax` | 编译约束   | 低     | ✅ 已规避 |
| V1-8 | `.env` 加载函数写了但从未接线（V1 遗留，0.2.0 前修复）                | 配置       | 中     | ✅ 已解决 |

---

## V1-1 OpenAI 流式 `tool_calls` 跨 chunk 分片聚合

- **现象**：流式响应里 tool call 的 `id`/`name`/`arguments` 是**按 delta 分片**发来的（首个 chunk 只有 `id`+`name`，后续 chunk 只有 `arguments` 增量片段）；直接取单块会拿到残缺参数，工具调用失败。
- **根因**：OpenAI 流式协议本身如此（`delta.tool_calls[].function.arguments` 是增量拼接）。
- **修复**：适配器按 `index` 跨 chunk 聚合——维护 `Map<index, {id, name, arguments}>`，逐 chunk 追加 `arguments` 片段，`finish_reason` 时合并成完整 tool_use；配专门单测覆盖分片场景。
- **教训**：流式 tool_calls 聚合是适配器最容易写错的地方，属于**协议差异、必须单测锁定**（CHANGELOG 0.1.0 Fixed 记录）。

## V1-2 Anthropic 流式 `input_json_delta` 聚合 + `tool_result` 块

- **现象**：Anthropic 流式的 tool_use `input` 以 JSON delta（`input_json_delta`）增量到达；且 tool 执行结果要以 `tool_result` 块合并进 user 消息，格式不对模型就解析不了。
- **根因**：Anthropic 的块式流协议。
- **修复**：跨事件聚合 `input_json_delta`；工具结果按 `tool_result` 块回填到 user 消息。
- **教训**：两家大厂的流式 tool 协议格式不同，统一发生在适配器层——**loop 层只见统一内部格式**（这是 V1 架构的关键决策）。

## V1-3 Edit 工具处理不了不可见 BOM 字符

- **现象**：含 BOM 的文件，精确匹配类工具（Edit/Grep）找不到内容；更隐蔽的是 **`grep.ts` 源码里被写入了不可见的字面 BOM 字符**，导致字符串匹配串里有隐形字符。
- **根因**：读文件时 BOM（`﻿`）没被剥离；写代码时把"肉眼看不见的 BOM 字符"直接贴进了源码字符串，而不是转义写法。
- **修复**：`read.ts` 用 `/﻿/` 正则剥离 BOM；用 node 脚本把两个文件里的字面 BOM 统一重写为 `﻿` 转义，消除隐形字符。
- **教训**：涉及 BOM 一律用 `﻿` 转义写法，绝不在源码里粘贴不可见字符；读文件统一先剥离 BOM（CLAUDE.md 已固化）。

## V1-4 glob `**` 分支漏子文件且结果重复

- **现象**：递归 `**` 匹配结果缺失（子文件没匹配上）且会出现重复条目。
- **根因**：walk 逻辑里 `**` 分支的处理不正确。
- **修复**：重构 walk——用 `Set` 去重；`**` 消耗当前段后**继续匹配剩余路径段**，保证能命中深层文件且不重复。
- **教训**：递归 glob 的去重与"消耗段后继续匹配"是容易写错的点，配 glob 工具单测覆盖。

## V1-5 `latestSessionFile` 返回 `undefined`，`--resume` 续不上

- **现象**：`--resume` 找不到可续接的会话（函数返回 undefined）。
- **根因**：函数里遗留了多余的 `stat` 代码；且目录不可注入导致难以测试定位。
- **修复**：清理多余代码；让 `createSessionFile`/`latestSessionFile` **支持注入目录**（便于测试），重写 `sessionStorage.ts` 并补单测。
- **教训**：文件系统工具做成"目录可注入"（依赖注入）是让 session 逻辑可测的关键。

## V1-6 zod v4 移除 `_def.typeName`，`zodToJsonSchema` 崩

- **现象**：手写 `zodToJsonSchema` 时访问 schema 的 `_def.typeName` 报错/拿不到。
- **根因**：**zod v4 移除了 `_def.typeName`**，内部结构改了；且 v4 是"双类型系统"——运行时只有经典 `z.Zod*` 类，`.element`/`.options`/`.shape` 等访问器返回的 new-style `$ZodType` 与经典类型结构不兼容。
- **修复**：改用**公共 getter**（`instanceof` + `.shape`/`.options`/`.element`/`.minLength`），用 `unwrap()` 处理 optional/nullable/default；参数声明为 `unknown` 再用 `instanceof` 缩小。
- **教训**：zod v4 内省方式与 v3 不同；`z.number()` 无界时 `minValue/maxValue` 是 `±Infinity`，要 `Number.isFinite` 守卫（CLAUDE.md 已固化）。

## V1-7 strict TS 编译约束（`exactOptionalPropertyTypes` / `verbatimModuleSyntax`）

- **现象**：typecheck 反复报两类错——可选属性不能写 `{ key: undefined }`；类型导入必须 `import type`。
- **根因**：`tsconfig.json` 开了 strict 家族里的 `exactOptionalPropertyTypes` 与 `verbatimModuleSyntax`（V0 定的）。
- **修复**：可选属性一律用**条件 spread** `...(val !== undefined ? { key: val } : {})`；类型导入一律 `import type`。
- **教训**：这是**贯穿所有版本**的硬约束，任何新代码都按这两条写，避免反复返工（CLAUDE.md 已固化）。

## V1-8 `.env` 加载函数写了但从未接线

- **现象**：README / `docs/usage.md` 承诺"项目根 `.env` 自动加载"，实际 `.env` 不生效。
- **根因**：`src/config/load.ts` 的 `loadDotEnv()` 在 V1 写好了，但 `src/cli/index.ts` **从未调用它**——功能存在却断线。
- **修复**：在 `main()` 开头、`loadConfig()` 之前调用 `loadDotEnv()`（已存在的环境变量优先、不覆盖），并补单测锁定（修复落地于 0.2.0 前，CHANGELOG 0.2.0 Changed 记录）。
- **教训**：配置入口函数写完要立刻接线 + 测试，README 承诺的能力必须端到端验证；"写了但没人调"是最隐蔽的失效方式。

---

## 小结

V1 的 bug 集中在**协议适配**（V1-1/V1-2，两家大厂流式 tool 差异）、**文件处理**（V1-3/V1-4，BOM、递归 glob）和**持久化**（V1-5）。其中 V1-6（zod v4）与 V1-7（TS strict）是"框架版本差异"型 bug，靠 CLAUDE.md 固化经验避免了后续反复踩坑。V1 遗留一个接线缺陷（V1-8）到 0.2.0 前才修复——提醒后续版本"写完就接线、接线就测"。
