# Run Agent

[![CI](https://github.com/lambda0302/run-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/lambda0302/run-agent/actions/workflows/ci.yml)

一个透明、多提供商的**终端编码 agent**：用自然语言让它读代码、改文件、跑命令、跑测试，并把每一步做了什么展示给你看。

> 当前版本：**0.5.0**（Plan 模式 + MCP 客户端 + 流式并发强化）。路线图见 [Plan.md](docs/Plan.md)。

## 前置条件

- **Node.js ≥ 20**（建议 LTS 20 / 22 / 24；npm 随 Node 一起安装）

## 安装与部署（按平台）

### Windows

**1. 安装 Node.js**

```powershell
# 方式 A：winget（Windows 10/11 自带）
winget install OpenJS.NodeJS.LTS

# 方式 B：官网安装包
# 打开 https://nodejs.org 下载 LTS 版 .msi，双击按向导安装
```

验证：

```powershell
node --version    # v20 或更高
npm --version
```

**2. 全局安装 run-agent**

```powershell
npm install -g @liyiyong/run-agent
run-agent --version    # 应输出 0.5.0
```

**3. 设置 API key**（以 Anthropic 为例；完整方式见「[设置 API key](#设置-api-key)」）

当前窗口临时生效：

```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-..."
run-agent "你好"
```

永久生效（新开的窗口才生效）：

```powershell
setx ANTHROPIC_API_KEY "sk-ant-..."
# 或
[Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", "sk-ant-...", "User")
```

> `setx` 一次最多存 1024 字符，且不影响已打开的窗口——设完记得开**新终端**。
> 也可以走 GUI：`设置 → 系统 → 关于 → 高级系统设置 → 环境变量 → 新建`。

cmd.exe（仅当前窗口）：

```bat
set ANTHROPIC_API_KEY=sk-ant-...
```

> 跨平台最简单的做法是在项目根放 `.env`（见「[设置 API key](#设置-api-key)」）。
> `run-agent` 在 Windows 上执行 shell 命令走的是内置 PowerShell，无需额外安装。

**4. 使用**

```powershell
run-agent "把 README 里的大标题改成 'Run Agent'"   # 单条 prompt：agent 自动读文件 → 改文件 → 跑测试 → 汇报
run-agent                                            # 不带参数进入交互式 REPL
```

### macOS

**1. 安装 Node.js**

```bash
# 方式 A：Homebrew
brew install node

# 方式 B：官网 .pkg
# 打开 https://nodejs.org 下载 LTS 版 .pkg，双击安装
```

**2. 全局安装 run-agent**

```bash
npm install -g @liyiyong/run-agent
run-agent --version
```

**3. 设置 API key**（以 Anthropic 为例）

当前窗口临时生效：

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
run-agent "你好"
```

永久生效（macOS 默认 shell 是 zsh，写进 `~/.zshrc`）：

```bash
echo 'export ANTHROPIC_API_KEY="sk-ant-..."' >> ~/.zshrc
source ~/.zshrc
```

用 bash 的话写 `~/.bash_profile`，同理。

**4. 使用**：同上「Windows」第 4 步的命令。

### Linux

**1. 安装 Node.js**

```bash
# 方式 A（推荐）：nvm，免 sudo、可切换版本
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# 重开终端后：
nvm install 22
nvm use 22

# 方式 B：发行版包管理器
sudo apt install nodejs npm      # Debian / Ubuntu
sudo dnf install nodejs          # Fedora / RHEL
sudo pacman -S nodejs npm        # Arch

# 方式 C：官网二进制包
# https://nodejs.org → LTS → Linux x64，解压后把 bin 目录加进 PATH
```

**2. 全局安装 run-agent**

```bash
npm install -g @liyiyong/run-agent
run-agent --version
```

**3. 设置 API key**（以 Anthropic 为例）

```bash
# 当前窗口临时生效
export ANTHROPIC_API_KEY="sk-ant-..."
run-agent "你好"

# 永久生效（bash 写 ~/.bashrc，zsh 写 ~/.zshrc）
echo 'export ANTHROPIC_API_KEY="sk-ant-..."' >> ~/.bashrc
source ~/.bashrc
```

**4. 使用**：同上「Windows」第 4 步的命令。

## 设置 API key

`run-agent` 优先读环境变量里的 key。配置总优先级：**CLI flag > 环境变量（`RUN_AGENT_*`）> 配置文件 > 默认值**。

key 本身的解析顺序：**`--api-key` > `apiKeyEnv` 指向的环境变量 > provider 默认约定**。

各 provider 的默认 key 环境变量：

| Provider            | 默认 key 环境变量   | 说明                                           |
| ------------------- | ------------------- | ---------------------------------------------- |
| `anthropic`         | `ANTHROPIC_API_KEY` | 默认 provider                                  |
| `openai`            | `OPENAI_API_KEY`    |                                                |
| `openai-compatible` | —（无默认）         | 必须自己指定 key 来源（见下）                  |
| `ollama`            | —（无需 key）       | 本地模型，默认端点 `http://localhost:11434/v1` |

**五种设置方式**（从最省心到兜底）：

1. **`.env` 文件（推荐，跨平台一致）**：在运行 `run-agent` 的项目根目录建 `.env`，启动时自动加载
   （已存在的环境变量优先，不会被覆盖）：

   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```

   记得把 `.env` 加进 `.gitignore`，不要提交到仓库。

2. **平台环境变量（临时）**：Windows `$env:ANTHROPIC_API_KEY="..."`、macOS/Linux `export ANTHROPIC_API_KEY="..."`
   （各平台小节有完整命令）。

3. **平台环境变量（永久）**：`setx` / `~/.zshrc` / `~/.bashrc`（见各平台小节）。

4. **配置文件 `apiKeyEnv`（只存变量名，不存 key 值）**：

   ```json
   {
     "provider": "openai-compatible",
     "baseURL": "https://api.deepseek.com/v1",
     "model": "deepseek-chat",
     "apiKeyEnv": "DEEPSEEK_API_KEY"
   }
   ```

   然后 `export DEEPSEEK_API_KEY=sk-...`。key 不落盘，配置文件里只有名字。

5. **`--api-key` 或配置 `apiKey`（临时用）**：直接把 key 传给命令：

   ```bash
   run-agent --api-key sk-ant-... "你好"
   ```

**OpenAI 兼容提供商注意**：`openai-compatible`（DeepSeek / Qwen / vLLM / 本地推理）**没有默认 key 变量**，
光 `export DEEPSEEK_API_KEY=...` 不会被读到，必须用下面任一方式指明来源：

```bash
# 方式 A：--api-key 直接传
run-agent --provider openai-compatible --base-url https://api.deepseek.com/v1 \
  --model deepseek-chat --api-key sk-... "你好"

# 方式 B：配置文件 apiKeyEnv 指向变量（推荐，见上「方式 4」）
#   config.json: { "provider": "openai-compatible", "baseURL": "...", "apiKeyEnv": "DEEPSEEK_API_KEY" }
export DEEPSEEK_API_KEY=sk-...
run-agent "你好"

# 方式 C：RUN_AGENT_API_KEY_ENV 指定变量名
export DEEPSEEK_API_KEY=sk-...
export RUN_AGENT_API_KEY_ENV=DEEPSEEK_API_KEY
run-agent --provider openai-compatible --base-url https://api.deepseek.com/v1 --model deepseek-chat "你好"
```

> **安全**：API key 等同于你的账户凭证——不要提交进 git，不要贴到公开渠道；一旦怀疑泄漏，
> 立刻到对应平台撤销并重新生成。推荐始终用「环境变量 / `apiKeyEnv`」而不是把 key 写进 `config.json`。

## 多提供商

`run-agent` 用一个内部统一的消息格式对接多家模型，配置优先级：**CLI flag > 环境变量 > 配置文件 > 默认值**。
各家 API key 怎么设，见「[设置 API key](#设置-api-key)」。

| Provider            | 覆盖模型                          | 设置方式                                                                   |
| ------------------- | --------------------------------- | -------------------------------------------------------------------------- |
| `anthropic`（默认） | Claude                            | `ANTHROPIC_API_KEY`                                                        |
| `openai`            | GPT                               | `OPENAI_API_KEY`                                                           |
| `openai-compatible` | DeepSeek / Qwen / vLLM / 本地推理 | `--base-url` + 指定 key 来源（`--api-key` / `apiKeyEnv`，无默认 key 变量） |
| `ollama`            | 本地 Ollama                       | 无需 key，默认 `http://localhost:11434/v1`                                 |

### 示例

**Anthropic（默认）**

```bash
run-agent --provider anthropic --model claude-sonnet-5 "修复这个仓库的测试"
```

**DeepSeek（OpenAI 兼容）**——记得同时指明 key 来源（无默认 key 变量）：

```bash
# 方式 A：--api-key 直接传
run-agent --provider openai-compatible --base-url https://api.deepseek.com/v1 \
  --model deepseek-chat --api-key sk-... "给函数加注释"

# 方式 B：配置文件里 apiKeyEnv 指向变量（推荐，见「设置 API key」）
export DEEPSEEK_API_KEY=sk-...
run-agent "给函数加注释"
```

**本地 Ollama**

```bash
ollama pull qwen2.5
run-agent --provider ollama --model qwen2.5 "介绍一下这个项目"
```

### 配置文件

也可以把偏好写进 `~/.config/run-agent/config.json`：

```json
{
  "provider": "openai-compatible",
  "model": "deepseek-chat",
  "baseURL": "https://api.deepseek.com/v1",
  "apiKeyEnv": "DEEPSEEK_API_KEY"
}
```

支持 `.env`：在项目根放 `.env`，`run-agent` 会自动加载。

### 续接会话

```bash
run-agent --resume          # 续接最近一次会话（进入 REPL）
run-agent --resume "继续"   # 在最近会话上下文上执行
```

会话以 JSONL 逐行追加在 `~/.local/share/run-agent/sessions/`。

### 接入 MCP server（0.5.0）

写 `~/.config/run-agent/mcp.json`（项目级 `.run-agent/mcp.json` 仅受信任项目加载）：

```json
{
  "servers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
    },
    "github": { "type": "http", "url": "https://api.githubcopilot.com/mcp/" }
  }
}
```

进 REPL 后按需连接：`/mcp connect filesystem`，之后模型即可调 `mcp__filesystem__read_file` 等工具
（MCP 工具与内置工具走同一权限管线）。默认不预连，省资源与 token。详见 [docs/mcp.md](docs/mcp.md)。

## 特性

- **ReAct agent loop**：流式输出 + 工具调用循环，停止条件 / 截断恢复 / **transient 错误指数退避重试**
- **CLAUDE.md 四级记忆**（V3）：managed / user / project / local 自动注入 system，project/local 级受 Trust 门控，`--bare` 全禁
- **上下文自动压缩**（V3）：token 估算 + 超阈值整段摘要 → 边界消息（已读文件重挂），`/compact` 手动触发，`--resume` 从摘要续起
- **反应式压缩 + 硬截断兜底**（0.3.1）：模型报上下文超长时强制压缩重试；压缩后仍超长则丢最老消息直到 fit，并修复孤儿 tool 消息
- **写入记忆**（0.3.2）：`remember` 工具把「用户明确要求记住 / 跨会话值得保留」的结论写进用户级 `~/.config/run-agent/CLAUDE.md`，自动去重，走权限引擎
- **主动记忆**（0.4.0，V4）：项目级 `.run-agent/memory/`，每条记忆独立文件（frontmatter `type` + 正文），`MEMORY.md` 索引常驻 system；`remember` 默认写项目级（按 `name` 去重更新），`scope="user"` 仅用户明确要求时写；Trust 会话内只读豁免记忆目录
- **记忆维护**（0.4.0）：`run-agent memory list/show/rm/prune` 子命令管理项目记忆；`glob`/`grep` 遍历默认忽略 `.run-agent`
- **代码理解**（0.4.1）：`repo_map` 两遍排序定位符号/文件（git 索引 + 路径打分 + 符号扫描，非 git 仓库降级 readdir）· `explore` 只读探索子 agent（4/8/12 轮，上下文独立）· `verify` 对改动文件跑 tsc/eslint/test 把错误读回自修（命令白名单 + 120s 超时 + 30k 截断）
- **超大工具结果指针化**（V3）：超阈值结果落盘、消息里只留指针，模型需要时自己 `read_file`
- **权限审批引擎**（V2 / 0.4.2）：`default` / `acceptEdits` 两档模式（bypass 已删除）+ **Plan 模式**（0.5.0，强制只读），危险目录黑名单 + 工作目录白名单 + 记忆读专属通道三层模型，内置危险命令与敏感路径底线，支持全局 + 项目级规则
- **Plan 模式**（0.5.0）：复杂任务先只读探索、再出计划、经你批准才动手——`enter_plan_mode` 进入强制只读（写/执行/非只读 MCP 工具一律 deny），`exit_plan_mode` 呈现计划并弹窗审批（计划落盘 `.run-agent/plans/`），批准后自动恢复执行权限；也可直接 `/plan` 手动进入
- **MCP 接入**（0.5.0）：接入标准协议生态（stdio / HTTP / SSE），配置 `mcp.json` 后按需 `mcp_connect <server>` 连接，MCP 工具（`mcp__server__tool`）与内置工具走同一权限管线；详见 [docs/mcp.md](docs/mcp.md)
- **Trust 信任边界**（V2）：只有受信任的项目才加载 `.run-agent/permissions.json` / `.run-agent/mcp.json`，防提示注入
- **流式即时执行**（0.5.0）：工具边流式边并行执行（不必等响应完结），只读并行（上限 10）/ 写串行、结果按原顺序回填
- **12 个内置工具**：`read_file` · `write_file` · `edit_file`（精确替换）· `glob` · `grep` · `run_bash`（跨平台，超时+输出截断）· `remember`（写入长期记忆）· `repo_map`（两遍排序定位）· `explore`（只读探索子 agent）· `verify`（跑 tsc/eslint/test 自修）· `enter_plan_mode` / `exit_plan_mode`（Plan 导航）+ 配置 MCP 时的 `mcp_connect` 与动态 MCP 工具
- **多提供商**：一套抽象对接 Anthropic / OpenAI / OpenAI 兼容 / Ollama
- **透明**：REPL 里实时看到模型文本增量与每次工具调用及结果
- **会话持久化**：JSONL 追加、`--resume` 原样回放（支持压缩边界续接）

V5 暂不包含（路线图 V5+）：MCP resources/prompts 全链路、Hooks / Skills、多 agent（任务级/后台并发）、TUI、session 切换。

## 安全模型

`run-agent` 默认拦得多、放行得少：所有 shell 命令执行都需确认，写/改工具在 `default` 模式需确认，
路径以工作目录为白名单边界（cwd 外**只读也问**），且存在不可被规则解除的安全底线（`rm -rf /`、
`git push --force`、`.git`/`.claude`/`.run-agent` 路径段等）。**0.4.2 起无 bypass 模式**：
`--dangerously-skip-permissions` 与 `--mode bypass` 已移除，旧配置里的 `"bypass"` 回退 `default` 并警告。
交互 REPL 内按 `y/n/a` 授权（`a` 记入永久规则）；**one-shot 不弹确认，一律拒绝**。

```bash
run-agent -t "帮我看一下这段代码"                     # -t 信任当前项目
run-agent --mode acceptEdits "重构 src/utils.ts"      # 写/改免确认（仅 cwd 内），命令仍询问
run-agent trust --list                                # 查看受信任项目
```

详见 [docs/permissions.md](docs/permissions.md) 与 [SECURITY.md](SECURITY.md)。

## 文档

- [架构](docs/architecture.md)
- [权限与 Trust](docs/permissions.md)
- [Plan 模式](docs/plan-mode.md)
- [MCP 接入](docs/mcp.md)
- [记忆与上下文管理](docs/context-management.md)
- [本地开发](docs/development.md)
- [用法](docs/usage.md)
- [路线图](docs/Plan.md) · [V0 交付](docs/Plan_V0.md) · [V1 实施方案](docs/Plan_V1.md) · [V2 实施方案](docs/Plan_V2.md) · [V3 实施方案](docs/Plan_V3.md) · [V4 实施方案](docs/Plan_V4.md)
- [记忆内容规范](docs/memory.md)
- [安全说明](SECURITY.md)

## 贡献

欢迎参与，见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)
