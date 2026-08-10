# Contributing

感谢你愿意为 Run Agent 贡献！

## 开发环境

- Node.js >= 20（建议 20 / 22 / 24 LTS）
- npm

## 常用命令

```bash
npm ci          # 安装依赖（首次）
npm run dev     # 见 docs/development.md
npm run typecheck
npm run lint
npm run test
npm run build
npm run smoke
```

## 提交信息约定

遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/v1.0.0/)：

- `feat:` 新功能
- `fix:` 修 bug
- `chore:` 工程杂项
- `docs:` 文档
- `test:` 测试
- `refactor:` 重构

## PR 流程

1. Fork 本仓库并创建分支：`git checkout -b feat/my-feature`。
2. 提交改动（一次 PR 聚焦一件事，提交信息按约定）。
3. 推送分支并创建 Pull Request。
4. 通过三 OS CI（GitHub Actions 会自动跑）。
5. 保持 PR 描述清晰：改动摘要、测试情况、是否更新文档与 CHANGELOG。

## 质量要求

- 新功能必须带测试（单测 + 必要的冒烟测试）。
- 改动影响公开行为时，同步更新 `docs/` 与 `CHANGELOG.md`。
- 类型检查、lint、测试、构建必须全部通过。

## 报告 bug / 提需求

使用 [issue 模板](https://github.com/lambda0302/run-agent/issues/new/choose)。
