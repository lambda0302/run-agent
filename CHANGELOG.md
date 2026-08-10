# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

### Added

- 初始化项目骨架：TypeScript + Node 20、tsup 打包、Vitest、ESLint/Prettier、三 OS CI。
- CLI 空壳：`--version` / `--help` / 单条 prompt 调用 Anthropic。
- LLM 客户端抽象（`LLMClient`）+ Anthropic 参考适配器。
