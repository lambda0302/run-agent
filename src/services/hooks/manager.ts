/**
 * V6 决策 A：HookManager——五类事件 + execCommand/execHttp 执行 + 输出解析。
 *
 * 事件语义：
 *   - PreToolUse：工具执行前（engine 判定后）；可返回 permissionDecision 覆盖判定，
 *     engine deny 是硬底线不可被放行（决策 A4，强制在 makeCheckPermission 层）。
 *   - PostToolUse：工具执行完成后（成功/失败都触发，结果含错误文本）。
 *   - SessionStart / SessionEnd：会话边界。
 *   - Stop：每轮 runQuery 结束，stdout 注入下一轮动态上下文块（决策 A1；V8.3 起在 messages）。
 *
 * 命令经 stdin 收 JSON 输入、stdout 回 JSON/文本；http 是 POST JSON body。
 * 所有 hook 有超时兜底（默认 30s），失败/超时绝不阻断主流程。
 */
import { spawn } from "node:child_process";
import { resolveShell } from "../../tools/bash/shell.js";
import type { HookExecution, HooksConfig } from "./config.js";

export const MAX_HOOK_OUTPUT = 64 * 1024;
export const DEFAULT_HOOK_TIMEOUT_MS = 30_000;
/** Stop 注入 system 的输出上限（防 hook 输出灌爆上下文）。 */
export const HOOK_INJECT_LIMIT = 2 * 1024;
/** PostToolUse 传给 hook 的 tool_result 截断（全量在会话 JSONL 里）。 */
export const HOOK_RESULT_TRIM = 2_000;

/** PreToolUse hook 的返回决策。 */
export interface PreToolUseDecision {
  permissionDecision?: "allow" | "deny";
  permissionDecisionReason?: string;
}

export interface HookManagerInput {
  cwd: string;
  sessionFile?: string;
}

export interface HookExecResult {
  output: string;
  exitCode: number;
  ok: boolean;
  timedOut?: boolean;
}

type Matcher = (name: string) => boolean;

/** 编译 matcher 正则；非法正则视为匹配全部（保守，不崩）。 */
function compileMatcher(pattern: string | undefined): Matcher | undefined {
  if (!pattern) return undefined;
  try {
    const re = new RegExp(pattern);
    return (name) => re.test(name);
  } catch {
    return undefined;
  }
}

/** 尝试解析 JSON 输出；非 JSON 原样返回。 */
function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * PowerShell 的 -Command 下，首个 token 是带引号字符串时按表达式解析，
 * `"a" "b"`（引号路径 + 引号脚本）直接报 ParserError:UnexpectedToken。
 * 前置 `&`（调用运算符）强制进入命令调用模式；bash 无需处理。
 */
function normalizeShellCommand(command: string, isPowerShell: boolean): string {
  const trimmed = command.trimStart();
  if (isPowerShell && /^["']/.test(trimmed)) return `& ${command}`;
  return command;
}

/** 执行单条 hook：spawn shell 跑命令，JSON 输入走 stdin，stdout 回填。 */
function execCommand(command: string, input: unknown, timeoutMs: number): Promise<HookExecResult> {
  return new Promise((resolve) => {
    const spec = resolveShell();
    const isPowerShell = process.platform === "win32" && /powershell/i.test(spec.command);
    let child;
    try {
      child = spawn(spec.command, [...spec.args, normalizeShellCommand(command, isPowerShell)], {
        windowsHide: true,
        env: { ...process.env, FORCE_COLOR: "0" },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      resolve({ output: "[hook 命令启动失败]", exitCode: 1, ok: false });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (result: HookExecResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      // 兜底强制杀：SIGTERM 后 2s 仍未退则 SIGKILL
      const kill = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* 已退出 */
        }
      }, 2000);
      kill.unref();
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < MAX_HOOK_OUTPUT) stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < MAX_HOOK_OUTPUT) stderr += d.toString();
    });
    child.on("error", () => finish({ output: "[hook 命令错误]", exitCode: 1, ok: false }));
    child.on("close", (code) => {
      clearTimeout(timer);
      const combined = (stdout || stderr).trim();
      if (timedOut) {
        finish({
          output: `${combined}${combined ? "\n" : ""}[hook 命令超时(${timeoutMs}ms)]`,
          exitCode: 124,
          ok: false,
          timedOut: true,
        });
        return;
      }
      finish({ output: combined, exitCode: code ?? -1, ok: code === 0 });
    });
    // 输入经 stdin 传入；stdin 已关/报错忽略（hook 不一定读）
    child.stdin?.on("error", () => undefined);
    try {
      child.stdin.write(JSON.stringify(input) + "\n");
      child.stdin.end();
    } catch {
      /* stdin 不可写 */
    }
  });
}

