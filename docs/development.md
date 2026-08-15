# 本地开发

## 前置条件

- Node.js >= 20（建议 20 / 22 / 24 LTS）
- npm

## 快速开始

```bash
npm ci
npm run build      # 打包 dist/cli.js
npm run smoke      # build + 冒烟（--version / --help）
```

## 命令

| 命令                   | 作用                                          |
| ---------------------- | --------------------------------------------- |
| `npm run dev`          | tsup --watch（改源码自动重新打包）            |
| `npm run typecheck`    | TypeScript 类型检查（tsc --noEmit）           |
| `npm run lint`         | ESLint 检查                                   |
| `npm run lint:fix`     | ESLint 自动修复                               |
| `npm run format`       | Prettier 格式化                               |
| `npm run format:check` | Prettier 检查                                 |
| `npm run test`         | **先 build 再跑 vitest**（冒烟测试依赖 dist） |
| `npm run test:watch`   | vitest 监听模式（不 build，适合改单测时用）   |
| `npm run build`        | tsup 打包 CLI                                 |

## 测试说明

- provider 适配器测试（`tests/providers/`）：mock SDK，覆盖流式 + tool_use / function calling 互转，**不依赖真实 API key**。
- `tests/config.test.ts`：配置优先级矩阵；`tests/core/query.test.ts`：mock LLM 驱动的 agent loop golden 场景。
- `tests/tools/`：Edit / Glob / Grep / Bash / zod→JSONSchema 单测。
- `tests/services/`：Hooks / Skills / 自定义命令（loader + manager + tool + exec）。
- `tests/cli/`：对 `dist/cli.js` 的集成测试——`headless.test.ts`（`--print`+`--json` 契约，走
  `tests/cli/mockLLM.ts` 本地 mock LLM server，hermetic、无真实网络/API key，打包产物必须先生成
  dist）、`output-gate.test.ts`、`repl_skills.test.ts` / `repl_commands.test.ts` / `repl_mcp.test.ts`。
- `tests/cli.test.ts`：CLI 冒烟测试（可执行性、帮助、错误退出）。
- 涉及配置/会话路径的测试要沙箱子进程环境（`USERPROFILE`/`HOME` 指向临时目录），防读到真实配置。
- 真实模型调用请在本地手动验证（需要 API key）：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
node dist/cli.js "你好，请用一句话自我介绍"
# 或进入 REPL
node dist/cli.js
```

## 二次开发（0.6.0）

- **Hooks** 扩展点 `src/services/hooks/`：新事件类型、hook 输出回喂模型（当前仅 Stop 注入）。
- **Skills** 扩展点 `src/services/skills/`：SkillTool 子 agent 化 → V7（当前主循环注入 + allowed-tools 过滤）。
- **自定义命令** 扩展点 `src/services/commands/`：local-jsx 形态 → V9；local 输出自动回喂模型。
- 新工具实现 `Tool` 接口（`src/tools.ts`）即可接入，写类工具显式 `isConcurrencySafe: false`。

## CI

推送到 `main` 或开 PR 时，GitHub Actions 会在 ubuntu / windows / macos × node 20 / 22 / 24 上跑 typecheck、lint、test、build。
