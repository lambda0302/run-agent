import { describe, expect, it } from "vitest";
import { isPromptTooLong, RunAgentError } from "../../src/utils/errors.js";

describe("isPromptTooLong（0.3.1 反应式压缩触发条件）", () => {
  it("anthropic 形态：error.type=prompt_too_long", () => {
    const e = Object.assign(new Error("messages: prompt is too long"), {
      status: 400,
      error: { type: "prompt_too_long", message: "..." },
    });
    expect(isPromptTooLong(e)).toBe(true);
  });

  it("openai 形态：code=context_length_exceeded", () => {
    const e = Object.assign(new Error("This model's maximum context length is 128000 tokens."), {
      status: 400,
      code: "context_length_exceeded",
    });
    expect(isPromptTooLong(e)).toBe(true);
  });

  it("嵌套 error.code 形态", () => {
    const e = Object.assign(new Error("context too long"), {
      error: { code: "context_length_exceeded" },
    });
    expect(isPromptTooLong(e)).toBe(true);
  });

  it("纯文本正则兜底", () => {
    expect(isPromptTooLong(new Error("request failed: prompt is too long"))).toBe(true);
    expect(isPromptTooLong(new Error("Maximum context length exceeded"))).toBe(true);
  });

  it("非超长错误 / 非 Error 值 → false", () => {
    expect(isPromptTooLong(new Error("bad request"))).toBe(false);
    expect(isPromptTooLong(Object.assign(new Error("boom"), { status: 400 }))).toBe(false);
    expect(isPromptTooLong(null)).toBe(false);
    expect(isPromptTooLong({ message: "prompt is too long" })).toBe(false); // 非 Error 实例
  });

  it("RunAgentError 不误判", () => {
    expect(isPromptTooLong(new RunAgentError("没有可续接的会话"))).toBe(false);
  });
});
