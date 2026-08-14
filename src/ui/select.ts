/**
 * 方向键 + Enter 选择菜单（V8 方向键菜单基建，select-ui-plan §2.2）。
 * 零依赖：不引入 Ink/React，纯 ANSI 重绘 + 手动 raw-mode 按键收集。
 *
 * stdin 唯一所有权铁律（select-ui-plan §2.4）：菜单是 readline 之外的一个「临时读者」，
 * 必须显式接收 REPL 的 rl——进入时 rl.pause() + 临时移除 line 监听（readline 完全静音，
 * 否则 resume 后复吸会把菜单按键当成输入），结束恢复原状。全程串行、无第二个常驻读者。
 */
import type { Interface } from "node:readline";
import {
  isAcceptKey,
  isCancelKey,
  isNextKey,
  isPreviousKey,
  parseKeypress,
} from "./keypress.js";

export interface SelectOption<T> {
  label: string;
  value: T;
  description?: string;
  disabled?: boolean;
}

export interface PromptSelectOptions {
  /** 渲染输出（默认 process.stdout；测试注入） */
  out?: NodeJS.WritableStream;
  /** 按键来源（默认 process.stdin；测试注入 PassThrough 喂字节） */
  input?: NodeJS.ReadableStream;
  /** REPL 的 readline：菜单期间 pause + line 静音，结束恢复（stdin 唯一所有权） */
  rl?: Interface;
  /** 初始焦点下标（默认 0；越界钳制） */
  initial?: number;
}

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** 菜单可用的最小按键源接口（规避 ReadableStream on/removeListener 的重载联合类型坑）。 */
interface KeySource {
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  removeListener(event: "data", listener: (chunk: Buffer) => void): unknown;
  resume(): unknown;
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(b: boolean): unknown;
}

/** 焦点移动纯函数：越界回绕 + 跳过 disabled（对齐 CC use-select-navigation reducer 语义）。 */
export function nextFocus(
  index: number,
  delta: number,
  options: ReadonlyArray<{ disabled?: boolean }>,
): number {
  const n = options.length;
  if (n === 0) return -1;
  let i = index;
  for (let step = 0; step < n; step++) {
    i = (i + delta + n) % n;
    if (!options[i]?.disabled) return i;
  }
  return index; // 全 disabled：焦点不动
}

/**
 * 方向键菜单选择。返回选中项的 value；Escape 取消返回 undefined。
 * 非 TTY（headless / 测试注入流）自动跳过 raw mode，行为不变。
 */
export async function promptSelect<T>(
  options: SelectOption<T>[],
  opts: PromptSelectOptions = {},
): Promise<T | undefined> {
  const out = opts.out ?? process.stdout;
  const rl = opts.rl;
  // 显式 input 优先；否则回退 rl.input（REPL 注入 rl 时其 input 是唯一数据源，测试也经此注入），
  // 最后才是 process.stdin。缺 input 时监听 process.stdin 会漏掉 REPL 的注入流（V8 弹窗 bug）。
  // Node 的 Interface 类型不暴露 input（运行时存在），用窄化断言取。
  const rlInput = rl ? (rl as unknown as { input?: NodeJS.ReadableStream }).input : undefined;
  const input = (opts.input ?? rlInput ?? process.stdin) as KeySource;
  const n = options.length;
  if (n === 0) return undefined;

  let focus = opts.initial ?? 0;
  if (focus < 0 || focus >= n) focus = 0;
  if (options[focus]?.disabled) {
    const nf = nextFocus(focus, 1, options);
    if (nf === focus) return undefined; // 全部 disabled，无可选
    focus = nf;
  }

  // ── 进入菜单：readline 静音（pause + 临时移除 line 监听）────
  const lineHandlers = rl ? (rl.listeners("line") as Array<(...a: unknown[]) => void>) : [];
  if (rl) {
    rl.pause();
    rl.removeAllListeners("line");
  }
  const isTTY = input.isTTY === true;
  const wasRaw = isTTY ? input.isRaw === true : false;
  if (isTTY && input.setRawMode && input.isRaw !== true) input.setRawMode(true);

  const lineFor = (i: number): string => {
    const o = options[i]!;
    const marker = i === focus ? "❯" : " ";
    const desc = o.description ? ` ${DIM}${o.description}${RESET}` : "";
    const disabled = o.disabled ? ` ${DIM}（不可选）${RESET}` : "";
    return `${marker} ${o.label}${desc}${disabled}`;
  };
  let drawn = false;
  const render = (): void => {
    if (drawn) out.write(`\x1b[${n}A`); // 回到列表第一行
    for (let i = 0; i < n; i++) {
      out.write(`\r\x1b[2K${lineFor(i)}\n`);
    }
    drawn = true;
  };
  render();

  return await new Promise<T | undefined>((resolve) => {
    let pending = Buffer.alloc(0);
    let escTimer: NodeJS.Timeout | undefined;
    let done = false;
    const cleanup = (): void => {
      if (done) return;
      done = true;
      input.removeListener("data", onData);
      if (escTimer) clearTimeout(escTimer);
      if (isTTY && input.setRawMode && input.isRaw !== wasRaw) input.setRawMode(wasRaw);
      if (rl) {
        rl.resume();
        for (const h of lineHandlers) rl.on("line", h);
      }
    };
    const finish = (v: T | undefined): void => {
      cleanup();
      resolve(v);
    };
    const onData = (chunk: Buffer): void => {
      pending = Buffer.concat([pending, chunk]);
      if (escTimer) {
        clearTimeout(escTimer);
        escTimer = undefined;
      }
      const events = parseKeypress(pending);
      if (events === null) {
        // 裸 ESC：可能是 escape 也可能是方向键序列前缀——短等待兜底按 escape 取消
        escTimer = setTimeout(() => finish(undefined), 60);
        return;
      }
      pending = Buffer.alloc(0);
      for (const ev of events) {
        if (isPreviousKey(ev)) {
          focus = nextFocus(focus, -1, options);
          render();
        } else if (isNextKey(ev)) {
          focus = nextFocus(focus, 1, options);
          render();
        } else if (isAcceptKey(ev)) {
          finish(options[focus]!.value);
          return;
        } else if (isCancelKey(ev)) {
          finish(undefined);
          return;
        }
      }
    };
    input.on("data", onData);
    input.resume(); // 流流动（readline 已静音，无复吸）
  });
}
