import readline from "node:readline";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { nextFocus, promptSelect } from "../../src/ui/select.js";
import type { SelectOption } from "../../src/ui/select.js";

/** 收集输出的 writable + 计数。 */
function collectOut(): { out: NodeJS.WritableStream; written: () => string } {
  let buf = "";
  const out = new Writable({
    write(chunk: Buffer, _enc, cb) {
      buf += chunk.toString();
      cb();
    },
  });
  return { out, written: () => buf };
}

const ABC: SelectOption<string>[] = [
  { label: "A", value: "a" },
  { label: "B", value: "b" },
  { label: "C", value: "c" },
];

describe("nextFocus（纯函数）", () => {
  it("普通移动", () => {
    expect(nextFocus(0, 1, [{}, {}, {}])).toBe(1);
    expect(nextFocus(1, -1, [{}, {}, {}])).toBe(0);
  });

  it("越界回绕", () => {
    expect(nextFocus(2, 1, [{}, {}, {}])).toBe(0);
    expect(nextFocus(0, -1, [{}, {}, {}])).toBe(2);
  });

  it("跳过 disabled", () => {
    const opts = [{}, { disabled: true }, {}];
    expect(nextFocus(0, 1, opts)).toBe(2);
    expect(nextFocus(0, -1, opts)).toBe(2); // 反向往回绕过 disabled
  });

  it("全 disabled：焦点不动", () => {
    expect(nextFocus(0, 1, [{ disabled: true }, { disabled: true }])).toBe(0);
  });

  it("空数组返回 -1", () => {
    expect(nextFocus(0, 1, [])).toBe(-1);
  });
});

describe("promptSelect（注入假 data 事件源）", () => {
  it("↑/↓ 移动焦点、Enter 确认当前项", async () => {
    const input = new PassThrough();
    const { out } = collectOut();
    const p = promptSelect(ABC, { input, out });
    input.write("\x1b[B"); // → B
    input.write("\x1b[B"); // → C
    input.write("\x1b[A"); // → B
    input.write("\r");
    await expect(p).resolves.toBe("b");
  });

  it("Escape 取消返回 undefined", async () => {
    const input = new PassThrough();
    const { out } = collectOut();
    const p = promptSelect(ABC, { input, out });
    input.write("\x1b[B");
    input.write("\x1b");
    await expect(p).resolves.toBeUndefined();
  });

  it("方向键序列到达时不会误触发 Escape 取消", async () => {
    const input = new PassThrough();
    const { out } = collectOut();
    const p = promptSelect(ABC, { input, out });
    input.write("\x1b[B\r"); // 一次给全：down + enter
    await expect(p).resolves.toBe("b");
  });

  it("disabled 初始焦点自动跳过；initial 越界钳制", async () => {
    const opts: SelectOption<string>[] = [
      { label: "D1", value: "d", disabled: true },
      { label: "OK", value: "ok" },
    ];
    const input = new PassThrough();
    const { out } = collectOut();
    const p = promptSelect(opts, { input, out, initial: 0 });
    input.write("\r");
    await expect(p).resolves.toBe("ok"); // 焦点跳过 disabled 落在 "OK"
  });

  it("重绘：移动后输出 ANSI 上移序列", async () => {
    const input = new PassThrough();
    const { out, written } = collectOut();
    const p = promptSelect(ABC, { input, out });
    const initialRender = written();
    expect(initialRender).toContain("❯ A");
    expect(initialRender).not.toContain("❯ B"); // 初始只有 A 有指针
    input.write("\x1b[B");
    await new Promise((r) => setTimeout(r, 5));
    expect(written()).toContain("\x1b[3A"); // 重绘：上移 3 行
    input.write("\r");
    await expect(p).resolves.toBe("b");
  });

  it("只传 rl 不传 input：回退 rl.input（REPL ask /sessions 注入形态）", async () => {
    const input = new PassThrough();
    const { out } = collectOut();
    const rl = readline.createInterface({ input, output: new PassThrough(), terminal: false });
    const p = promptSelect(ABC, { out, rl });
    input.write("\x1b[B\r"); // down + enter → "b"
    await expect(p).resolves.toBe("b");
  });

  it("菜单期间 readline 静音，结束后 line 监听恢复", async () => {
    const input = new PassThrough();
    const { out } = collectOut();
    const rl = readline.createInterface({ input, output: new PassThrough(), terminal: true });
    const lines: string[] = [];
    rl.on("line", (l) => lines.push(l));

    const p = promptSelect(ABC, { input, out, rl });
    input.write("\x1b[B\r"); // 菜单内：down + enter（静音期间不应触发 line）
    await expect(p).resolves.toBe("b");

    // 菜单已结束：line 监听恢复，喂正常输入应触发
    await new Promise((r) => setTimeout(r, 10));
    input.write("hi\r");
    await new Promise((r) => setTimeout(r, 20));
    expect(lines).toEqual(["hi"]); // 菜单期间的 \r 未被 readline 捕获
  });
});
