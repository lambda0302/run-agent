import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// 本文件测试打包产物（dist/cli.js），因此 test 脚本里必须先 build。
const run = promisify(execFile);
const distCli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

// 沙箱化的 HOME：防止子进程读到用户真实的 config.json / sessions（保持 hermetic）。
// Windows 下 os.homedir() 优先 USERPROFILE，POSIX 优先 HOME，两者都覆盖。
const homes: string[] = [];
function sandboxEnv(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "run-agent-home-"));
  homes.push(dir);
  return { ...process.env, USERPROFILE: dir, HOME: dir };
}

afterEach(() => {
  for (const d of homes.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("CLI 冒烟（先 npm run build）", () => {
  it("--version 输出 0.2.0 且退出 0", async () => {
    const { stdout } = await run(process.execPath, [distCli, "--version"]);
    expect(stdout.trim()).toBe("0.2.0");
  });

  it("--help 退出 0 且包含 provider 与 --resume", async () => {
    const { stdout } = await run(process.execPath, [distCli, "--help"]);
    expect(stdout).toContain("run-agent");
    expect(stdout).toContain("prompt");
    expect(stdout).toContain("--provider");
    expect(stdout).toContain("--resume");
  });

  it("openai-compatible 缺 baseURL 时报错并退出 1", async () => {
    let code = 0;
    let stderr = "";
    try {
      await run(process.execPath, [distCli, "--provider", "openai-compatible", "hi"], {
        env: sandboxEnv(),
      });
    } catch (e) {
      const err = e as { code?: number; stderr?: string };
      code = err.code ?? 1;
      stderr = err.stderr ?? "";
    }
    expect(code).toBe(1);
    expect(stderr).toContain("--base-url");
  });
});
