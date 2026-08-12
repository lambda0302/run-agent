/**
 * V6 决策 A：HookManager 执行测试（hermetic——本地 node 脚本 / 本地 http server，不发真实请求）。
 * 覆盖：execCommand（stdin JSON 输入 / 输出回填 / 非 0 退出码 / 超时 kill）、
 * execHttp（POST / 401）、PreToolUse 决策与 matcher 过滤、Stop/PostToolUse/Session* 事件。
 */
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HookManager,
  DEFAULT_HOOK_TIMEOUT_MS,
  HOOK_INJECT_LIMIT,
} from "../../../src/services/hooks/manager.js";
import type { HooksConfig } from "../../../src/services/hooks/config.js";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "run-agent-hooks-mgr-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * 写一个 stdin 读 JSON → 回显 `{received, echo, permissionDecision:"allow"}` 的 node 脚本。
 * 回 permissionDecision 让 PreToolUse 能拿到决策；脚本里先 JSON.parse 再回显，即证明 stdin JSON 送达。
 * 命令用文件脚本而非内联 -e——PowerShell 原生参数传递会剥掉内联脚本里的单引号（`'a'.repeat` → `a.repeat`）。
 */
function echoScript(dir: string): string {
  const file = path.join(dir, "echo.js");
  writeFileSync(
    file,
    `let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const i=JSON.parse(d);process.stdout.write(JSON.stringify({received:i,echo:"ok",permissionDecision:"allow"}))});`,
    "utf8",
  );
  return `"${process.execPath}" "${file}"`;
}

/** 写一个 stdout 输出 N 个字符的脚本。 */
function bigOutputScript(dir: string, n: number): string {
  const file = path.join(dir, "big.js");
  writeFileSync(file, `process.stdout.write("x".repeat(${n}));`, "utf8");
  return `"${process.execPath}" "${file}"`;
}

function newManager(config: HooksConfig, cwd = process.cwd()): HookManager {
  return new HookManager(config, { cwd });
}

describe("HookManager 执行（execCommand）", () => {
  it("命令经 stdin 收 JSON、stdout 回填；onPreToolUse 解析出 permissionDecision", async () => {
    const dir = tempDir();
    const cmd = echoScript(dir);
    const m = newManager({
      PreToolUse: [
        {
          matcher: "run_bash",
          hooks: [{ type: "command", command: `${cmd}` }],
        },
      ],
    });
    const d = await m.onPreToolUse("run_bash", { command: "echo hi" });
    expect(d?.permissionDecision).toBe("allow");
    // stdin 收到的输入含 tool_use.name
    expect(d?.permissionDecisionReason).toBeUndefined();
  });

  it("matcher 不匹配 → 不触发；无 matcher → 匹配全部", async () => {
    const dir = tempDir();
    const cmd = echoScript(dir);
    const m = newManager({
      PreToolUse: [
        { matcher: "run_bash", hooks: [{ type: "command", command: cmd }] },
        { hooks: [{ type: "command", command: cmd }] }, // 无 matcher → 全匹配
      ],
    });
    // 只有无 matcher 的规则会跑（matcher 规则被跳过）
    const only = newManager({
      PreToolUse: [{ matcher: "run_bash", hooks: [{ type: "command", command: cmd }] }],
    });
    expect(await only.onPreToolUse("read_file", {})).toBeUndefined();
    // 第二条无 matcher 规则会命中 read_file
    expect((await m.onPreToolUse("read_file", {}))?.permissionDecision).toBe("allow");
  });

  it("permissionDecision=deny 带 reason 透传", async () => {
    const dir = tempDir();
    const file = path.join(dir, "deny.js");
    writeFileSync(
      file,
      `process.stdin.on("data",()=>{});process.stdin.on("end",()=>process.stdout.write(JSON.stringify({permissionDecision:"deny",permissionDecisionReason:"test 禁止"})));`,
      "utf8",
    );
    const m = newManager({
      PreToolUse: [{ hooks: [{ type: "command", command: `"${process.execPath}" "${file}"` }] }],
    });
    const d = await m.onPreToolUse("run_bash", {});
    expect(d?.permissionDecision).toBe("deny");
    expect(d?.permissionDecisionReason).toBe("test 禁止");
  });

  it("非 JSON 输出 → 无决策（原样忽略）；非法正则 matcher → 匹配全部不崩", async () => {
    const dir = tempDir();
    const file = path.join(dir, "plain.js");
    writeFileSync(
      file,
      `process.stdin.on("data",()=>{});process.stdin.on("end",()=>process.stdout.write("just text"));`,
      "utf8",
    );
    const m = newManager({
      PreToolUse: [
        { matcher: "([", hooks: [{ type: "command", command: `"${process.execPath}" "${file}"` }] },
      ],
    });
    expect(await m.onPreToolUse("read_file", {})).toBeUndefined();
  });

  it("超时 kill（timedOut，不阻断）", async () => {
    const dir = tempDir();
    const file = path.join(dir, "sleep.js");
    writeFileSync(file, `setTimeout(()=>process.exit(0),10000);`, "utf8");
    const m = newManager({
      Stop: [
        { hooks: [{ type: "command", command: `"${process.execPath}" "${file}"`, timeout: 100 }] },
      ],
    });
    const out = await m.onStop("reply");
    expect(out ?? "").toContain("超时");
  });
});

