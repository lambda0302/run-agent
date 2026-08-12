/**
 * V6 决策 C1/C3：自定义命令执行——prompt 模板展开 + local 脚本运行。
 *
 * prompt 形态：模板 + 参数（行尾追加）+ @file 内联（复用 read_file 约束）。
 * local 形态：解释器直跑脚本，参数走 argv、stdin 无；stdout 直接展示、不自动回喂模型
 * （V6 简化）。注入 RUN_AGENT_CWD / RUN_AGENT_PROMPT，让脚本感知会话。超时/截断复用
 * run_bash 的 120s / 30k 上限。不经工具权限管线（用户显式发起，同 /plan 语义）。
 */
import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { LocalCommand } from "./loader.js";

const LOCAL_TIMEOUT_MS = 120_000; // 复用 run_bash 默认超时
const LOCAL_MAX_OUTPUT = 30_000; // 复用 run_bash 输出截断
const LOCAL_MAX_BUFFER = 64 * 1024 * 1024; // execFile 内部 buffer 上限
const HAS_NATIVE_TS = Boolean((process.features as { typescript?: boolean }).typescript);

// @file 内联约束（与 read.ts 对齐）
const INLINE_MAX_BYTES = 4 * 1024 * 1024;
const INLINE_MAX_LINES = 2000;

function isBinary(buf: Buffer): boolean {
  return buf.includes(0);
}

/** 内联单个 @path 引用；缺文件/超限/二进制 → 返回占位说明，不中断模板展开。 */
function inlineFile(abs: string, shown: string): string {
  let st;
  try {
    st = statSync(abs);
  } catch {
    return `[无法内联 @${shown}: 文件不存在]`;
  }
  if (st.size > INLINE_MAX_BYTES) {
    return `[无法内联 @${shown}: 超过 ${INLINE_MAX_BYTES / 1024 / 1024}MB]`;
  }
  const buf = readFileSync(abs);
  if (isBinary(buf)) return `[无法内联 @${shown}: 二进制文件]`;
  let text = buf.toString("utf8").replace(/^﻿/, ""); // 剥 BOM
  const lines = text.split(/\r?\n/);
  if (lines.length > INLINE_MAX_LINES) {
    text = lines.slice(0, INLINE_MAX_LINES).join("\n") + `\n…（已截断，超 ${INLINE_MAX_LINES} 行）`;
  }
  return `--- ${abs} ---\n${text}`;
}

/**
 * 展开 prompt 模板：@file 引用内联 + 参数行尾追加。
 * 仅模板内展开 @file（参数里的 @ 视为字面量，契约如此）。
 */
export function expandPromptTemplate(
  template: string,
  args: string,
  cwd: string,
): { text: string } {
  const expanded = template.replace(/@(\S+)/g, (_m, p: string) =>
    inlineFile(path.resolve(cwd, p), p),
  );
  return { text: args ? `${expanded}\n${args}` : expanded };
}

export interface LocalExecResult {
  ok: boolean;
  output: string;
  /** 非 0 退出码；超时/无法启动时为 null。 */
  exitCode: number | null;
}

function truncate(text: string): string {
  return text.length > LOCAL_MAX_OUTPUT
    ? `${text.slice(0, LOCAL_MAX_OUTPUT)}…（输出超长，已截断）`
    : text;
}

/** 单次 execFile；ENOENT（解释器不存在）抛给上层做回退，其余归一为 LocalExecResult。 */
function runExec(
  command: string,
  prefix: string[],
  file: string,
  argv: string[],
  cwd: string,
  prompt: string,
  timeoutMs: number,
): Promise<LocalExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...prefix, file, ...argv],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: LOCAL_MAX_BUFFER,
        windowsHide: true,
        env: { ...process.env, RUN_AGENT_CWD: cwd, RUN_AGENT_PROMPT: prompt, FORCE_COLOR: "0" },
      },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        if (e?.code === "ENOENT") {
          reject(e);
          return;
        }
        const combined = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim();
        if (!err) {
          resolve({ ok: true, output: truncate(combined), exitCode: 0 });
          return;
        }
        if (e?.killed) {
          resolve({
            ok: false,
            output: truncate(`${combined}${combined ? "\n" : ""}[命令超时(${timeoutMs}ms)]`),
            exitCode: null,
          });
          return;
        }
        resolve({
          ok: false,
          output: truncate(combined || `命令退出码 ${e?.code ?? "error"}`),
          exitCode: typeof e?.code === "number" ? e.code : null,
        });
      },
    );
  });
}

/** python 解释器回退：POSIX python3→python，Windows python→py。 */
async function runPython(
  file: string,
  argv: string[],
  cwd: string,
  prompt: string,
  timeoutMs: number,
): Promise<LocalExecResult> {
  const candidates = process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
  for (const interp of candidates) {
    try {
      return await runExec(interp, [], file, argv, cwd, prompt, timeoutMs);
    } catch {
      // 仅 ENOENT（解释器不存在）进入此分支 → 换下一个候选
    }
  }
  return {
    ok: false,
    output: `找不到 python 解释器（试过 ${candidates.join(" / ")}）`,
    exitCode: null,
  };
}

export interface LocalExecOptions {
  /** 覆盖默认 120s 超时（测试用；缺省 = run_bash 级 120s）。 */
  timeoutMs?: number;
}

/** 执行 local 命令：参数 whitespace 切分走 argv；.ts 按 Node 能力决定是否 --experimental-strip-types。 */
export async function execLocalCommand(
  cmd: LocalCommand,
  args: string,
  cwd: string,
  prompt: string,
  opts: LocalExecOptions = {},
): Promise<LocalExecResult> {
  const timeoutMs = opts.timeoutMs ?? LOCAL_TIMEOUT_MS;
  const argv = args.trim() ? args.trim().split(/\s+/) : [];
  if (cmd.ext === "py") return runPython(cmd.file, argv, cwd, prompt, timeoutMs);
  if (cmd.ext === "ts") {
    // Node 22.6+ 原生 strip-types；Node 20 无此 flag（不能传，否则报未知选项），去掉后 .ts 能否跑取决于运行时
    const tsFlag = HAS_NATIVE_TS ? ["--experimental-strip-types"] : [];
    return runExec(process.execPath, tsFlag, cmd.file, argv, cwd, prompt, timeoutMs);
  }
  return runExec(process.execPath, [], cmd.file, argv, cwd, prompt, timeoutMs);
}
