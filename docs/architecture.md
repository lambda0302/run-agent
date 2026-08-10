# 架构

## 目录结构

```
run-agent/
├── .github/
│   ├── ISSUE_TEMPLATE/        # issue 模板
│   ├── pull_request_template.md
│   └── workflows/ci.yml       # 三 OS CI
├── docs/                      # 文档与路线图
├── src/
│   ├── cli/index.ts           # Commander 入口
│   ├── providers/             # LLM 提供商抽象与适配器
│   │   ├── types.ts           # LLMClient 接口
│   │   └── anthropic.ts       # Anthropic 参考适配器
│   └── utils/errors.ts        # RunAgentError
├── tests/                     # vitest
└── dist/                      # tsup 打包产物（git 忽略）
```

## 分层

```
cli (入口/参数解析)
  └── providers (LLM 适配层)
        └── [core] [tools]   ← V1 加入
```

- **cli**：参数解析、输出，不包含业务逻辑。
- **providers**：`LLMClient` 接口统一了不同模型的差异；`chat()` 是非流式单轮对话。
- **core / tools**：agent loop 与内置工具，V1 建立，见 `Plan_V0.md` §8 交接说明。

## 关键约定

- 全 ESM；`tsc` 只做类型检查（`noEmit`），产物统一由 tsup 打包。
- 运行时依赖不打包进产物，跟随 `npm install` 提供。
- 多提供商差异（Anthropic 的 system 顶层参数、OpenAI 的 tool_calls 等）一律在适配器内消化，上层只见统一接口。

## V1 扩展点

| 位置                        | 扩展内容                                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/providers/types.ts`    | `LLMClient.chat` 升级为流式 + 工具调用；`ProviderName` 扩展 openai / ollama / openai-compatible |
| `src/config/`（新建）       | `~/.config/run-agent/` 配置系统                                                                 |
| `src/core/query.ts`（新建） | agent loop                                                                                      |
| `src/tools/`（新建）        | 首批内置工具                                                                                    |

详见 [Plan_V0.md §8](Plan_V0.md)。