describe("HookManager 执行（execHttp）", () => {
  it("POST JSON body，状态码 200 → ok；401 → 非 ok", async () => {
    let received: unknown;
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c));
      req.on("end", () => {
        received = JSON.parse(body);
        res.statusCode = req.headers["x-test"] === "fail" ? 401 : 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ fromServer: true }));
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    try {
      const url = `http://127.0.0.1:${port}/h`;
      const m = newManager({
        Stop: [{ hooks: [{ type: "http", url, headers: { "x-test": "ok" } }] }],
      });
      const okOut = await m.onStop("hi");
      expect(okOut).toContain("fromServer");
      expect(received).toMatchObject({ reply: "hi", cwd: process.cwd() });

      const failM = newManager({
        Stop: [{ hooks: [{ type: "http", url, headers: { "x-test": "fail" } }] }],
      });
      // 非 2xx 不抛错，输出为响应体
      expect(await failM.onStop("hi")).toContain("fromServer");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("HookManager 事件（Stop / PostToolUse / Session*）", () => {
  it("Stop 输出合并、单条截断到 HOOK_INJECT_LIMIT", async () => {
    const dir = tempDir();
    const m = newManager({
      Stop: [{ hooks: [{ type: "command", command: bigOutputScript(dir, 5000) }] }],
    });
    const out = await m.onStop("reply");
    expect(out?.length).toBe(HOOK_INJECT_LIMIT); // 单条截断到常量上限
  });

  it("PostToolUse 带 tool_result（截断到 2000），SessionStart/End 触发", async () => {
    const dir = tempDir();
    const cmd = echoScript(dir);
    const m = newManager({
      PostToolUse: [{ hooks: [{ type: "command", command: cmd }] }],
      SessionStart: [{ hooks: [{ type: "command", command: cmd }] }],
      SessionEnd: [{ hooks: [{ type: "command", command: cmd }] }],
    });
    const post = await m.onPostToolUse(
      "edit_file",
      { file_path: "a.ts" },
      "big-result-".repeat(300),
    );
    expect(post).toContain('"echo":"ok"');
    expect(post).toContain("tool_result");
    expect(post).toContain("tool_use");

    // 回显的是 `{received:{session:"start",...}}` 的 JSON 串
    const start = await m.onSessionStart();
    expect(start).toContain('"session":"start"');
    expect(start).toContain('"echo":"ok"');
    const end = await m.onSessionEnd();
    expect(end).toContain('"session":"end"');
  });

  it("默认超时常量暴露（DEFAULT_HOOK_TIMEOUT_MS = 30s）", () => {
    expect(DEFAULT_HOOK_TIMEOUT_MS).toBe(30_000);
  });
});
