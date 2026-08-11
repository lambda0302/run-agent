# Bug 记录 · V0「项目地基」

> 阶段：2026-08-10 ｜ 交付：公开仓库 `lambda0302/run-agent` + 三 OS CI + CLI 空壳（版本 `0.0.0`，无 release）
> 来源：会话记录、git 提交历史。所有条目均已解决。

| #    | Bug                                                 | 类别      | 严重度 | 状态      |
| ---- | --------------------------------------------------- | --------- | ------ | --------- |
| V0-1 | tsup 产物命名与 `bin` 不匹配，装完找不到命令        | 构建/打包 | 高     | ✅ 已解决 |
| V0-2 | Anthropic 测试 mock 非单例，断言恒为 0 次调用       | 测试      | 中     | ✅ 已解决 |
| V0-3 | `npm ci` 全平台 `EINTEGRITY`（lockfile 指向镜像源） | 工程/CI   | 高     | ✅ 已解决 |
| V0-4 | 本地 `git push` 连不上代理且无凭据                  | 环境/运维 | 高     | ✅ 已解决 |
| V0-5 | Windows CRLF 换行破坏 lint/diff（预防）             | 跨平台    | 低     | ✅ 已预防 |

---

## V0-1 tsup 产物命名与 `bin` 不匹配

- **现象**：`npm run build` 后 `package.json` 的 `bin` 指向 `dist/cli.js`，但 tsup 按入口文件名把 `src/cli/index.ts` 输出成了 `dist/index.js` → `npm install -g` 后 `run-agent` 找不到入口。
- **根因**：tsup 默认用入口文件的**基名**命名产物；而 `bin` 写死的是 `dist/cli.js`。
- **修复**：改用 tsup 的 entry **对象语法**显式指定输出名：

  ```ts
  // tsup.config.ts
  export default defineConfig({
    entry: { cli: "src/cli/index.ts" }, // 显式命名 → dist/cli.js
    format: ["esm"],
    target: "node20",
    banner: { js: "#!/usr/bin/env node" },
  });
  ```

- **教训**：`bin` 字段与打包产物名必须显式对齐，别依赖 tsup 的默认命名。

## V0-2 Anthropic 测试 mock 非单例，断言恒为 0

- **现象**：`tests/providers/anthropic.test.ts` 断言 `createMock().messages.create` 被调用，结果恒为 `0 次调用`，测试红。
- **根因**：`vi.mock` 的工厂函数**每次调用都返回新实例**——源码里 `new Anthropic()` 拿到的对象，和测试里调用 `createMock()` 拿到的不是同一个对象，断言自然落空。
- **修复**：改为**单例** + `beforeEach` 清空调用记录（`vi.hoisted` 保证模块加载阶段就创建同一实例）。
- **教训**：`vi.mock` 工厂必须返回**同一个实例**；要断言"被调用过"就得让被 mock 对象全局唯一。

## V0-3 `npm ci` 全平台 EINTEGRITY（lockfile 指向镜像源）

- **现象**：GitHub Actions 三 OS × 全部 Node 版本都在 `npm ci` 一步失败，报 `EINTEGRITY`——确定性、与平台无关。
- **根因**：本机 npm 全局配置了 `registry=https://registry.npmmirror.com`（国内镜像），`npm install` 生成的 lockfile 里 248 条 `resolved` 都指向 npmmirror，其记录的 sha512 integrity 与实际 tarball 不符 → CI 和任何用户机器按 lockfile 下载全部校验失败。
- **修复**：
  1. 用官方 `registry.npmjs.org` **重新生成 lockfile**（248 条 `resolved` + integrity 全部重写，版本锁定保留）→ `npm ci` 本地通过（175 packages，exit 0）；
  2. 清空 `~/.npmrc` 里的镜像配置，让将来新装的依赖也写官方源，从根上消除复发。
- **教训**：提交 lockfile 前必须确认 `resolved` 指向官方 registry；公共项目任何 CI 和用户都会受本机镜像污染拖累。

## V0-4 本地 `git push` 连不上代理且无凭据

- **现象**：`git push` 失败，报错连不上 `127.0.0.1:7890`（Clash 类本地代理端口，当时未运行）；GitHub MCP 却能正常连。
- **根因**：**全局 git config 配置了 `http.proxy = 127.0.0.1:7890`**，代理进程没开 → push 走代理必然失败；且 `--global` 作用域看不到任何 credential helper，误判"无凭据"。
- **修复**：禁用代理后重试；关键发现是**系统级 gitconfig 已有 `credential.helper = manager`（GCM 已生效）**——之前只查了 `--global` 作用域。最终走 GCM 认证完成正式 push。
- **教训**：排查 git 凭据/代理要看**所有作用域**（`--system` / `--global` / `--local`），不能只看 `--global`；本机代理未运行时先测直连。

## V0-5 Windows CRLF 换行破坏 lint/diff（预防）

- **现象**：Windows 上 git 默认把文件检出为 CRLF，ESLint/Prettier 对换行敏感时会在 Windows 上炸、diff 噪音大（公共项目三 OS 是硬约束）。
- **修复**：`V0` 就提交 `.gitattributes` 强制 LF 归一化（`*.ts text eol=lf` 等），配合 CI 三 OS matrix 兜底。
- **教训**：Windows 换行是公共项目的经典坑，`.gitattributes` 要在一开始就位，别等 CI 红再补。

---

## 小结

V0 作为地基阶段，bug 集中在**工程/构建/环境**三块，没有业务逻辑 bug。最值钱的两条经验是 **lockfile 必须指向官方源**（V0-3，影响所有后续 CI）和 **`bin` 与产物名对齐**（V0-1）。V0 也为 V1 预留了接口（`LLMMessage` / `LLMClient`），接口层面未返工。
