import { describe, expect, it } from "vitest";
import {
  isAcceptKey,
  isCancelKey,
  isNextKey,
  isPreviousKey,
  parseKeypress,
} from "../../src/ui/keypress.js";

describe("parseKeypress（ANSI 序列 → 按键事件）", () => {
  it("方向键：\\x1b[A→up、\\x1b[B→down", () => {
    expect(parseKeypress(Buffer.from("\x1b[A"))).toEqual([{ name: "up" }]);
    expect(parseKeypress(Buffer.from("\x1b[B"))).toEqual([{ name: "down" }]);
  });

  it("\\r / \\n → enter", () => {
    expect(parseKeypress(Buffer.from("\r"))).toEqual([{ name: "enter" }]);
    expect(parseKeypress(Buffer.from("\n"))).toEqual([{ name: "enter" }]);
  });

  it("裸 \\x1b 与不完整 CSI 序列返回 null（等待后续字节）", () => {
    expect(parseKeypress(Buffer.from("\x1b"))).toBeNull();
    expect(parseKeypress(Buffer.from("\x1b["))).toBeNull();
  });

  it("未知 CSI 序列返回 null（忽略 Home/End/右箭头等）", () => {
    expect(parseKeypress(Buffer.from("\x1b[C"))).toBeNull();
    expect(parseKeypress(Buffer.from("\x1b[1~"))).toBeNull();
  });

  it("普通字符 → char", () => {
    expect(parseKeypress(Buffer.from("a"))).toEqual([{ name: "char", char: "a", ctrl: false }]);
  });

  it("控制字符 → ctrl+字母（\\x01=ctrl+a → 'A'）", () => {
    expect(parseKeypress(Buffer.from("\x01"))).toEqual([{ name: "char", char: "A", ctrl: true }]);
    expect(parseKeypress(Buffer.from("\x10"))).toEqual([{ name: "char", char: "P", ctrl: true }]);
  });

  it("UTF-8 多字节 → 完整字符", () => {
    expect(parseKeypress(Buffer.from("你好", "utf8"))).toEqual([
      { name: "char", char: "你", ctrl: false },
      { name: "char", char: "好", ctrl: false },
    ]);
  });

  it("一段多按键 → 事件数组", () => {
    expect(parseKeypress(Buffer.from("\x1b[A\x1b[B\r"))).toEqual([
      { name: "up" },
      { name: "down" },
      { name: "enter" },
    ]);
  });

  it("UTF-8 截断（不完整多字节）返回 null", () => {
    const bytes = Buffer.from("你", "utf8"); // 3 字节
    expect(parseKeypress(bytes.subarray(0, 2))).toBeNull();
  });
});

describe("判词（语义动作，注册表思想）", () => {
  it("previous：↑ / k / ctrl+p", () => {
    expect(isPreviousKey({ name: "up" })).toBe(true);
    expect(isPreviousKey({ name: "char", char: "k", ctrl: false })).toBe(true);
    expect(isPreviousKey({ name: "char", char: "P", ctrl: true })).toBe(true);
    // 反例
    expect(isPreviousKey({ name: "down" })).toBe(false);
    expect(isPreviousKey({ name: "char", char: "j", ctrl: false })).toBe(false);
  });

  it("next：↓ / j / ctrl+n", () => {
    expect(isNextKey({ name: "down" })).toBe(true);
    expect(isNextKey({ name: "char", char: "j", ctrl: false })).toBe(true);
    expect(isNextKey({ name: "char", char: "N", ctrl: true })).toBe(true);
    expect(isNextKey({ name: "char", char: "k", ctrl: false })).toBe(false);
  });

  it("accept：Enter / 空格", () => {
    expect(isAcceptKey({ name: "enter" })).toBe(true);
    expect(isAcceptKey({ name: "char", char: " ", ctrl: false })).toBe(true);
    expect(isAcceptKey({ name: "char", char: " ", ctrl: true })).toBe(false);
    expect(isAcceptKey({ name: "char", char: "a", ctrl: false })).toBe(false);
  });

  it("cancel：Esc", () => {
    expect(isCancelKey({ name: "escape" })).toBe(true);
    expect(isCancelKey({ name: "enter" })).toBe(false);
  });
});
