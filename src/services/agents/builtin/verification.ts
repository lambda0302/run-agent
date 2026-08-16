/**
 * verification 子 agent（V7 决策 D，0.7.1）——对抗性验证专家。
 * 曾与 0.4.1 `verify` 工具并存（verify 是单文件基线，本类型是子 agent 级证据式验证）；
 * verify 工具已移除，验证全部走 run_bash 检查命令（构建/测试/lint/curl 采样）。
 *
 * D3 强制只读：工具集 = repo_map/glob/grep/read_file + run_bash（无 write/edit）。
 * 专门权限策略：readonly/local-exec/http-get bash 自动放行（构建/测试/lint/curl 采样，不弹窗）/
 * network·write·dangerous 与命令文本危险段 deny / 项目内写入 deny / /tmp 临时脚本放行。
 * D4 输出契约：每条 check 含 `Command run:` 证据；收尾字面量 `VERDICT: PASS|FAIL|PARTIAL`；
 * 解析器校验「PASS 但无命令证据」判拒（主 agent 据此重新委派）。
 */
import os from "node:os";
import path from "node:path";
import { homedir } from "node:os";
import type { PermissionCheckResult } from "../../../core/execute.js";
import type { Tool } from "../../../tools.js";
import {
  classifyBashCommand,
  DENY_BASH_SEGMENTS_RE,
  pathInCwd,
} from "../../../permissions/engine.js";

/** verification 工具集（无写工具；检查命令由 run_bash 专门权限策略放行）。 */
export const VERIFICATION_TOOL_NAMES = new Set([
  "repo_map",
  "glob",
  "grep",
  "read_file",
  "run_bash",
]);

/** 子 system：策略 + 强制步骤 + 反合理化 + 探针 + 证据契约（精简自蓝本 verificationAgent.ts）。 */
export const VERIFICATION_SYSTEM = `你是验证专家，职责不是确认实现能跑——而是**试图打破它**。

=== CRITICAL: 禁止改动项目 ===
严禁创建 / 修改 / 删除项目目录内任何文件，严禁安装依赖、严禁 git 写操作（add/commit/push）。
临时验证脚本只许写到临时目录（/tmp 或 $TMPDIR），用后清理。

=== 收到的输入 ===
原始任务描述 + 改动文件清单 + 实现方式（+ 可选计划文件路径）。

=== 按改动类型定策略 ===
- 前端：起 dev server → curl 采样页面子资源（/next/image 类优化 URL、同源 API、静态资源——HTML 可 200 而引用的资源全挂）→ 前端测试
- 后端 / API：起 server → curl 端点 → 校验**响应形状**而非仅状态码 → 错误处理 → 边界值
- 库 / 包：构建 → 全量测试 → 从全新上下文按消费者姿势 import 调公共 API → 类型 / README 示例核对
- 重构：既有测试**原样**通过 → diff 公共 API 表面（无新增/删除导出）→ 同输入同输出 spot-check
- 其他：模式恒定——(a) 想办法直接跑 / 调 / 触发这次改动；(b) 输出对照预期；(c) 用实现者没测的输入/条件试图打破它

=== 强制步骤（通用基线）===
1. 读项目 CLAUDE.md / README 拿构建测试命令，查 package.json / Makefile / pyproject.toml 的脚本名；有计划文件就读——那是成功标准
2. 构建（能构建则构建，坏了 = 自动 FAIL）
3. 跑项目测试（有则跑，挂了 = 自动 FAIL）
4. 跑 lint / 类型检查（eslint / tsc 等）
5. 查相关代码回归
测试套件结果是**上下文不是证据**——跑完记 pass/fail 继续做真正的验证；实现者也是 LLM，它的测试可能全是 mock / 循环断言 / happy path。

=== 反合理化清单 ===
-「代码看着对」→ 跑起来
-「实现者测试过了」→ 独立验证
-「大概没问题」→ 大概不等于验证，跑
-「没有浏览器 / 没有环境」→ 不许编"做不到"故事
-「太久了」→ 不是你的决定
发现自己在写解释而不是命令——停下来，跑命令。

=== 对抗探针（按改动类型挑）===
并发（并行请求 create-if-not-exists——重复会话？丢写？）/ 边界值（0、-1、空串、超长、unicode、MAX_INT）/ 幂等（同一变更请求两次）/ 孤儿操作（引用不存在的 ID）。
发 PASS 前至少一条探针及其结果——全是 200 / 测试通过 = 只确认了 happy path，不算验证。
发 FAIL 前核对：已有防御代码 / 有意行为（CLAUDE.md、注释说明）/ 不可行动（改不动外部契约的 bug 记为 observation 而非 FAIL）。

=== 输出契约（强制）===
每条 check 必须含：
### Check: <验证什么>
**Command run:**
  <实际执行的命令>
**Output observed:**
  <实际终端输出，粘贴勿转述；过长截断留关键部分>
**Result: PASS**（或 FAIL，带 Expected vs Actual）
无 Command run 块的 check 不是 PASS，是跳过——会被拒。

收尾精确一行（调用方解析）：
VERDICT: PASS
或
VERDICT: FAIL
或
VERDICT: PARTIAL

PARTIAL 仅限环境性限制（无测试框架 / 工具不可用 / server 起不来）；能跑就必须判 PASS 或 FAIL。
用字面量 \`VERDICT: \` + 恰好一个 \`PASS\` / \`FAIL\` / \`PARTIAL\`，无加粗、无标点、无变体。
FAIL 要含失败内容、确切的错误输出、复现步骤；PARTIAL 写明验证了什么、什么没验证（缺什么工具/环境）、实现者该知道什么。`;

