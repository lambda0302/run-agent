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
| `npm run dev`          | 尚未启用；V1 引入 tsup --watch                |
| `npm run typecheck`    | TypeScript 类型检查（tsc --noEmit）           |
| `npm run lint`         | ESLint 检查                                   |
| `npm run lint:fix`     | ESLint 自动修复                               |
| `npm run format`       | Prettier 格式化                               |
| `npm run format:check` | Prettier 检查                                 |
| `npm run test`         | **先 build 再跑 vitest**（冒烟测试依赖 dist） |
| `npm run test:watch`   | vitest 监听模式（不 build，适合改单测时用）   |
| `npm run build`        | tsup 打包 CLI                                 |

## 测试说明

- `tests/providers/anthropic.test.ts`：mock SDK 的单测，**不依赖真实 API key**。
- `tests/cli.test.ts`：对 `dist/cli.js` 的冒烟测试，验证可执行性与帮助信息；**必须先生成 dist**（`npm test` 已内置 build）。
- 真实模型调用请在本地手动验证（需要 API key）：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
node dist/cli.js "你好，请用一句话自我介绍"
```

## CI

推送到 `main` 或开 PR 时，GitHub Actions 会在 ubuntu / windows / macos × node 20 / 22 / 24 上跑 typecheck、lint、test、build。
