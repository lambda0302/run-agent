/**
 * verify 工具（0.4.1 决策 F / 8.3）：对改动文件跑项目脚本（tsc/eslint/test），把错误读回给模型自修。
 * toolchain 识别优先级：eslint 配置 > tsconfig.json（npx tsc --noEmit）> package.json scripts.test。
 * 命令模板白名单：只允许 tsc/eslint/test 派生命令（不走任意用户命令）；120s 超时 + 30k 截断（与 run_bash 同一约束）。
 */
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { classifyBashCommand } from "../permissions/engine.js";
import type { Tool, ToolCallResult } from "../tools.js";
import { resolveShell } from "./bash/shell.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 30_000;
const MAX_BUFFER = 64 * 1024 * 1024;

/** 识别到的 eslint 配置文件名（flat 或 legacy）。 */
const ESLINT_CONFIGS = [
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  ".eslintrc.yml",
  ".eslintrc.yaml",
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
];

const schema = z.object({
  file: z.string().min(1).describe("The changed file to check"),
  command: z
    .string()
    .optional()
    .describe("Override command template (default per detected toolchain). Use {file} for the target path"),
});

/** 允许的检查工具词：命令必须引用其一，否则拒绝。 */
const ALLOWED_TOOL_WORD = /\b(tsc|eslint|vitest|jest|mocha|ava|test)\b/i;

/**
 * 命令模板白名单：引用已知检查工具，且不触发危险/风险分级（rm、sudo、curl|sh、git push --force 等）。
 * 拒绝任意用户命令——verify 只能跑 tsc/eslint/test 派生命令。
 */
export function isAllowedCommand(cmd: string): boolean {
  if (!cmd.trim()) return false;
  if (classifyBashCommand(cmd) !== "safe") return false;
  return ALLOWED_TOOL_WORD.test(cmd);
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export interface DetectedCommand {
  command: string;
  note: string;
}

/** toolchain 识别：eslint 配置 > tsconfig.json（tsc --noEmit）> scripts.test（npm test）。 */
export async function detectCommand(cwd: string): Promise<DetectedCommand | null> {
  for (const name of ESLINT_CONFIGS) {
    if (await exists(path.join(cwd, name))) {
      return { command: "npx eslint {file}", note: "检测到 eslint 配置，单文件 lint" };
    }
  }
  if (await exists(path.join(cwd, "tsconfig.json"))) {
    return { command: "npx tsc --noEmit", note: "检测到 tsconfig.json，全仓类型检查" };
  }
  try {
    const pkg = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    if (pkg.scripts?.test) {
      return { command: "npm test -- --run", note: "检测到 scripts.test，跑测试" };
    }
  } catch {
    // 无 package.json 或 JSON 解析失败 → 返回 null（无可用 toolchain）
  }
  return null;
}

export type RunCheck = (command: string, cwd: string, timeoutMs: number) => Promise<string>;

/** 默认运行器：跨平台 shell（win32 PowerShell / POSIX bash），错误输出也作为结果文本返回。 */
const runCheck: RunCheck = (command, cwd, timeoutMs) =>
  new Promise((resolve) => {
    const spec = resolveShell(undefined);
    execFile(
      spec.command,
      [...spec.args, command],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        env: { ...process.env, FORCE_COLOR: "0" },
      },
      (err, stdout, stderr) => {
        const combined = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim();
        const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: string | number };
        if (!err) {
          resolve(combined);
          return;
        }
        if (e.killed) {
          resolve(`超时（${timeoutMs}ms）：命令执行超过时限\n${combined}`);
          return;
        }
        resolve(`退出码 ${e.code ?? "error"}\n${combined}`);
      },
    );
  });

function truncateOutput(full: string): string {
  if (full.length <= MAX_OUTPUT) return full;
  return `${full.slice(0, MAX_OUTPUT)}\n…（输出超长，已截断到 ${MAX_OUTPUT} 字符）`;
}

export interface VerifyToolOptions {
  /** 可注入的子进程运行器（测试用）；缺省用真实 shell。 */
  run?: RunCheck;
}

/** 工厂：测试可注入 run；默认实例 verifyTool 注册进 TOOLS（静态工具）。 */
export function makeVerifyTool(opts: VerifyToolOptions = {}): Tool {
  const run = opts.run ?? runCheck;
  return {
    name: "verify",
    description:
      "Run the project's type-check / lint / tests against a changed file and return any errors, so the " +
      "agent can self-correct. Auto-detects toolchain: eslint config → npx eslint <file>; tsconfig.json → " +
      "npx tsc --noEmit; package.json scripts.test → npm test. Pass command to override (template with {file}). " +
      "120s timeout, output truncated to 30k. Only check commands (tsc/eslint/test) are allowed.",
    inputSchema: schema,
    isConcurrencySafe: false,
    async call(input): Promise<ToolCallResult> {
      const { file, command } = schema.parse(input);
      const cwd = process.cwd();
      const abs = path.resolve(cwd, file);

      try {
        await stat(abs);
      } catch {
        return { result: `verify: 文件不存在 ${abs}` };
      }

      let cmd: string;
      let note: string;
      if (command !== undefined) {
        if (!isAllowedCommand(command)) {
          return {
            result: `verify: 拒绝命令「${command}」——只允许 tsc/eslint/test 派生的检查命令`,
          };
        }
        cmd = command;
        note = "自定义命令";
      } else {
        const d = await detectCommand(cwd);
        if (!d) {
          return {
            result:
              "verify: 未检测到可用 toolchain（无 eslint 配置 / tsconfig.json / scripts.test）。可显式传 command。",
          };
        }
        cmd = d.command;
        note = d.note;
      }

      // {file} 占位符 → JSON.stringify 的绝对路径：引号保证含空格路径不拆散
      const finalCmd = cmd.replace(/\{file\}/g, JSON.stringify(abs));
      const output = await run(finalCmd, cwd, DEFAULT_TIMEOUT_MS);
      return { result: `verify · ${note} · ${finalCmd}\n${truncateOutput(output)}` };
    },
  };
}

export const verifyTool: Tool = makeVerifyTool();
