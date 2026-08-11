import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 只跑主目录 tests/，避免误扫 `.claude/worktrees/` 里遗留旧 worktree 的测试副本
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", ".claude/**"],
    // git 类测试（gitInitRepo 四步 execFileSync + buildRepoMap 的 git 调用）在并行 + Windows 下
    // 单测经常超过 vitest 默认 5s 超时；提高上限避免 CI 上的偶发超时
    testTimeout: 30_000,
  },
});
