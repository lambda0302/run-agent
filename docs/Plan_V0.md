# Run Agent · V0「项目地基」实施方案

> 上游总计划：`Plan.md`（第三节"开源项目的硬性基线" + V0 章节）
> 目标：**一个"别人也能跑起来"的公开仓库骨架，技术栈落定。**
> 工期参考：1 周 ｜ 本版本无 npm release（版本号保持 `0.0.0`，首个 release 是 V1 的 `0.1.0`）

---

## 0. 结论速览

**交付什么**：一个公开 GitHub 仓库 `run-agent`，满足——

1. clone 后 `npm ci && npm run lint && npm run typecheck && npm test && npm run build` 在 **Windows / macOS / Linux 三 OS** 全绿；
2. `npm install -g` 后 `run-agent --version` / `--help` 可用；
3. `run-agent "hello"` 能调用一次模型并打印回复（本地有 API key 时）。

**技术栈**：Node 20+ LTS ｜ TypeScript（strict）｜ Vitest ｜ tsup ｜ ESLint(flat) + Prettier ｜ Commander ｜ `@anthropic-ai/sdk`（作为参考适配器）。

**不做的事**（全部留给 V1+）：多提供商适配器、配置系统、agent loop、工具、会话持久化、权限、SECURITY.md。

---

## 1. 范围

### 1.1 本版本做

| 类别       | 内容                                                                                                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 仓库与工程 | GitHub 公开仓库、`.gitignore`、`.gitattributes`（LF 归一化）、`LICENSE`(MIT)、`README.md` 骨架、`CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`CHANGELOG.md`、issue/PR 模板 |
| 构建与质量 | `tsconfig.json`(strict)、`tsup.config.ts`（打包 CLI）、ESLint + Prettier、Vitest + 首批测试、GitHub Actions 三 OS CI                                                   |
| 最小代码   | `LLMClient` 接口 + **Anthropic 参考适配器** + Commander CLI 空壳（`--version` / `--help` / 单条 prompt）                                                               |
| 文档       | `docs/architecture.md`（目录结构+分层）、`docs/development.md`（本地开发）、`docs/usage.md`（最小用法）                                                                |

### 1.2 明确推迟（Don't）

| 推迟项                                             | 归属版本 |
| -------------------------------------------------- | -------- |
| OpenAI / OpenAI 兼容（DeepSeek 等）/ Ollama 适配器 | V1       |
| 配置系统（`~/.config/run-agent/`、`.env`）         | V1       |
| Agent loop、内置工具、会话持久化                   | V1       |
| 权限引擎、Trust 对话                               | V2       |
| `SECURITY.md`                                      | V2       |
| TUI（Ink）                                         | V8       |

> **为什么 V0 就写 Anthropic 适配器**：V0 的 CLI 空壳要求"调用一次模型"，需要一个能真正发请求的最小路径来冒烟整个技术栈；但多提供商与配置系统是 V1 的核心工作，V0 只做**接口 + 一个参考实现**，证明分层能跑通即可。

---

## 2. 前置条件

- [ ] Node.js **20+ LTS**（建议 20 或 22）与 npm 9+；验证：`node -v && npm -v`
- [ ] git 已安装并配置 `user.name` / `user.email`
- [ ] GitHub 账号；可选安装 [GitHub CLI `gh`](https://cli.github.com/) 并 `gh auth login`
- [ ] 一个 Anthropic API key（**仅本机端到端验证**用，CI 不需要）
- [ ] 检查包名占用：`npm view run-agent`（返回 404/报错 = 可用；若被占用需改 CLI 名或加 scope）

---

## 3. 交付物清单（目标文件树）

```
run-agent/
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.md
│   │   └── feature_request.md
│   ├── pull_request_template.md
│   └── workflows/
│       └── ci.yml
├── docs/
│   ├── architecture.md
│   ├── development.md
│   └── usage.md
├── src/
│   ├── cli/
│   │   └── index.ts            # Commander 入口：--version / --help / prompt
│   ├── providers/
│   │   ├── types.ts            # LLMClient 接口（V1 扩展点）
│   │   └── anthropic.ts        # Anthropic 参考适配器
│   └── utils/
│       └── errors.ts           # RunAgentError 基础错误类
├── tests/
│   ├── providers/
│   │   └── anthropic.test.ts   # mock SDK 的单测
│   └── cli.test.ts             # --version / --help 冒烟
├── .gitattributes
├── .gitignore
├── .prettierrc.json
├── CHANGELOG.md
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md
├── eslint.config.js
├── LICENSE
├── package.json
├── README.md
├── tsconfig.json
└── tsup.config.ts
```

> 注：`src/core/`（agent loop）、`src/tools/`（工具）留待 V1 建立。现在**不要建空目录**（git 不跟踪空目录），V1 用到的目录到 V1 再创建。

---

## 4. 分步实施

> 所有命令在项目根目录执行。建议按顺序做，每步完成后停一下看输出。

### Step 1 —— 初始化仓库

```bash
mkdir run-agent && cd run-agent
git init -b main
# 本地建好后再推 GitHub（见 Step 10）
```

### Step 2 —— `package.json` 与依赖

```bash
npm init -y
```

编辑 `package.json`，关键字段如下（**版本号以 `npm install` 时解析到的最新稳定版为准**，示例范围仅供参考）：

```json
{
  "name": "run-agent",
  "version": "0.0.0",
  "description": "A transparent, multi-provider coding agent for your terminal.",
  "type": "module",
  "bin": { "run-agent": "dist/cli.js" },
  "files": ["dist"],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "smoke": "npm run build && node dist/cli.js --version && node dist/cli.js --help"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.50.0",
    "commander": "^13.0.0"
  },
  "devDependencies": {
    "@types/node": "^20",
    "eslint": "^9",
    "prettier": "^3",
    "tsup": "^8",
    "typescript": "^5",
    "typescript-eslint": "^8",
    "vitest": "^3"
  }
}
```

**关键点**：

- `type: "module"` —— 全 ESM，输出兼容现代 Node。
- `bin` 指向**打包产物** `dist/cli.js`，不是源文件。
- `files: ["dist"]` —— npm 发布白名单，源码不进入 tarball。
- `engines.node >= 20` —— 声明最低运行时，npm 会提示不兼容用户。
- **不加 `exports` / `main` / `types`**：V0 只交付 CLI，不公开库 API（SDK 化留到后期）。

安装依赖：

```bash
npm install
npm install -D @types/node eslint prettier tsup typescript typescript-eslint vitest
```

### Step 3 —— TypeScript 与构建配置

`tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2023"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "tests", "tsup.config.ts", "eslint.config.js"]
}
```

> `noEmit: true` —— 产物一律交给 tsup 打包，tsc 只做类型检查（`typecheck` 脚本），避免两套产物互相干扰。

`tsup.config.ts`：

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  sourcemap: true,
  clean: true,
  // 运行时依赖不打包进产物，由 npm install 提供
  // （tsup 默认将 package.json 的 dependencies 视为 external）
  banner: { js: "#!/usr/bin/env node" },
});
```

