# Hooks（0.6.0）

> V6「可编程化」三件套之一。Hooks 让你在 agent 的会话边界与工具调用链路上挂自动化：
> 命令或 HTTP 回调。配置用 run-agent **自有路径**（无 `.claude/`），与技能/自定义命令同语义。

## 五类事件

| 事件           | 时机                                   | 输入（JSON，stdin / POST body）                                | 输出用途                                     |
| -------------- | -------------------------------------- | -------------------------------------------------------------- | -------------------------------------------- |
| `PreToolUse`   | 工具**执行前**（engine 判定之后）      | `{ tool_use: { name, input }, cwd, sessionFile }`              | 可返回 `permissionDecision` 覆盖判定（见下） |
| `PostToolUse`  | 工具**执行完成后**（成功/失败都触发）  | `{ tool_use: { name, input }, tool_result, cwd, sessionFile }` | 合并输出展示（不阻断）                       |
| `SessionStart` | 会话开始时                             | `{ session: "start", cwd, sessionFile }`                       | 合并输出展示                                 |
| `SessionEnd`   | 会话结束时                             | `{ session: "end", cwd, sessionFile }`                         | 合并输出展示                                 |
| `Stop`         | **每轮** `runQuery` 结束（带最终回复） | `{ reply, cwd, sessionFile }`                                  | stdout 注入**下一轮** system（限 2KB）       |

- `tool_result` 传给 PostToolUse hook 时截断到 2000 字符（全量在会话 JSONL 里）。
- 所有 hook 有超时兜底（默认 30s），失败/超时**绝不阻断**主流程。

## 配置位置

- **用户级** `~/.config/run-agent/settings.json`——始终加载（用户自写）。
- **项目级** `<cwd>/.run-agent/settings.json`——**仅 Trust 会话加载**（hook 会执行任意命令，
  恶意项目的 hooks 绝不自动生效，防提示注入）。
- 同一事件：用户级规则在前、项目级规则在后**合并**（都是独立自动化，都应执行）。
- 目前 `settings.json` 只读取 `hooks` 键，其余键忽略（为后续扩展留位）。

## 配置格式

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^run_bash$",
        "hooks": [
          { "type": "command", "command": "node ~/hooks/audit-bash.js" },
          {
            "type": "http",
            "url": "https://example.com/audit",
            "headers": { "x-token": "…" },
            "timeout": 5000
          }
        ]
      }
    ],
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "echo session-started" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node ~/hooks/summarize.js" }] }]
  }
}
```

- **`matcher`**：匹配工具名的正则；缺省 = 匹配全部工具（`Session*` 事件无工具名，无 matcher 概念）。
  非法正则视为匹配全部（保守，不崩）。
- **`hooks[].type`**：`command`（经 shell 运行，输入走 stdin）或 `http`（POST JSON body，
  可带 `headers`）。
- **`hooks[].timeout`**：毫秒，缺省 30s。
- 每条规则的 `hooks` 数组至少一条。

## PreToolUse：permissionDecision 安全边界

PreToolUse hook 的 stdout 若为 JSON 且含 `permissionDecision`，会**覆盖 engine 的判定**：

```json
{ "permissionDecision": "allow", "permissionDecisionReason": "该命令在白名单内" }
```

```json
{ "permissionDecision": "deny", "permissionDecisionReason": "禁止访问 .run-agent" }
```

- **硬底线**：engine 判定的 **deny 不可被 hook 放行**。内置危险命令、`.git`/`.claude`/`.run-agent`
  路径段、用户 deny 规则等无条件拒绝，hook 返回 `allow` 也不放行。
- hook 返回 `deny` → 工具被拒，reason 展示给用户；无决策（非 JSON / 无该键）→ 不覆盖 engine 判定。

## Stop：跨轮注入

`Stop` hook 在**每轮** agent 循环结束时触发，带最终回复 `reply`。其 stdout（合并、每条限 2KB）
注入**下一轮**请求的 system 动态段——可用于状态保持、进度上报、记忆提醒。one-shot 无下一轮，
Stop 只触发、不注入。

## 与其它特性的关系

- Hooks 在 **REPL 与 headless（`--print`）都生效**，配置与路径相同。
- PreToolUse 在权限引擎判定**之后**跑，只影响判定结果、不绕过引擎。
- Hooks 配置读取为直接 fs 直读（`.run-agent` 是内置 deny 段），模型没有任何工具能偷看 hook 配置。
