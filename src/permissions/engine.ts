/**
 * V3 权限判定引擎（零依赖，纯函数）。
 * 判定顺序（V4.5 决策 D，bypass 删除后；V5 决策 A1 加 plan 分支、B3 加 mcp_connect 免确认）：
 *   内置危险命令 → plan 分支（强制只读）→ 导航工具（enter/exit_plan_mode / mcp_connect 免确认）
 *   → 用户 deny → 专属通道 → 危险目录 → bash 正则 → 用户 allow → 白名单(cwd) → 兜底 ask。
 * 对齐 Claude Code 的 hasPermissionsToUseTool 混合模型，但更保守：公开项目误拦比漏拦安全。
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Decision, PermissionMode, PermissionRule } from "./types.js";

/** 内置危险目录段（小写化后逐段比较，V4.5 决策 C）：cwd 内敏感/易被利用的目录，工具一律不可读写。
 *  `.git`/`.claude` 是版本库/配置元数据；`.run-agent` 是 agent 自身目录（写全禁 + 读仅 memory 专属通道）。
 *  内置底线不可被用户规则解除。 */
const DENY_DIR_SEGMENTS = new Set([".git", ".claude", ".run-agent"]);

/**
 * run_bash 的命令文本里引用 `.run-agent` 段 → 同样收口（agent 自身目录对模型完全只读）。
 * 只收 `.run-agent`：不收 `.git`（git 命令文本里大量合法出现，如 `git log`、`.gitignore`）、`.claude`。
 * 前缀约束避免误伤普通文本里的 "run-agent"；后缀排除 `.run-agent-backup` 这类相似目录名。
 * 定位：第二道防线（尽力而为，不承诺穷尽 shell 拼接绕过——见 Plan_V4.5 决策 E 4）。
 */
