import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Tool, ToolCallResult } from "../../tools.js";
import { resolveShell } from "./shell.js";

const MAX_OUTPUT = 30_000; // 超过截断，完整输出落盘
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 64 * 1024 * 1024; // execFile 内部 buffer 上限

const schema = z.object({
  command: z.string().min(1).describe("Shell command to run"),
  cwd: z.string().optional().describe("Working directory; defaults to current working directory"),
  timeout: z.number().int().positive().optional().describe("Timeout in ms (default 120000)"),
  description: z.string().optional().describe("Optional human-readable description of the command"),
  shell: z.string().optional().describe("Shell override, e.g. 'bash' or a path"),
});

function runCommand(
  spec: { command: string; args: string[] },
  command: string,
  cwd: string | undefined,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      spec.command,
      [...spec.args, command],
      {
        cwd: cwd ? path.resolve(cwd) : undefined,
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        env: { ...process.env, FORCE_COLOR: "0" },
      },
      (err, stdout, stderr) => {
        const combined = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim();
        if (!err) {
          resolve(combined);
          return;
        }
        const e = err as NodeJS.ErrnoException & { killed?: boolean };
        if (e.killed) {
          reject(new Error(`命令超时（${timeoutMs}ms）\n${combined}`));
          return;
        }
        if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          reject(new Error("命令输出超过 64MB 上限，已丢弃"));
          return;
        }
        reject(new Error(`命令退出码 ${e.code ?? "error"}\n${combined}`));
      },
    );
  });
}

/** 输出超长时把完整内容落盘，返回截断后的结果。 */
function truncateOutput(full: string, tag: string): { result: string; artifacts?: string[] } {
  if (full.length <= MAX_OUTPUT) return { result: full };
  const file = path.join(tmpdir(), `run-agent-${tag}-${Date.now()}.log`);
  void writeFile(file, full, "utf8");
  return {
    result: full.slice(0, MAX_OUTPUT) + `\n…（输出超长，已截断；完整输出已写入 ${file}）`,
    artifacts: [file],
  };
}

export const bashTool: Tool = {
  name: "run_bash",
  description:
    "Run a shell command and return its output. Default 120s timeout, output truncated to 30k chars. " +
    "For long-running commands increase timeout; cwd defaults to the project root.",
  inputSchema: schema,
  async call(input): Promise<ToolCallResult> {
    const { command, cwd, timeout, shell } = schema.parse(input);
    const spec = resolveShell(shell);
    const timeoutMs = timeout ?? DEFAULT_TIMEOUT_MS;

    try {
      const full = await runCommand(spec, command, cwd, timeoutMs);
      return truncateOutput(full, "out");
    } catch (e) {
      return truncateOutput(e instanceof Error ? e.message : String(e), "err");
    }
  },
};
