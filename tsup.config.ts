import { defineConfig } from "tsup";

export default defineConfig({
  // 对象形式指定产物名：src/cli/index.ts -> dist/cli.js（与 package.json 的 bin 一致）
  entry: { cli: "src/cli/index.ts" },
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  sourcemap: true,
  clean: true,
  // 运行时依赖不打包进产物，由 npm install 提供
  // （tsup 默认将 package.json 的 dependencies 视为 external）
  banner: { js: "#!/usr/bin/env node" },
});
