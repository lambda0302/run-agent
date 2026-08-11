/**
 * V2 权限判定引擎（零依赖，纯函数）。
 * 逐级短路：bypass → 内置安全底线 → 用户规则（首条命中） → 按 mode 兜底。
 * 对齐 Claude Code 的 hasPermissionsToUseTool 思想，但要更保守：公开项目误拦比漏拦安全。
 */
import path from "node:path";
import type { Decision, PermissionMode, PermissionRule } from "./types.js";

/** 内置 deny 路径段（规范化后逐段比较）：版本库元数据与 agent 自身目录一律不可读写。 */
const DENY_DIR_SEGMENTS = new Set([".git", ".claude", ".run-agent"]);

/**
 * run_bash 的命令文本里引用 `.run-agent` 段 → 同样收口（agent 自身目录对模型完全只读）。
 * 只收 `.run-agent`：不收 `.git`（git 命令文本里大量合法出现，如 `git log`、`.gitignore`）、`.claude`。
 * 前缀约束避免误伤普通文本里的 "run-agent"；后缀排除 `.run-agent-backup` 这类相似目录名。
 */
const AGENT_DIR_BASH_RE = /(?<=^|[\s\\/'"`=(;|&])\.run-agent(?![\w-])/;

/** 只读工具：default 模式下免确认。repo_map 为 0.4.1 只读定位工具（决策 D）。 */
const READ_ONLY_TOOLS = new Set(["read_file", "glob", "grep", "repo_map"]);

/**
 * 记忆目录读豁免（V4 决策 A）：Trust 会话内，三个只读工具对 `.run-agent/memory/**` 放行——
 * 这是「索引 → 按需 read/grep 读记忆」的前提。判定在 deniedByDefault 内置 deny 之前。
 * 其余 `.run-agent` 路径与 write_file/edit_file/run_bash 照旧 deny；未 Trust 会话豁免不生效。
 * 独立纯函数（签名 tool,path,isTrusted），V4.5 并入专属通道时纯移动不重写（见 Plan_V4.md 决策 A 实施指引）。
 */
export function isMemoryReadExempt(tool: string, target: string, isTrusted: boolean): boolean {
  if (!isTrusted) return false;
  if (!READ_ONLY_TOOLS.has(tool)) return false;
  const segments = path.resolve(target).split(/[\\/]/);
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i] === ".run-agent" && segments[i + 1] === "memory") return true;
  }
  return false;
}

export type BashDanger = "safe" | "risky" | "dangerous";

/** 危险命令：命中即内置 deny（覆盖 `rm -rf` 根目录、格式化、强推、发布包、关机重启等）。 */
const DANGEROUS_PATTERNS: RegExp[] = [
  // 注意：目标以 / 或 ~ 开头即命中；不接 \b，否则 "rm -rf /" / "rm -rf ~"（目标在串尾）会漏掉
  /^\s*rm\s+(?:-[a-z]*[rR][a-z]*\s+)?(\/|~)/i,
  // sudo 前缀的根删除（"sudo rm -rf /var" 等）同样危险
  /\bsudo\b.*\brm\s+(?:-[a-z]*[rR][a-z]*\s+)?(\/|~)/i,
  /\b(mkfs|fdisk|mkswap|format)\b/i,
  /\bdd\b.*\bof=(\/dev|\/etc|\/var)\b/i,
  /git\s+push\b.*(--force\b|-[a-z]*f\b)/i,
  /\b(npm|pnpm|yarn)\s+(publish|prune)\b/i,
  /^\s*(shutdown|reboot|halt|poweroff)\b/i,
];

/** 风险命令：default/acceptEdits 下 ask（具体路径删除、sudo、curl|sh、重定向写系统目录、hard reset）。 */
const RISKY_PATTERNS: RegExp[] = [
  /\brm\b.*(-[a-z]*[rfF][a-z]*|-[a-z]*[rfF])\b/i,
  /\bsudo\b/i,
  /(^|[;&|]\s*)(curl|wget)\b.*\s\|\s*(?:sh|bash)\b/i,
  />>?\s+(\/etc|\/var|\/bin|\/usr|\/boot)\//i,
  // 不接尾部 \b：否则 "git checkout ."（点在串尾）会漏掉
  /\b(git\s+reset\s+--hard|git\s+checkout\s+\.)/i,
];

