import tseslint from "typescript-eslint";

export default tseslint.config({
  files: ["**/*.ts"],
  ignores: ["dist/**", "node_modules/**"],
  extends: [...tseslint.configs.recommended],
});