/** 匹配 `>` / `>>` 后的写目标（剥引号；跳过 >&1 / >&2 这类 fd 重定向与纯数字目标）。 */
function bashWriteTargets(cmd: string): string[] {
  const out: string[] = [];
  const re = />>?\s*(?:"([^"]+)"|'([^']+)'|([^\s"'&|;]+))/g;
  for (const m of cmd.matchAll(re)) {
    const target = (m[1] ?? m[2] ?? m[3]) as string | undefined;
    if (!target) continue;
    if (/^&\d+$/.test(target) || /^\d+$/.test(target)) continue; // fd 重定向
    out.push(target);
  }
  return out;
}

function isTmpPath(p: string): boolean {
  // 命令里的 $TMPDIR/$TMP/$TEMP 前缀 → 临时目录
  if (/^\$(?:TMPDIR|TMP|TEMP)([\\/]|$)/i.test(p)) return true;
  // 原始形态的 POSIX /tmp 前缀（Windows 上 path.resolve 会转成盘符相对，需在 resolve 前判）
  if (/^\/tmp([\\/]|$)/.test(p)) return true;
  const abs = path.resolve(p.startsWith("~") ? path.join(homedir(), p.slice(1)) : p);
  const tmp = os.tmpdir();
  return abs === tmp || abs.startsWith(tmp + path.sep);
}

/**
 * verification 专门权限策略（D3）。
 * - run_bash：命令文本危险段（.run-agent/.git/.claude）deny；classify dangerous deny；
 *   readonly/local-exec/http-get 自动放行（构建/测试/lint + curl 采样页面，不弹窗）；
 *   network/write（git 拉推、装依赖、rm/sudo、重定向写项目文件）deny；
 *   写重定向项目内 deny、/tmp 放行、其余越界 deny
 * - write/edit 兜底 deny（工具集已无写工具，此为防御）
 * - 只读工具放行；未知工具保守 deny
 */
export function makeVerificationCheckPermission(
  cwd: string = process.cwd(),
): (tool: Tool, input: unknown) => Promise<PermissionCheckResult> {
  return async (tool, input): Promise<PermissionCheckResult> => {
    if (tool.name === "write_file" || tool.name === "edit_file") {
      return { decision: "deny", reason: "verification 只读，禁写项目文件" };
    }
    if (tool.name === "run_bash") {
      const cmd = (input as { command?: string } | undefined)?.command ?? "";
      // 读记忆/版本库元数据只能走工具的专属通道，不经 shell
      if (DENY_BASH_SEGMENTS_RE.test(cmd)) {
        return { decision: "deny", reason: "命令引用危险目录段（.run-agent/.git/.claude）" };
      }
      const danger = classifyBashCommand(cmd);
      if (danger === "dangerous") return { decision: "deny", reason: "危险命令，engine 硬底线" };
      if (danger !== "readonly" && danger !== "local-exec" && danger !== "http-get") {
        // write/network：允许临时目录重定向写（`echo y > $TMP/probe.sh` 临时脚本，D3），
        // 但禁项目内/越界写与破坏性命令（rm/sudo/装依赖/网络拉取等）
        let hasTarget = false;
        let allTmp = true;
        for (const t of bashWriteTargets(cmd)) {
          hasTarget = true;
          if (isTmpPath(t)) continue;
          allTmp = false;
          if (pathInCwd(t, cwd)) return { decision: "deny", reason: `禁写项目文件: ${t}` };
          return { decision: "deny", reason: `写目标越界: ${t}` };
        }
        if (hasTarget && allTmp) return { decision: "allow" }; // 全部写目标在 /tmp
        return {
          decision: "deny",
          reason: "非只读/检查命令（network/write）——verification 只跑 readonly/local-exec/http-get 检查命令",
        };
      }
      // readonly/local-exec/http-get 检查命令：写重定向仍查（`npm test > 项目文件`、`curl -o` 等）
      for (const t of bashWriteTargets(cmd)) {
        if (isTmpPath(t)) continue; // /tmp 临时脚本放行
        if (pathInCwd(t, cwd)) return { decision: "deny", reason: `禁写项目文件: ${t}` };
        return { decision: "deny", reason: `写目标越界: ${t}` };
      }
      return { decision: "allow" }; // 检查命令自动放行（构建/测试/lint/curl 采样不弹窗）
    }
    if (VERIFICATION_TOOL_NAMES.has(tool.name)) return { decision: "allow" };
    return { decision: "deny", reason: `verification 不可用工具: ${tool.name}` };
  };
}

export interface VerdictResult {
  verdict: "PASS" | "FAIL" | "PARTIAL" | undefined;
  /** 字面量合法（存在且无违规） */
  valid: boolean;
  issues: string[];
}

/**
 * 解析收尾 VERDICT 字面量（D4）。校验：
 * - 存在 VERDICT: PASS/FAIL/PARTIAL（取最后一个，忽略 markdown 包裹）
 * - PASS 必须有至少一条 Command run: 命令证据——缺证据的 PASS 判拒
 * 主 agent 依据返回：invalid → 回填告警重新委派；FAIL → 修后再委派。
 */
export function parseVerdict(reply: string): VerdictResult {
  const m = /VERDICT\s*:\s*(PASS|FAIL|PARTIAL)/.exec(reply ?? "");
  if (!m) {
    return { verdict: undefined, valid: false, issues: ["缺少 VERDICT: PASS/FAIL/PARTIAL 字面量"] };
  }
  const verdict = m[1] as "PASS" | "FAIL" | "PARTIAL";
  const issues: string[] = [];
  if (verdict === "PASS" && !/Command\s*run:/i.test(reply)) {
    issues.push("PASS 但无任何 Command run: 命令证据——缺证据的 PASS 判拒");
  }
  return { verdict, valid: issues.length === 0, issues };
}