/**
 * 语义化分类 bash 命令。规则保守：拿不准就往上调一档（risky），宁 ask 勿漏。
 * 只识别字符串模式；PowerShell 语法（Remove-Item 等）走 RISKY 之外的正则未命中时按 safe 处理，
 * 由用户规则收口（见 Plan_V2 §6.4）。
 */
export function classifyBashCommand(cmd: string): BashDanger {
  if (DANGEROUS_PATTERNS.some((re) => re.test(cmd))) return "dangerous";
  if (RISKY_PATTERNS.some((re) => re.test(cmd))) return "risky";
  return "safe";
}

/** 从工具入参中取"目标路径"（file_path / path / cwd），用于路径规则与内置底线匹配。 */
export function inputPath(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  const p = o.file_path ?? o.path ?? o.cwd;
  if (typeof p === "string" && p.trim()) return path.resolve(p);
  return undefined;
}

function bashCommand(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const c = (input as Record<string, unknown>).command;
  return typeof c === "string" ? c : undefined;
}

/** 极简 glob → 正则：支持 * / ** / ?，匹配时把反斜杠归一为斜杠。 */
export function pathMatchesGlob(p: string, glob: string): boolean {
  const g = glob.replace(/\\/g, "/");
  const target = p.replace(/\\/g, "/");
  let re = "";
  let i = 0;
  while (i < g.length) {
    const c = g[i]!;
    if (c === "*") {
      if (g[i + 1] === "*") {
        // `**/` = 零级或多级目录：既可命中 `a.ts`，也可命中 `deep/a.ts`
        if (g[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${re}$`).test(target);
}

function ruleMatches(rule: PermissionRule, tool: string, input: unknown): boolean {
  if (rule.tool && rule.tool !== "*" && rule.tool !== tool) return false;
  if (rule.path) {
    const p = inputPath(input);
    if (!p || !pathMatchesGlob(p, rule.path)) return false;
  }
  if (rule.command) {
    const cmd = bashCommand(input);
    if (!cmd || !new RegExp(rule.command).test(cmd)) return false;
  }
  return true;
}

function deniedByDefault(tool: string, input: unknown): boolean {
  const p = inputPath(input);
  if (p) {
    const segments = p.split(/[\\/]/);
    if (segments.some((s) => DENY_DIR_SEGMENTS.has(s))) return true;
  }
  if (tool === "run_bash") {
    const cmd = bashCommand(input) ?? "";
    if (classifyBashCommand(cmd) === "dangerous") return true;
    if (AGENT_DIR_BASH_RE.test(cmd)) return true; // 引用 agent 自身记忆目录，同样收口
  }
  return false;
}

/**
 * 判定一次工具调用是否允许。纯函数：ask 的处理（确认/降级）在 prompt 层，不在此。
 * @param isTrusted 记忆读豁免的 Trust 门控；缺省 false（未传 = 无豁免，保持既有行为）。
 */
export function hasPermissionsToUseTool(
  tool: string,
  input: unknown,
  mode: PermissionMode,
  rules: PermissionRule[],
  isTrusted = false,
): Decision {
  if (mode === "bypass") return "allow";
  const p = inputPath(input);
  if (p && isMemoryReadExempt(tool, p, isTrusted)) {
    // 记忆读豁免命中：跳过内置 deny，继续走用户规则与模式兜底
  } else if (deniedByDefault(tool, input)) {
    return "deny";
  }

  for (const rule of rules) {
    if (ruleMatches(rule, tool, input)) return rule.action;
  }

  // 兜底：bash 一律 ask（safe 也问，符合"命令执行需确认"的安全模型）；只读工具 allow；写/改 ask。
  if (tool === "run_bash") return "ask";
  if (mode === "acceptEdits") return "allow";
  if (READ_ONLY_TOOLS.has(tool)) return "allow";
  return "ask";
}