**关键点**：

- `banner` 加 shebang → CLI 可被直接执行；Windows 上 npm 安装时会自动生成 `run-agent` cmd shim。
- `format: ["esm"]` + `target: "node20"` 对应 `engines.node >= 20`。

### Step 4 —— Lint 与格式

`.prettierrc.json`：

```json
{
  "printWidth": 100,
  "singleQuote": false,
  "semi": true
}
```

`eslint.config.js`（flat config，typescript-eslint 官方推荐写法）：

```js
import tseslint from "typescript-eslint";

export default tseslint.config({
  files: ["**/*.ts"],
  ignores: ["dist/**", "node_modules/**"],
  extends: [...tseslint.configs.recommended],
});
```

> 若本机 ESLint 版本与 typescript-eslint 组合报错，按官方文档 [typescript-eslint.org](https://typescript-eslint.io/getting-started/) 的 flat config 示例为准。

### Step 5 —— 源码骨架

`src/utils/errors.ts`：

```ts
/** 基础错误类：CLI 层捕获后统一转成退出码与 stderr 输出。 */
export class RunAgentError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "RunAgentError";
  }
}
```

`src/providers/types.ts`（**V1 扩展点**）：

```ts
/**
 * 统一的多提供商 LLM 客户端抽象。
 * V0 只有最简 chat；V1 将在此接口上扩展：流式、工具调用(tool_use)、
 * 内部统一消息格式（对齐 Anthropic 的 tool_use/tool_result 与 OpenAI 的 tool_calls）。
 */
export interface LLMMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface LLMClient {
  readonly provider: string;
  /** 非流式单轮对话，V1 升级为流式。 */
  chat(messages: LLMMessage[]): Promise<string>;
}

export interface CreateClientOptions {
  /** 显式传入；缺省时各适配器回退到对应环境变量（如 ANTHROPIC_API_KEY）。 */
  apiKey?: string;
  /** 模型名；缺省时各适配器用默认模型。 */
  model?: string;
}

export type ProviderName = "anthropic";
// V1 扩展：ProviderName = "anthropic" | "openai" | "ollama" | "openai-compatible";
```

`src/providers/anthropic.ts`：

```ts
import Anthropic from "@anthropic-ai/sdk";
import type { CreateClientOptions, LLMClient, LLMMessage } from "./types.js";

const DEFAULT_MODEL = "claude-sonnet-5"; // 按当时最新主力模型调整

export function createAnthropicClient(options: CreateClientOptions = {}): LLMClient {
  const client = new Anthropic({ apiKey: options.apiKey ?? process.env.ANTHROPIC_API_KEY });
  const model = options.model ?? DEFAULT_MODEL;

  return {
    provider: "anthropic",
    async chat(messages) {
      const res = await client.messages.create({
        model,
        max_tokens: 1024,
        messages: messages
          .filter((m) => m.role !== "system")
          .map((m) => ({ role: m.role, content: m.content })),
        system: messages.find((m) => m.role === "system")?.content,
      });

      return res.content
        .filter((b) => b.type === "text")
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("");
    },
  };
}
```

**关键点**：Anthropic 的 system 提示走顶层 `system` 参数而非消息数组——这是与 OpenAI 适配器最大的格式差异之一，统一层在 V1 处理。

`src/cli/index.ts`：

```ts
import { Command } from "commander";
import pkg from "../../package.json" with { type: "json" };
import { RunAgentError } from "../utils/errors.js";
import { createAnthropicClient } from "../providers/anthropic.js";

const program = new Command();

program
  .name("run-agent")
  .description("Run Agent — a transparent, multi-provider coding agent for your terminal.")
  .version(pkg.version, "-v, --version")
  .argument("[prompt]", "the prompt to run")
  .option("-m, --model <model>", "model to use")
  .action(async (prompt: string | undefined) => {
    if (!prompt) {
      program.help();
      return;
    }
    const client = createAnthropicClient();
    const reply = await client.chat([{ role: "user", content: prompt }]);
    process.stdout.write(reply + "\n");
  });

program.parse();
```

> 兜底：`action` 内 `await` 抛错时，Node 会以非零码退出并打印堆栈。V0 可接受；V1 引入 `process.on("unhandledRejection")` + `RunAgentError` 统一错误出口。`import pkg from "...json" with { type: "json" }` 需要 Node ≥ 20.10。

### Step 6 —— 测试（Vitest，无需配置文件，自动发现 `**/*.test.ts`）

`tests/providers/anthropic.test.ts`（mock SDK，**不依赖真实 API key**）：

```ts
import { describe, expect, it, vi } from "vitest";

const createMock = vi.fn(() => ({
  messages: {
    create: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "pong" }],
    }),
  },
}));

vi.mock("@anthropic-ai/sdk", () => ({ default: createMock }));

import { createAnthropicClient } from "../../src/providers/anthropic.js";

describe("createAnthropicClient", () => {
  it("调 SDK 并返回文本", async () => {
    const client = createAnthropicClient({ apiKey: "test-key" });
    const reply = await client.chat([{ role: "user", content: "ping" }]);
    expect(reply).toBe("pong");
    expect(createMock().messages.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: expect.any(String) }),
    );
  });

  it("把 system 消息映射到顶层 system 参数", async () => {
    const client = createAnthropicClient({ apiKey: "test-key" });
    await client.chat([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ]);
    const args = createMock().messages.create.mock.calls[0][0];
    expect(args.system).toBe("be brief");
    expect(args.messages).toEqual([{ role: "user", content: "hi" }]);
  });
});
```

`tests/cli.test.ts`（对**打包产物**做冒烟，验证可执行性与帮助信息）：

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const run = promisify(execFile);
const distCli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

describe("CLI 冒烟（先 npm run build）", () => {
  it("--version 输出 0.0.0 且退出 0", async () => {
    const { stdout } = await run(process.execPath, [distCli, "--version"]);
    expect(stdout.trim()).toBe("0.0.0");
  });

  it("--help 退出 0 且包含说明", async () => {
    const { stdout } = await run(process.execPath, [distCli, "--help"]);
    expect(stdout).toContain("run-agent");
    expect(stdout).toContain("prompt");
  });
});
```

> `cli.test.ts` 依赖 dist 产物 → **test 前必须先 build**。把构建放进测试脚本：
> 修改 `package.json` 的 `"test": "npm run build && vitest run"`（CI 与本地一致）。

### Step 7 —— CI（GitHub Actions，三 OS）

`.github/workflows/ci.yml`：

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
        node: [20, 22]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - run: npm run test
      - run: npm run build
      - run: node dist/cli.js --version
      - run: node dist/cli.js --help
```

**关键点**：

- `os × node = 6` 个 job，`fail-fast: false`（一个 OS 失败不取消其它，便于排错）。
- **CI 不做真实模型调用**（无 key）；模型调用在本地 Step 9 手动验证，逻辑由 mock 单测覆盖。
- `npm ci` 要求有 `package-lock.json`（`npm install` 会自动生成，提交进仓库）。

### Step 8 —— 社区与文档文件

- **`LICENSE`**：MIT。填写占位版权行：`Copyright (c) 2026 <你的 GitHub 用户名或真名>`。
- **`.gitignore`**：`node_modules/`、`dist/`、`*.tgz`、`.env`、`.DS_Store`、`coverage/`。
- **`.gitattributes`**：
  ```
  * text=auto
  *.ts text eol=lf
  *.js text eol=lf
  *.json text eol=lf
  *.yml text eol=lf
  *.md text eol=lf
  ```
  → 强制 LF，**避免 Windows CRLF 在 CI 里搞乱 lint/diff**。
- **`README.md`** 骨架（正式内容 V1 补全）：
  - 一行标语 + 一句话定位
  - 状态徽章（CI 状态：`![CI](https://github.com/<user>/run-agent/actions/workflows/ci.yml/badge.svg)`）
  - "快速开始"占位（`npm install -g run-agent` + 示例）
  - 特性清单（占位，V1 填）
  - 文档链接（docs/）、贡献入口（CONTRIBUTING.md）、许可证
- **`CONTRIBUTING.md`**：开发环境、命令（dev/build/test/lint）、PR 流程（fork + branch + PR + CI 必须绿）、提交信息约定。
- **`CODE_OF_CONDUCT.md`**：Contributor Covenant 2.1 模板。
- **`CHANGELOG.md`**：
  ```markdown
  # Changelog

  本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

  ## [Unreleased]

  - 初始化项目骨架：TypeScript + Node 20、tsup 打包、Vitest、ESLint/Prettier、三 OS CI。
  - CLI 空壳：`--version` / `--help` / 单条 prompt 调用 Anthropic。
  ```
- **issue 模板**：`bug_report.md`（环境：OS/Node/版本/复现步骤/预期/实际/日志）、`feature_request.md`（动机/方案/备选）。
- **`pull_request_template.md`**：改动摘要 / 测试情况 / 是否更新文档与 CHANGELOG / 关联 issue。
- **docs/**：
  - `architecture.md`：目录树 + 分层说明（cli → providers → core[V1] → tools[V1]）。
  - `development.md`：前置条件、`npm ci`、dev 循环、测试、lint、打包、冒烟。
  - `usage.md`：安装、`run-agent "hello"`、`--model`、环境变量 `ANTHROPIC_API_KEY`（V1 再扩多提供商）。

### Step 9 —— 端到端验证

本机（三 OS 中至少验证当前 OS，CI 兜底其余）：

```bash
npm ci
npm run lint && npm run typecheck && npm run test && npm run build
node dist/cli.js --version      # → 0.0.0
node dist/cli.js --help         # → 用法说明

# 全局安装验证（发布前的安装路径）
npm install -g .
run-agent --help

# 真实模型调用（需 ANTHROPIC_API_KEY）
export ANTHROPIC_API_KEY=sk-ant-...
run-agent "你好，请用一句话自我介绍"
```

### Step 10 —— 提交与 PR

```bash
# 提交信息约定：Conventional Commits
git add -A
git commit -m "chore: bootstrap run-agent project skeleton (V0)"
git push -u origin main

# 创建公开仓库（gh CLI 方式；或网页创建后 add remote）
gh repo create run-agent --public --source . --push
```

之后在 GitHub 上确认：Actions 三 OS 6 个 job 全绿。首次通过后可以开启分支保护（main 需 PR + CI 通过），养成协作习惯。

---

## 5. 关键技术决策与理由

| 决策     | 选择                                  | 理由                                                               |
| -------- | ------------------------------------- | ------------------------------------------------------------------ |
| 模块体系 | 全 ESM（`type: module`）              | Node 20+ 原生 ESM 成熟；CLI 打包产物单文件 ESM 最干净              |
| 构建     | tsup（esbuild）而非纯 `tsc`           | 一条命令打包 + shebang + sourcemap；`tsc` 只做类型检查，职责单一   |
| 打包     | `dependencies` 外部化，只打包自有代码 | 产物小、依赖跟随 npm install 升级，避免把 SDK 打进 tarball         |
| CLI 解析 | Commander                             | 生态最成熟；`--version`/`--help` 零成本；V1 扩展子命令方便         |
| LLM 抽象 | 接口 + 适配器（V0 只有 Anthropic）    | 接口 `LLMMessage`/`LLMClient` 是 V1 多提供商的骨架，先证明分层可跑 |
| 测试     | mock SDK 单测 + dist 冒烟             | 无 key 也能测逻辑；真实调用留给本地手动验证，CI 稳定不花钱         |
| CI       | 3 OS × 2 Node = 6 job                 | 公开项目跨平台是硬承诺，`fail-fast: false` 便于定位平台差异        |
| bin/包名 | 统一 `run-agent`                      | npm 上 `run` 已占用；CLI 命令与包名一致，降低用户认知成本          |
| 版本     | V0 保持 `0.0.0`                       | V0 不可安装发布，首个 release 是 V1 `0.1.0`                        |

---

## 6. 验收清单（Definition of Done）

- [ ] 仓库为公开 GitHub 仓库，含 `LICENSE`、`README`、`CONTRIBUTING`、`CODE_OF_CONDUCT`、`CHANGELOG`、issue/PR 模板
- [ ] `npm ci && npm run lint && npm run typecheck && npm test && npm run build` 本机通过
- [ ] GitHub Actions：ubuntu / windows / macos × node 20 / 22 共 6 个 job **全绿**
- [ ] `npm install -g .` 后 `run-agent --help` 可用（Windows 上出现 cmd shim）
- [ ] `run-agent "hello"`（有 key）返回一次真实模型回复
- [ ] `npm pack` 生成的 tarball 只含 `dist/`，无源码、无 node_modules
- [ ] `package-lock.json` 已提交，CI 用 `npm ci` 可复现
- [ ] `docs/` 三个文档骨架齐全，`architecture.md` 标出 V1 扩展点

---

## 7. 风险与注意

1. **包名占用**：`run-agent` 若已被占用，备选方案——加 scope（`@<user>/run-agent`，代价是安装命令变长）或改名。**Step 2 之前必须 `npm view` 确认**。
2. **Windows CRLF**：不加 `.gitattributes` 时 lint/类型检查在 Windows 上可能因换行差异炸掉——Step 8 的 `.gitattributes` 不要跳过。
3. **`import pkg with { type: "json" }`**：需要 Node ≥ 20.10；若你的 Node 较旧，退化为 `program.version("0.0.0")` 硬编码。
4. **`cli.test.ts` 依赖 dist**：忘记在 test 前 build 会红。已通过把 build 并入 `test` 脚本规避，但**两个测试文件作用域不同**（单测 vs 冒烟）要写清注释，避免新人困惑。
5. **`npm install -g .` 在 CI 里慎用**：会污染 runner；本计划只在本地 Step 9 手动做，CI 用 `node dist/cli.js` 代替。
6. **tsup 的 external 行为**：若新装依赖后产物异常变大，显式加 `external: ["@anthropic-ai/sdk", "commander"]` 强制外部化。
7. **ESLint flat config 版本组合**：ESLint 9 + typescript-eslint 需按官方 flat config 写法；出问题先看 typescript-eslint 文档，别回退旧版 `.eslintrc`。

---

## 8. V0 → V1 交接

**V0 结束时的代码状态**：

```
src/providers/types.ts   ← LLMMessage / LLMClient 接口（V0 最简版）
src/providers/anthropic.ts ← 参考适配器（非流式 chat）
src/cli/index.ts         ← Commander 空壳
dist/cli.js              ← 可安装的 CLI 产物
```

**为 V1 预留的扩展点**（V1 会动到的地方，先想清楚别把接口焊死）：

| V1 工作                              | V0 已预留                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| 多提供商（openai/ollama/compatible） | `ProviderName` 类型注释里已列；`CreateClientOptions` 已带 `model`/`apiKey`                 |
| 流式 + tool_use                      | `LLMClient.chat` 单方法签名将在 V1 重构为流式+工具；**接口先在 types.ts 集中，改一处即可** |
| 配置系统                             | V0 用环境变量 `ANTHROPIC_API_KEY`；V1 加 `~/.config/run-agent/` 时保持"环境变量兜底"顺序   |
| Agent loop / 工具                    | V1 新建 `src/core/` 与 `src/tools/`（V0 刻意不建空目录）                                   |
| 统一错误出口                         | `RunAgentError` 已建，V1 在 CLI 层挂 `unhandledRejection` 处理器                           |

**V1 首个增量会动的文件**（给 V1 一个起点）：
`src/providers/types.ts`（接口扩展）→ 新增 `src/providers/openai.ts`、`src/providers/ollama.ts` → 新建 `src/config/` → 新建 `src/core/query.ts`（agent loop）→ `src/tools/` 首批工具。
