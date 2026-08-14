import { mkdtempSync, rmSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COMPACT_MARKER } from "../../src/core/compact.js";
import type { LLMMessage } from "../../src/providers/types.js";
import {
  appendMessage,
  createSessionFile,
  findSessionFile,
  latestSessionFile,
  listSessions,
  loadSession,
  sanitizePath,
  sessionIdTime,
  sessionsDir,
} from "../../src/utils/sessionStorage.js";

let dirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "run-agent-sess-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("sessionStorage（JSONL 会话）", () => {
  it("create → append → load 往返一致", async () => {
    const dir = tempDir();
    const file = await createSessionFile(dir);
    const msgs: LLMMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "yo" }] },
    ];
    for (const m of msgs) await appendMessage(file, m);
    expect(await loadSession(file)).toEqual(msgs);
  });

  it("latestSessionFile 返回最新创建的会话", async () => {
    const dir = tempDir();
    const f1 = await createSessionFile(dir);
    await appendMessage(f1, { role: "user", content: "a" });
    await new Promise((r) => setTimeout(r, 10));
    const f2 = await createSessionFile(dir);
    await appendMessage(f2, { role: "user", content: "b" });
    expect(await latestSessionFile(dir)).toBe(f2);
    expect(f1).not.toBe(f2);
  });

  it("没有会话时 latestSessionFile 返回 undefined", async () => {
    const dir = tempDir();
    expect(await latestSessionFile(dir)).toBeUndefined();
  });

  it("latestSessionFile 排除子 agent transcript（subagent- 前缀，V7 目录混存）", async () => {
    const dir = tempDir();
    // 子 agent transcript 以字母开头，倒序字典序恒排在时间戳主会话前（bug：不排除会误选）
    const sub = path.join(dir, "subagent-task-1.jsonl");
    await appendFile(sub, "{}\n", "utf8");
    const main = await createSessionFile(dir);
    await appendMessage(main, { role: "user", content: "a" });
    expect(await latestSessionFile(dir)).toBe(main);
  });

  it("目录里只有子 agent transcript 时 latestSessionFile 返回 undefined", async () => {
    const dir = tempDir();
    const sub = path.join(dir, "subagent-task-1.jsonl");
    await appendFile(sub, "{}\n", "utf8");
    expect(await latestSessionFile(dir)).toBeUndefined();
  });

  it("损坏的行在加载时被跳过", async () => {
    const dir = tempDir();
    const file = await createSessionFile(dir);
    await appendFile(file, "{bad json}\n", "utf8");
    await appendMessage(file, { role: "user", content: "ok" });
    expect(await loadSession(file)).toEqual([{ role: "user", content: "ok" }]);
  });

  it("遇到压缩边界：只从含哨兵的边界消息续起（更早历史被忽略）", async () => {
    const dir = tempDir();
    const file = await createSessionFile(dir);
    const boundary: LLMMessage = {
      role: "user",
      content: `[上下文已压缩] ${COMPACT_MARKER}\n摘要`,
    };
    await appendMessage(file, { role: "user", content: "旧消息1" });
    await appendMessage(file, { role: "assistant", content: "旧回复" });
    await appendMessage(file, boundary);
    await appendMessage(file, { role: "user", content: "新消息" });
    expect(await loadSession(file)).toEqual([boundary, { role: "user", content: "新消息" }]);
  });

  it("多边界：取最后一个边界续起", async () => {
    const dir = tempDir();
    const file = await createSessionFile(dir);
    const b1: LLMMessage = { role: "user", content: `[上下文已压缩] ${COMPACT_MARKER}\n摘要1` };
    const b2: LLMMessage = { role: "user", content: `[上下文已压缩] ${COMPACT_MARKER}\n摘要2` };
    await appendMessage(file, { role: "user", content: "a" });
    await appendMessage(file, b1);
    await appendMessage(file, { role: "user", content: "b" });
    await appendMessage(file, b2);
    await appendMessage(file, { role: "user", content: "c" });
    expect(await loadSession(file)).toEqual([b2, { role: "user", content: "c" }]);
  });

  it("V8① sanitizePath：非字母数字 → '-',字母数字保留", () => {
    expect(sanitizePath("C:/My/Project")).toBe("C--My-Project");
    expect(sanitizePath("F:\\MyClaudeCode\\run-agent")).toBe("F--MyClaudeCode-run-agent");
  });

  it("V8① sanitizePath：超长路径截断 200 字符 + hash 后缀保唯一", () => {
    const long = `C:/${"a".repeat(300)}/${"b".repeat(100)}`;
    const s = sanitizePath(long);
    expect(s.length).toBeLessThanOrEqual(200 + 1 + 8);
    expect(s).toMatch(/-[0-9a-f]{8}$/);
    expect(s.slice(0, 200)).toMatch(/^C--/); // 前 200 字符为截断部分
    // 不同路径 → 不同目录名（截断后靠 hash 区分）
    const s2 = sanitizePath(long + "/c");
    expect(s2).not.toBe(s);
  });

  it("V8① sessionsDir(cwd) 按 cwd 分目录（跨项目不串会话）", () => {
    const root = sessionsDir();
    expect(sessionsDir("C:/proj/alpha")).toBe(path.join(root, sanitizePath("C:/proj/alpha")));
    expect(sessionsDir("C:/proj/beta")).toBe(path.join(root, sanitizePath("C:/proj/beta")));
    expect(sessionsDir("C:/proj/alpha")).not.toBe(sessionsDir("C:/proj/beta"));
  });

  it("V8② 首行元数据：createSessionFile 写 meta 行，loadSession 跳过", async () => {
    const dir = tempDir();
    const file = await createSessionFile(dir, {
      cwd: "C:/proj",
      model: "claude-opus-5",
      provider: "anthropic",
      version: "0.9.0",
    });
    await appendMessage(file, { role: "user", content: "hi" });
    await appendMessage(file, { role: "assistant", content: "yo" });
    expect(await loadSession(file)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    ]);
    // 元数据行真实存在（第 1 行，供 --list 只读首行）
    const raw = await readFile(file, "utf8");
    const first = JSON.parse(raw.split("\n")[0]!) as { meta?: unknown };
    expect(first.meta).toEqual({
      cwd: "C:/proj",
      model: "claude-opus-5",
      provider: "anthropic",
      version: "0.9.0",
    });
  });

  it("V8④ listSessions：倒序、含 meta.model 与 preview、排除 subagent-", async () => {
    const dir = tempDir();
    // 先建旧的（时间戳早），后建新的（时间戳晚）→ 列表倒序新的在前
    const f1 = await createSessionFile(dir, { cwd: "C:/proj", model: "m-old", provider: "anthropic" });
    await appendMessage(f1, { role: "user", content: "第一个会话的 prompt" });
    await new Promise((r) => setTimeout(r, 10));
    const f2 = await createSessionFile(dir, { cwd: "C:/proj", model: "m-new", provider: "anthropic" });
    await appendMessage(f2, { role: "user", content: "第二个会话的 prompt" });
    // 子 agent transcript 不应出现在列表
    await appendFile(path.join(dir, "subagent-task-1.jsonl"), "{}\n", "utf8");

    const list = await listSessions(dir);
    expect(list.map((s) => s.file)).toEqual([f2, f1]);
    expect(list[0]!.meta?.model).toBe("m-new");
    expect(list[0]!.preview).toBe("第二个会话的 prompt");
    expect(list[1]!.meta?.model).toBe("m-old");
    expect(list[1]!.preview).toBe("第一个会话的 prompt");
  });

  it("V8④ listSessions：preview 折叠空白并截断 60 字符；目录不存在返回空数组", async () => {
    const dir = tempDir();
    const f = await createSessionFile(dir, { cwd: "C:/proj", model: "m", provider: "anthropic" });
    const long = `第${"很".repeat(80)}长的 prompt 带换行\n第二行`;
    await appendMessage(f, { role: "user", content: long });
    const list = await listSessions(dir);
    const p = list[0]!.preview!;
    expect(p).not.toContain("\n"); // 换行折叠成空格
    expect(p.length).toBeLessThanOrEqual(61); // 60 + … 省略号
    expect(p.endsWith("…")).toBe(true);
    expect(await listSessions(path.join(dir, "not-exist"))).toEqual([]);
  });

  it("sessionIdTime：把 UTC 文件名时间戳显示为本地时区（地区自适应，非固定时区）", () => {
    // 输入是 UTC 时刻 2026-08-14T06:30:00Z。期望值 = 该时刻的本地表示，
    // 用同一个 Date 的本地 getter 计算 → 无论 CI 跑在哪个时区（UTC / UTC+8）都成立。
    const id = "2026-08-14T06-30-00-000Z-abc123";
    const d = new Date("2026-08-14T06:30:00.000Z");
    const p = (n: number) => String(n).padStart(2, "0");
    const expected = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    expect(sessionIdTime(id)).toBe(expected);
  });

  it("sessionIdTime：未知格式兜底为原样截断（不抛错）", () => {
    expect(sessionIdTime("garbage")).toBe("garbage");
    expect(sessionIdTime("2026-08-14")).toBe("2026-08-14"); // 无时间部分
    expect(sessionIdTime("")).toBe("");
  });

  it("V8⑤ findSessionFile：正常 id 定位；非法/不存在返回 undefined", async () => {
    const dir = tempDir();
    const f = await createSessionFile(dir, { cwd: "C:/proj" });
    const id = path.basename(f).slice(0, -".jsonl".length);
    expect(await findSessionFile(dir, id)).toBe(f);
    expect(await findSessionFile(dir, "no-such-session")).toBeUndefined();
    // 路径穿越 / 点开头 / 分隔符一律拒绝
    expect(await findSessionFile(dir, "../evil")).toBeUndefined();
    expect(await findSessionFile(dir, "..")).toBeUndefined();
    expect(await findSessionFile(dir, ".hidden")).toBeUndefined();
    expect(await findSessionFile(dir, "a/b")).toBeUndefined();
  });
});