const AGENT_DIR_BASH_RE = /(?<=^|[\s\\/'"`=(;|&])\.run-agent(?![\w-])/;

/** 只读工具：default 模式下免确认。repo_map 为 0.4.1 只读定位工具。 */
const READ_ONLY_TOOLS = new Set(["read_file", "glob", "grep", "repo_map"]);

/** 内置只读判定（V5 决策 B4）：hasPermissionsToUseTool 第 7 参 readOnlyNames 的缺省值。
 *  REPL 装配时并入 explore（只读探索子 agent）与 MCP 只读 hint 名，见 repl.ts。 */
export function isBuiltinReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(name);
}

/**
 * 记忆目录读专属通道（V4 决策 A / V4.5 决策 C）：Trust 会话内，三个只读工具对
 * `.run-agent/memory/**` 放行——这是「索引 → 按需 read/grep 读记忆」的前提。
 * 其余 `.run-agent` 路径与 write_file/edit_file/run_bash 照旧 deny；未 Trust 会话豁免不生效。
 * 判定在危险目录段 deny（决策 D 第 4 步）之前放行，否则 memory 在 `.run-agent` 下先被拦掉
 * （对齐 Claude Code "internal-path carve-out MUST come before the dangerous-directory check"）。
 * 独立纯函数（签名 tool,path,isTrusted），V4.5 只并入统一判定顺序，不重写逻辑。
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

/** 危险命令：命中即内置 deny（覆盖 `rm -rf` 根目录、格式化、强推、发布包、关机重启等）。
 *  bypass 删除后成为最高级、任何规则/模式不可解除的保护。 */
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

/** 从工具入参中取"目标路径"（file_path / path / cwd），展开 `~` 后 resolve 为绝对路径。 */
export function inputPath(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  const p = o.file_path ?? o.path ?? o.cwd;
  if (typeof p === "string" && p.trim()) {
    const trimmed = p.trim();
    return path.resolve(trimmed.startsWith("~") ? path.join(homedir(), trimmed.slice(1)) : trimmed);
  }
  return undefined;
}

function bashCommand(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const c = (input as Record<string, unknown>).command;
  return typeof c === "string" ? c : undefined;
}

/**
 * realpath 双形态（决策 E 1）：[expand+resolve 后, realpath 后]。
 * 先整路径 realpath（捕捉文件级/目录级 symlink）；最终组件尚不存在（新建文件等）导致整路径
 * 解析失败时，回退「realpath 父目录 + basename」——防 `alias → .run-agent` 这类 symlink 目录别名
 * 在写新文件时逃过整路径解析；连父目录都不可解析才保持原样形态（无法解析，按字面处理）。
 */
function pathForms(p: string): [string, string] {
  const expanded = p.startsWith("~") ? path.join(homedir(), p.slice(1)) : p;
  const resolved = path.resolve(expanded);
  let real = resolved;
  try {
    real = realpathSync(resolved);
  } catch {
    try {
      real = path.join(realpathSync(path.dirname(resolved)), path.basename(resolved));
    } catch {
      // 父目录也不存在 → 保持原样形态
    }
  }
  return [resolved, real];
}

/** 危险目录段判定（决策 E 2）：段小写化比较，全平台统一（NTFS/APFS 卷均可被挂载到 Linux/macOS，
 *  故不分平台，一律小写）。任一形态命中 DENY_DIR_SEGMENTS → 是。 */
function hasDeniedDirSegment(p: string): boolean {
  return p.split(/[\\/]/).some((s) => DENY_DIR_SEGMENTS.has(s.toLowerCase()));
}

/**
 * Windows 路径模式检测 → ask（决策 E 3，全平台跑，NTFS 可被挂载到 Linux/macOS）。
 * 命中即 ask（不归一化）：NTFS ADS、8.3 短名、长路径前缀、尾随点/空格、DOS 设备名、三连点、UNC。
 * 误伤成本 = 多一次人工确认，设计为 ask 而非 deny。
 */
export function hasSuspiciousPathPattern(p: string): boolean {
  const s = p.replace(/\\/g, "/");
  // UNC（\\server 或 //server）与长路径前缀（\\?\、\\.\、//?/、//./）
  if (/^\/\//.test(s)) return true;
  // NTFS ADS：盘符冒号（index 1）之后还有冒号；无盘符路径里出现冒号也保守 ask
  if (/^[A-Za-z]:/.test(p) ? p.slice(2).includes(":") : p.includes(":")) return true;
  // 8.3 短名：段内 ~ 后跟数字（PROGRA~1）
  if (/~\d/.test(s)) return true;
  const segments = s.split("/");
  for (const seg of segments) {
    if (seg === "." || seg === "..") continue;
    // 尾随点/空格
    if (/[. ]$/.test(seg)) return true;
    // 三个以上连续点
    if (/\.{3,}/.test(seg)) return true;
    // DOS 设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9，含扩展名如 CON.txt）
    const base = seg.split(".")[0] ?? "";
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(base)) return true;
  }
  return false;
}

/**
 * 路径是否在 cwd 内（决策 B 白名单，realpath 双形态 + 对称 resolve）。
 * 两个形态(expand+resolve 后 / realpath 后)都必须落在 cwd 的某个形态内，才判为 cwd 内；
 * 任一形态越界 → 视为 cwd 外。防 symlink 换名逃逸（foo → .run-agent/x、foo → /etc/passwd），
 * 并兼容 macOS /var→/private/var 之类的系统 symlink（两侧都 resolve 后比较）。
 */
export function pathInCwd(p: string, cwd: string): boolean {
  const cwdForms = pathForms(cwd);
  for (const form of pathForms(p)) {
    const inside = cwdForms.some(
      (cf) => form === cf || form.startsWith(cf.endsWith(path.sep) ? cf : cf + path.sep),
    );
    if (!inside) return false;
  }
  return true;
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

/**
 * 可疑路径模式检查的「用户输入视角」版本（V4.5-9 修复）：
 * 只对「cwd 之外的部分」做 hasSuspiciousPathPattern 检查。cwd 自身可能合法地位于含
 * 8.3 短名/其它 Windows 模式的路径下——如 GitHub Actions Windows runner 的 os.tmpdir()
 * 落在 `...\RUNNER~1\...`（Vitest 工作目录建在其下），若对整个解析后形态检查，cwd 内
 * 一切访问都会被误判 ask（决策 E 本来就是保守 ask，误伤面被环境路径放大）。
 * cwd 内 → 只查相对部分（用户输入）；cwd 外（含 symlink 换名逃逸的 real 形态）→ 全路径，
 * 逃逸路径的短名/设备名仍会被拦下。
 */
function suspiciousOutsideCwd(p: string, cwd: string): boolean {
  for (const cf of pathForms(cwd)) {
    const withSep = cf.endsWith(path.sep) ? cf : cf + path.sep;
    if (p === cf) return false; // 路径恰为 cwd → 无用户输入部分
    if (p.startsWith(withSep)) return hasSuspiciousPathPattern(p.slice(withSep.length));
  }
  return hasSuspiciousPathPattern(p);
}

/**
 * 规则匹配。path 维度对两个形态各查一遍（任一形态命中即算匹配——用户规则与内置底线同样按
 * realpath 双形态执行，决策 E 1）；command 维度作用于 run_bash。
 */
function ruleMatches(
  rule: PermissionRule,
  tool: string,
  input: unknown,
  forms?: [string, string],
): boolean {
  if (rule.tool && rule.tool !== "*" && rule.tool !== tool) return false;
  if (rule.path) {
    if (!forms) return false;
    const rulePath = rule.path; // 先捕获再进闭包（属性访问在闭包内不被 TS 窄化）
    if (!forms.some((f) => pathMatchesGlob(f, rulePath))) return false;
  }
  if (rule.command) {
    const cmd = bashCommand(input);
    if (!cmd || !new RegExp(rule.command).test(cmd)) return false;
  }
  return true;
}

/**
 * 判定一次工具调用是否允许。纯函数：ask 的处理（确认/降级）在 prompt 层，不在此。
 * 判定顺序（决策 D）：
 *   1. 内置危险命令（run_bash → DANGEROUS_PATTERNS）→ deny（最高级，任何规则/模式不可覆盖）
 *   2. 用户 deny 规则 → deny（用户显式 deny 优先于一切内置放行）
 *   3. 专属通道：isMemoryReadExempt（只读 × .run-agent/memory/** × Trust）→ allow
 *   4. 危险目录段（.git/.claude/.run-agent，未豁免）→ deny（内置，规则不可覆盖）
 *   5. run_bash AGENT_DIR_BASH_RE → deny（第二道防线，尽力而为）
 *   6. 用户 allow 规则 → allow（cwd 外访问的唯一授权通道；对 cwd 内保留"始终允许"语义）
 *   7. 白名单 + 模式兜底：run_bash 一律 ask；Windows 可疑路径 → ask；无路径工具按 V2 语义；
 *      路径在 cwd 内 → 只读 allow / acceptEdits 写 allow / default 写 ask；cwd 外 → 只读也 ask
 * @param isTrusted 记忆读豁免的 Trust 门控；缺省 false（未传 = 无豁免）。
 * @param cwd 工作目录白名单边界；缺省 process.cwd()。
 */
export function hasPermissionsToUseTool(
  tool: string,
  input: unknown,
  mode: PermissionMode,
  rules: PermissionRule[],
  isTrusted = false,
  cwd = process.cwd(),
  readOnlyNames: (name: string) => boolean = isBuiltinReadOnlyTool,
): Decision {
  // 1. 内置危险命令
  if (tool === "run_bash" && classifyBashCommand(bashCommand(input) ?? "") === "dangerous") {
    return "deny";
  }

  const p = inputPath(input);
  const forms = p ? pathForms(p) : undefined;

  // V5 决策 A1：plan 分支（在危险命令检查后、其余判定前——plan 是最高优先级的一档状态，
  // 写/执行一律 deny，不受用户模式影响）。判定顺序见文件头注释。
  if (mode === "plan") {
    // enter_plan_mode 放行（它自身处理「已在 plan 中」报错）
    if (tool === "enter_plan_mode") return "allow";
    // exit_plan_mode 返回 ask：engine 放行工具本身，用户审批由 repl 的 ask 弹窗负责
    if (tool === "exit_plan_mode") return "ask";
    // 只读探索（readOnlyNames 覆盖内置只读 + explore + MCP 只读 hint）：
    //   无路径入参（explore/repo_map）→ allow；cwd 内 / 记忆读豁免 → allow；cwd 外 → ask
    if (readOnlyNames(tool)) {
      if (!p) return "allow";
      if (forms && forms.every((f) => isMemoryReadExempt(tool, f, isTrusted))) return "allow";
      if (pathInCwd(p, cwd)) return "allow";
      return "ask";
    }
    // 其余（写类 / run_bash / verify / remember / MCP 非只读）→ deny
    return "deny";
  }

  // 导航工具（非 plan 模式）：模式切换免权限确认；「不在 plan 模式」的报错语义在工具层。
  // mcp_connect 同样免确认（V5 决策 B3：用户写好配置 = 已授权；项目级配置仅 Trust 加载是第二道门）。
  if (tool === "enter_plan_mode" || tool === "exit_plan_mode" || tool === "mcp_connect")
    return "allow";

  // 2. 用户 deny 规则（优先于一切内置放行）
  for (const rule of rules) {
    if (rule.action === "deny" && ruleMatches(rule, tool, input, forms)) return "deny";
  }

  // 3. 专属通道：记忆读豁免。所有形态都必须是记忆目录才算豁免
  //    （防 `.run-agent/memory/out` → `/etc/passwd` 这类 symlink 指向记忆外的换名逃逸）。
  if (forms && forms.every((f) => isMemoryReadExempt(tool, f, isTrusted))) {
    return "allow";
  }

  // 4. 危险目录段（小写化比较，任一形态命中即 deny）
  if (forms && forms.some(hasDeniedDirSegment)) {
    return "deny";
  }

  // 5. run_bash 命令文本引用 `.run-agent`
  if (tool === "run_bash" && AGENT_DIR_BASH_RE.test(bashCommand(input) ?? "")) {
    return "deny";
  }

  // 6. 用户 allow 规则（cwd 外唯一授权通道；也可显式放行 run_bash 等）
  for (const rule of rules) {
    if (rule.action === "allow" && ruleMatches(rule, tool, input, forms)) return "allow";
  }

  // 7. 白名单 + 模式兜底
  if (tool === "run_bash") return "ask";
  if (p && forms && forms.some((f) => suspiciousOutsideCwd(f, cwd))) return "ask";
  if (!p) {
    // 无路径入参的工具（repo_map/explore/verify/remember/glob 无 path 等）：不参与 cwd 边界
    if (mode === "acceptEdits") return "allow";
    if (READ_ONLY_TOOLS.has(tool)) return "allow";
    return "ask";
  }
  if (pathInCwd(p, cwd)) {
    if (READ_ONLY_TOOLS.has(tool)) return "allow";
    if (mode === "acceptEdits") return "allow";
    return "ask";
  }
  // cwd 外：只读工具也 ask（修缺口 ④）；one-shot canPrompt=false 时由 prompt 层降级 deny
  return "ask";
}
