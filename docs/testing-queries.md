# 多 Agent 编排 · 测试 Query 集

V7 多 Agent 编排(agent 工具 / 协调者三件套 / verification / 自定义类型)的**回归测试 prompt**。
用于人工验证真模型行为——尤其回归 0.7.2 修的「子 agent 空结论/半截结论」与「协调者闭嘴不汇总」。

## 通用通过标准

- 每个子 agent 返回 `[<类型> 结论]` + **实质内容**,不是「Let me…」「我会先…」半截话。
- 主 agent 收到后台结果后**真的汇总**,不再只说「等待返回」就闭嘴。
- 子 agent 全程不弹权限窗(权限继承 + 后台 ask 降级 deny)。

## 1. explore · 行号取证(练 grep 文件路径修复)

```
用 agent 工具委派 1 个 explore 子 agent:找出 src/core/query.ts 里定义 finalizing 标志的行号,以及 max_tokens 分支里调用 return 的那一行。要求对每个结论给出「文件:行号 + 该行原文」,必须用 grep 实际确认,不许凭记忆。
```

- **练什么**:explore 只读四件套(repo_map/glob/grep/read_file)、grep 单文件路径。
- **通过标准**:结论带真实行号 + 原文;不弹权限。

## 2. verification · 构建/测试验证(练 run_bash + VERDICT 契约)

```
委派 1 个 verification 子 agent 验证当前仓库的 CI 三件套:npm run typecheck、npm run lint、npm run build。每项给出 Command run: + 实际输出末尾几行,最后输出 VERDICT: PASS|FAIL|PARTIAL 及理由。
```

- **练什么**:verification 的 run_bash 对 safe 命令自动放行(构建/测试/lint 不弹窗)。
- **通过标准**:每条 check 带 `Command run:` + 实际输出;`VERDICT:` 字面量;「PASS 但无证据」会被解析器判拒。

## 3. verification · 断言真伪(否定式验证)

```
委派 1 个 verification 子 agent 验证断言:「src/core/query.ts 中,收尾轮 finalizing 为 true 时 tools 传空数组」。给出证据与 VERDICT。
```

- **练什么**:验证一个**具体事实**,逼它 grep/read 到确切代码再下结论(而非泛泛而谈)。
- **通过标准**:证据指向 `const toolSpecs = toToolSpecs(finalizing ? [] : getTools())` 或等价代码。

## 4. general-purpose · 用 explore 没有的工具

```
委派 1 个 general-purpose 子 agent 回答:src/ 目录下共有多少个 .ts 文件?用 bash(run_bash)统计数量,再列出最大的 3 个文件及字节数,最后给出结论。
```

- **练什么**:类型级工具池解析——explore 没有 run_bash,只有 general-purpose 能完成;bash 属 safe 命令应自动放行。
- **通过标准**:给出文件数 + 最大 3 个文件;证明用了 bash(而非 read 目录硬数)。

## 5. coordinator · 并行拆解 + 后台汇总(核心回归)

```
run-agent --coordinator "把 run-agent 的权限引擎拆成 2 个可并行的 explore 子任务:一个查判定顺序,一个查子 agent 权限继承。后台并行派发,收齐后汇总成一份『权限引擎速览』报告。"
```

- **练什么**:`--coordinator` 拆解 → 后台并行派发 → 轮末 `awaitAll` 汇总。
- **通过标准**:两个子 agent 都返回实质结论后,主 agent **产出汇总**——这是「协调者闭嘴」的回归点。
- **注意**:后台任务列表只在交互 REPL 装配;headless `--print` 单轮不装配。

## 6. send_message · 运行中反馈

```
run-agent --coordinator "委派 1 个后台 explore 子 agent 梳理 src/core/execute.ts 的 StreamingToolExecutor 调度逻辑,运行中通过 send_message 补充要求:『顺带说明未知工具路径如何回填』。等它完成后汇总。"
```

- **练什么**:send_message 迭代边界送达(不打断正在跑的工具循环),子 agent 据此补充答案。
- **通过标准**:子 agent 结论里包含「未知工具」回填的说明,且不是主 agent 自己说的。

## 7. task_stop · 止损

```
run-agent --coordinator "委派 1 个后台 explore 子 agent 全量读取 src/ 下所有文件(任务量很大、会拖很久),然后立即用 task_stop 停掉它,不要等它完成。停止后用 /tasks 确认状态为 stopped,并说明保留了哪些部分结果。"
```

- **练什么**:task_stop 中断 in-flight 请求、保留部分文本;`/tasks` 状态。
- **通过标准**:`/tasks` 显示 `stopped`;主 agent 说明保留了部分结果;不报错中断整个会话。
- **注意**:`/tasks` 只在交互 REPL 有。

## 8. 自定义类型 · 窄预算表现(可选)

先建 `.run-agent/agents/qa.md`(Trust 项目才加载):

```markdown
---
name: qa
description: 代码审查
maxIterations: 6
tools:
  - read_file
  - grep
system: 你是 QA 审查员,专注找 bug,逐条报 file:line 与证据。
---
专注找 bug,逐条报 file:line 与证据。
```

```
委派 1 个 qa 子 agent 审查 src/permissions/engine.ts 的判定顺序,列出潜在漏洞。注意它的 maxIterations 只有 6 轮——正好检验预算提示 + 收尾轮在窄预算下的表现。
```

- **练什么**:自定义 frontmatter 类型加载、`maxIterations: 6` 窄预算下模型是否主动收尾。
- **通过标准**:自定义类型被识别(结论带 `[qa 结论]`);6 轮内给出结论,不硬切半截话。

## 建议测试顺序

1. ① → ⑤ → ⑥/⑦:一次会话里把前台、后台、三件套都跑完。
2. ⑤ 能正常汇总、子 agent 结论不再半截 → 核心修复稳定。
3. ⑧ 最后跑(需先建自定义类型文件)。
