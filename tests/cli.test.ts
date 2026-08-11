import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import pkg from "../package.json";

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
  it("--version 输出 package.json 版本且退出 0", async () => {
    const { stdout } = await run(process.execPath, [distCli, "--version"]);
    expect(stdout.trim()).toBe(pkg.version);
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

  it("--mode bypass → commander choices 直接报错并退出 1（V4.5 决策 A 删除 bypass）", async () => {
    let code = 0;
    let stderr = "";
    try {
      await run(process.execPath, [distCli, "--mode", "bypass", "hi"], { env: sandboxEnv() });
    } catch (e) {
      const err = e as { code?: number; stderr?: string };
      code = err.code ?? 1;
      stderr = err.stderr ?? "";
    }
    expect(code).toBe(1);
    expect(stderr).toContain("bypass");
    expect(stderr).toContain("invalid");
  });

  it("--mode plan → commander choices 报非法值并退出 1（V5 决策 A1：plan 不是 CLI 可选项）", async () => {
    let code = 0;
    let stderr = "";
    try {
      await run(process.execPath, [distCli, "--mode", "plan", "hi"], { env: sandboxEnv() });
    } catch (e) {
      const err = e as { code?: number; stderr?: string };
      code = err.code ?? 1;
      stderr = err.stderr ?? "";
    }
    expect(code).toBe(1);
    expect(stderr).toContain("plan");
    expect(stderr).toContain("invalid");
  });

  it("--dangerously-skip-permissions 已删除 → 未知选项报错", async () => {
    let code = 0;
    let stderr = "";
    try {
      await run(process.execPath, [distCli, "--dangerously-skip-permissions", "hi"], {
        env: sandboxEnv(),
      });
    } catch (e) {
      const err = e as { code?: number; stderr?: string };
      code = err.code ?? 1;
      stderr = err.stderr ?? "";
    }
    expect(code).toBe(1);
    expect(stderr).toContain("unknown option");
  });

  it("env 非法模式（RUN_AGENT_MODE=bypass）→ 警告并回退 default（ollama 非 TTY 无需 key/网络）", async () => {
    const env = sandboxEnv();
    env.RUN_AGENT_MODE = "bypass";
    const { stderr } = await run(process.execPath, [distCli, "--provider", "ollama"], { env });
    expect(stderr).toContain("未知权限模式");
    expect(stderr).toContain("default");
  });

  it("memory list 列出索引条目;show 打印全文;rm 删除", async () => {
    const proj = mkdtempSync(join(tmpdir(), "run-agent-proj-"));
    homes.push(proj);
    const mem = join(proj, ".run-agent", "memory");
    mkdirSync(mem, { recursive: true });
    writeFileSync(join(mem, "MEMORY.md"), "- [钩子](a.md) — hook text\n", "utf8");
    writeFileSync(join(mem, "a.md"), "---\nname: a\ndescription: 钩子\n---\nbody text\n", "utf8");
    const env = sandboxEnv();

    const list = await run(process.execPath, [distCli, "memory", "list"], { cwd: proj, env });
    expect(list.stdout).toContain("(a.md)");
    expect(list.stdout).toContain("hook text");

    const show = await run(process.execPath, [distCli, "memory", "show", "a"], { cwd: proj, env });
    expect(show.stdout).toContain("name: a");
    expect(show.stdout).toContain("body text");

    await run(process.execPath, [distCli, "memory", "rm", "a"], { cwd: proj, env });
    expect(existsSync(join(mem, "a.md"))).toBe(false);
  });
});
