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
