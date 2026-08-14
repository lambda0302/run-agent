/**
 * 按键解析（V8 方向键菜单基建，select-ui-plan §2.1）。
 * 纯函数、零 TTY 依赖，可脱离终端单测。
 *
 * 解析 ANSI 序列：`\x1b[A`→up、`\x1b[B`→down、`\r`/`\n`→enter、`\x1b`→escape；
 * 控制字符按 ctrl+字母 归一（`\x01`=ctrl+a → char 'A' + ctrl:true）；UTF-8 多字节还原成字符。
 * 同 CC keybindings 注册表思想：物理键 → 语义判词（isPreviousKey/isNextKey/…），
 * 未来加 vim/ctrl 快捷键只需改这里。
 */

export interface KeyEvent {
  name: "up" | "down" | "enter" | "escape" | "char";
  char?: string;
  ctrl?: boolean;
}

/**
 * 解析一段输入字节 → 按键事件数组。
 * 返回 null = 序列不完整（裸 `\x1b` 可能是 escape 也可能是 `\x1b[A` 的开头）或未知序列——调用方
 * 应暂存等待更多字节；完整序列才能产出事件（保证一次按键不多解析）。
 */
export function parseKeypress(chunk: Buffer): KeyEvent[] | null {
  const out: KeyEvent[] = [];
  let i = 0;
  while (i < chunk.length) {
    const b = chunk[i]!;
    if (b === 0x1b) {
      // 转义序列
      if (i + 1 >= chunk.length) return null; // 裸 ESC：可能未完
      const b1 = chunk[i + 1]!;
      if (b1 === 0x5b) {
        // CSI：\x1b[<final>
        if (i + 2 >= chunk.length) return null; // \x1b[ 未完
        const b2 = chunk[i + 2]!;
        if (b2 === 0x41) {
          out.push({ name: "up" });
          i += 3;
          continue;
        }
        if (b2 === 0x42) {
          out.push({ name: "down" });
          i += 3;
          continue;
        }
        return null; // 未知 CSI 序列（Home/End/翻页等，忽略）
      }
      if (b1 === 0x4f) return null; // SS3 方向键（部分终端），忽略
      out.push({ name: "escape" });
      i += 1;
      continue;
    }
    if (b === 0x0d || b === 0x0a) {
      out.push({ name: "enter" });
      i += 1;
      continue;
    }
    if (b === 0x09) {
      out.push({ name: "char", char: "\t", ctrl: false });
      i += 1;
      continue;
    }
    if (b < 0x20 || b === 0x7f) {
      // 控制字符 → ctrl+字母（\x01=ctrl+a → 'A'）
      out.push({ name: "char", char: String.fromCharCode(b + 0x40), ctrl: true });
      i += 1;
      continue;
    }
    if (b < 0x80) {
      out.push({ name: "char", char: String.fromCharCode(b), ctrl: false });
      i += 1;
      continue;
    }
    // UTF-8 多字节：按首字节推断长度，不足则等待
    let len = 1;
    if ((b & 0xe0) === 0xc0) len = 2;
    else if ((b & 0xf0) === 0xe0) len = 3;
    else if ((b & 0xf8) === 0xf0) len = 4;
    if (i + len > chunk.length) return null;
    out.push({ name: "char", char: chunk.subarray(i, i + len).toString("utf8"), ctrl: false });
    i += len;
  }
  return out;
}

/** ↑ / k / ctrl+p → 上一个 */
export function isPreviousKey(ev: KeyEvent): boolean {
  return (
    ev.name === "up" ||
    (ev.name === "char" && ev.char === "k" && !ev.ctrl) ||
    (ev.name === "char" && ev.ctrl === true && ev.char?.toLowerCase() === "p")
  );
}

/** ↓ / j / ctrl+n → 下一个 */
export function isNextKey(ev: KeyEvent): boolean {
  return (
    ev.name === "down" ||
    (ev.name === "char" && ev.char === "j" && !ev.ctrl) ||
    (ev.name === "char" && ev.ctrl === true && ev.char?.toLowerCase() === "n")
  );
}

/** Enter / 空格 → 确认 */
export function isAcceptKey(ev: KeyEvent): boolean {
  return ev.name === "enter" || (ev.name === "char" && ev.char === " " && !ev.ctrl);
}

/** Esc → 取消 */
export function isCancelKey(ev: KeyEvent): boolean {
  return ev.name === "escape";
}
