import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 只跑主目录 tests/，避免误扫 `.claude/worktrees/` 里遗留旧 worktree 的测试副本
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", ".claude/**"],
  },
});
