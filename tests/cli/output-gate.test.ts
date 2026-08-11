/**
 * 0.5.1 显示修复测试：输出缓冲门 createOutputGate + createHandlers 装配。
 * 复现场景：权限弹窗（rl.question）激活期间，弹窗前已入队的后台并行工具完成 →
 * onToolResult 触发。没有门时结果直接打印在 y/n 提示行上（显示交错，看起来像"卡住"）；
 * 有门时缓冲，弹窗结束后按序刷出。
 */
import { describe, expect, it } from "vitest";
import { createHandlers, createOutputGate } from "../../src/cli/repl.js";

/** 收集写内容的假流。 */
function collectingOut() {
  const chunks: string[] = [];
  return {
    out: { write: (s: string) => void chunks.push(s) } as unknown as NodeJS.WritableStream,
    chunks: () => chunks,
  };
}

describe("createOutputGate（0.5.1 权限弹窗输出缓冲）", () => {
  it("未 begin 时直写；begin 后缓冲；end 按序刷出并恢复直写", () => {
    const { out, chunks } = collectingOut();
    const gate = createOutputGate(out);

    gate.emit("a"); // 未开门 → 直写
    expect(chunks()).toEqual(["a"]);

    gate.begin();
    gate.emit("b");
    gate.emit("c");
    expect(chunks()).toEqual(["a"]); // 弹窗期间缓冲，不落盘

    gate.end();
    expect(chunks()).toEqual(["a", "b", "c"]); // 按序刷出

    gate.emit("d"); // 关门后恢复直写
    expect(chunks()).toEqual(["a", "b", "c", "d"]);
  });

  it("begin 后无输出，end 为 no-op 不崩", () => {
    const { out, chunks } = collectingOut();
    const gate = createOutputGate(out);
    gate.begin();
    gate.end();
    expect(chunks()).toEqual([]);
  });

  it("经 createHandlers 装配：弹窗期间后台 onToolResult 缓冲、结束后才打印（修复显示交错）", () => {
    const { out, chunks } = collectingOut();
    const gate = createOutputGate(out);
    const handlers = createHandlers(gate.emit);

    // 弹窗开始：后台并行工具完成触发 onToolResult + onText
    gate.begin();
    handlers.onToolResult("read_file", "读取失败: 文件不存在");
    handlers.onText("正在等待你的确认…");
    expect(chunks()).toEqual([]); // 弹窗期间全缓冲

    gate.end();
    const joined = chunks().join("");
    expect(joined).toContain("└ read_file"); // 结果行带 └ 前缀，顺序与完成一致
    expect(joined).toContain("正在等待你的确认…");
  });

  it("onToolCall 正常直写（弹窗前已打印 ⚡，不属于污染源）", () => {
    const { out, chunks } = collectingOut();
    const gate = createOutputGate(out);
    const handlers = createHandlers(gate.emit);
    handlers.onToolCall("write_file", { file_path: "a.ts" });
    expect(chunks().join("")).toContain("⚡ write_file");
  });
});
