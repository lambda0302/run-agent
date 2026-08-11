import tseslint from "typescript-eslint";

export default tseslint.config(
  // 全局 ignore：本地遗留 worktree（.claude/worktrees/*）与构建产物不参与 lint
  { ignores: ["dist/**", "node_modules/**", ".claude/**"] },
  {
    files: ["**/*.ts"],
    extends: [...tseslint.configs.recommended],
  },
);
