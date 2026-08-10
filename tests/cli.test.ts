import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

// 本文件测试打包产物（dist/cli.js），因此 test 脚本里必须先 build。
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
