/**
 * V8 决策 I2：系统编辑器（"编辑后批准"）。
 * 选择链：$EDITOR > $VISUAL > Windows notepad 兜底；均不可用返回 undefined。
 * 打开文件等待编辑器关闭，然后读回内容——调用方（resolveAsk）负责与编辑前快照比对，
 * 判断计划是否被用户改过（planWasEdited）。
 * 编辑器命令经 shell 拆分（$EDITOR 可含参数，如 "code --wait"）；阻塞等待 + 超时兜底
 * （编辑器被杀/挂起 10 分钟 → 放弃编辑，返回 undefined）。
 * 测试注入 fake（resolveAsk 的 openEditor 参数），CI 不依赖真实编辑器。
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";

const EDITOR_TIMEOUT_MS = 10 * 60 * 1000;

/** 用系统编辑器打开 filePath，等编辑器关闭后读回文件内容。
 *  @returns 编辑后的完整内容；编辑器不可用 / 取消 / 被杀 / 超时 / 读失败 → undefined。 */
export function openSystemEditor(filePath: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const editor = process.env.EDITOR || process.env.VISUAL;
    let child: ChildProcess | undefined;
    if (editor) {
      // shell:true 让 $EDITOR 支持 "code --wait" 这类含参数的命令（拆分命令与参数）
      child = spawn(editor, [filePath], { stdio: "inherit", shell: true, windowsHide: true });
    } else if (process.platform === "win32") {
      // Windows 无 $EDITOR：notepad 兜底。notepad 是 GUI 单例，直接 spawn 不阻塞；
      // 用 `start /wait` 在 cmd 内等待窗口关闭再返回。`""` 是 start 的窗口标题占位。
      child = spawn("cmd", ["/c", `start /wait "" notepad "${filePath}"`], {
        windowsHide: true,
      });
    } else {
      resolve(undefined); // 无编辑器可用 → 放弃编辑
      return;
    }

    let settled = false;
    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child?.kill(); // 超时：杀编辑器，按放弃编辑处理
      finish(undefined);
    }, EDITOR_TIMEOUT_MS);

    child.on("error", () => finish(undefined));
    child.on("close", () => {
      let content: string | undefined;
      try {
        content = readFileSync(filePath, "utf8");
      } catch {
        content = undefined; // 编辑器可能删了文件 / 不可读
      }
      finish(content);
    });
  });
}