/** 执行单条 hook：POST JSON 到 url。 */
async function execHttp(
  url: string,
  input: unknown,
  headers: Record<string, string> | undefined,
  timeoutMs: number,
): Promise<HookExecResult> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(input),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    return { output: text.slice(0, MAX_HOOK_OUTPUT), exitCode: res.status, ok: res.status < 300 };
  } catch (e) {
    return {
      output: `[hook http 失败: ${e instanceof Error ? e.message : String(e)}]`,
      exitCode: 1,
      ok: false,
    };
  }
}

export class HookManager {
  private readonly config: HooksConfig;
  private readonly cwd: string;
  private readonly sessionFile: string | undefined;

  constructor(config: HooksConfig, input: HookManagerInput) {
    this.config = config;
    this.cwd = input.cwd;
    this.sessionFile = input.sessionFile;
  }

  /** 收集某事件匹配某工具的 hook 执行项（matcher 按规则索引编译缓存）。 */
  private executionsFor(event: string, toolName?: string): Array<{ exec: HookExecution }> {
    const rules = this.config[event as keyof HooksConfig] ?? [];
    const out: Array<{ exec: HookExecution }> = [];
    for (const rule of rules) {
      const matcher = compileMatcher(rule.matcher);
      if (toolName !== undefined && matcher && !matcher(toolName)) continue;
      for (const exec of rule.hooks) out.push({ exec });
    }
    return out;
  }

  private async runExec(exec: HookExecution, input: unknown): Promise<HookExecResult> {
    const timeout = exec.timeout ?? DEFAULT_HOOK_TIMEOUT_MS;
    if (exec.type === "http") return execHttp(exec.url ?? "", input, exec.headers, timeout);
    return execCommand(exec.command ?? "", input, timeout);
  }

  /**
   * PreToolUse：运行匹配工具名的 hook，返回第一个非空 permissionDecision。
   * 无决策 → undefined（不覆盖 engine 判定）。deny 的硬底线在 makeCheckPermission 层强制。
   */
  async onPreToolUse(name: string, input: unknown): Promise<PreToolUseDecision | undefined> {
    const execs = this.executionsFor("PreToolUse", name);
    for (const { exec } of execs) {
      const r = await this.runExec(exec, {
        tool_use: { name, input },
        cwd: this.cwd,
        sessionFile: this.sessionFile,
      });
      const parsed = tryParseJson(r.output);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const o = parsed as Record<string, unknown>;
        if (o.permissionDecision === "allow" || o.permissionDecision === "deny") {
          const reason =
            typeof o.permissionDecisionReason === "string" ? o.permissionDecisionReason : undefined;
          return reason
            ? { permissionDecision: o.permissionDecision, permissionDecisionReason: reason }
            : { permissionDecision: o.permissionDecision };
        }
      }
    }
    return undefined;
  }

  /** PostToolUse：工具执行后（成功/失败都触发），返回合并输出（供展示）。 */
  async onPostToolUse(name: string, input: unknown, result: string): Promise<string | undefined> {
    const outputs: string[] = [];
    for (const { exec } of this.executionsFor("PostToolUse", name)) {
      const r = await this.runExec(exec, {
        tool_use: { name, input },
        tool_result: result.slice(0, HOOK_RESULT_TRIM),
        cwd: this.cwd,
        sessionFile: this.sessionFile,
      });
      if (r.output.trim()) outputs.push(r.output.trim());
    }
    return outputs.length ? outputs.join("\n") : undefined;
  }

  async onSessionStart(): Promise<string | undefined> {
    return this.sessionEvent("SessionStart", "start");
  }

  async onSessionEnd(): Promise<string | undefined> {
    return this.sessionEvent("SessionEnd", "end");
  }

  private async sessionEvent(event: string, marker: string): Promise<string | undefined> {
    const outputs: string[] = [];
    for (const { exec } of this.executionsFor(event)) {
      const r = await this.runExec(exec, {
        session: marker,
        cwd: this.cwd,
        sessionFile: this.sessionFile,
      });
      if (r.output.trim()) outputs.push(r.output.trim());
    }
    return outputs.length ? outputs.join("\n") : undefined;
  }

  /**
   * Stop：每轮 runQuery 结束触发，带最终回复；返回值（合并输出）供注入下一轮动态上下文块。
   * 单条输出有上限，防 hook 输出灌爆上下文。
   */
  async onStop(reply: string): Promise<string | undefined> {
    const outputs: string[] = [];
    for (const { exec } of this.executionsFor("Stop")) {
      const r = await this.runExec(exec, { reply, cwd: this.cwd, sessionFile: this.sessionFile });
      const trimmed = r.output.trim();
      if (trimmed) outputs.push(trimmed.slice(0, HOOK_INJECT_LIMIT));
    }
    return outputs.length ? outputs.join("\n") : undefined;
  }
}
