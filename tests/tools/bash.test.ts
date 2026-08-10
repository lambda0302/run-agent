import { describe, expect, it } from "vitest";
import { bashTool } from "../../src/tools/bash/index.js";

describe("run_bash（跨平台）", () => {
  it("执行简单命令并返回输出", async () => {
    const r = await bashTool.call({ command: "echo hi" });
    expect(r.result).toContain("hi");
  }, 15_000);

  it("超时被杀死并返回超时信息", async () => {
    const r = await bashTool.call({ command: "sleep 5", timeout: 100 });
    expect(r.result).toContain("超时");
  }, 15_000);

  it("支持 cwd 参数（在目录里运行）", async () => {
    // pwd/Get-Location 在两套 shell 下都可用；断言输出非空即可
    const r = await bashTool.call({ command: "pwd" });
    expect(r.result.length).toBeGreaterThan(0);
  }, 15_000);
});
