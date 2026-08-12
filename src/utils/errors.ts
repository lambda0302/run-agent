/** V7 决策 C3：是否外部 abort（TaskStop 传播的 AbortError）。
 * 识别 DOMException / 自定义 name === 'AbortError'（与 isPromptTooLong 同为错误分类，
 * 但优先级更高：abort 直接结束，不重试、不进反应式压缩）。 */
export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

/** 基础错误类：CLI 层捕获后统一转成退出码与 stderr 输出。 */
export class RunAgentError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "RunAgentError";
  }
}

/**
 * 是否「上下文超长」错误（0.3.1 反应式压缩触发条件）。
 * 识别：anthropic `error.type=prompt_too_long` / openai `code=context_length_exceeded` /
 * 消息文本正则兜底。
 */
export function isPromptTooLong(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const anyE = e as { type?: unknown; code?: unknown; error?: { type?: unknown; code?: unknown } };
  if (anyE.type === "prompt_too_long" || anyE.error?.type === "prompt_too_long") return true;
  if (anyE.code === "context_length_exceeded" || anyE.error?.code === "context_length_exceeded") {
    return true;
  }
  return /prompt is too long|maximum context length|context_length_exceeded|prompt_too_long|too many tokens/i.test(
    e.message,
  );
}
