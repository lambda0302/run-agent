/**
 * V3 权限判定引擎（零依赖，纯函数）。
 * 判定顺序（V4.5 决策 D 演进 + V5 决策 A1 加 plan 分支 + V7.5 收口前置单线管线 + V8 决策 G2 plan 文件豁免）：
 *   用户 deny（P3：先于一切内置放行，含导航工具）→ 内置危险命令（classify dangerous）
 *   → 命令文本危险段（.run-agent/.git/.claude，/i）→ 记忆读专属通道 → plan 文件豁免
 *   → 路径危险段（P1：plan 下也跑）→ plan 分支（强制只读，读侧与 default 共享）→ 导航工具
 *   → 用户 allow → 白名单(cwd) → 兜底 ask。
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
 * run_bash 的命令文本里引用危险目录段 → 同样收口（P5：三目录段 + `/i`，agent 自身目录/版本库
 * 元数据/配置对模型完全只读）。后缀 `(?![\w-])` 排除 `.gitignore`/`.gitattributes`/
 * `.run-agent-backup` 这类相似文件名（`.git` 后跟 word char 即不命中）；前缀约束避免误伤普通文本。
 * 定位：第二道防线（尽力而为，不承诺穷尽 shell 拼接绕过——见 Plan_V4.5 决策 E 4）。
 */
export const DENY_BASH_SEGMENTS_RE = /(?<=^|[\s\\/'"`=(;|&])\.(run-agent|git|claude)(?![\w-])/i;

/** 只读工具：default 模式下免确认。repo_map 为 0.4.1 只读定位工具。
 *  SkillTool 为 V6 技能加载（只回填 body 文本、无副作用）：必须归只读，
 *  否则 headless/one-shot 在 default 模式返回 ask → 无弹窗直接 deny，技能全废。 */
const READ_ONLY_TOOLS = new Set(["read_file", "glob", "grep", "repo_map", "SkillTool"]);

/** V8 决策 G2：plan 文件豁免覆盖的工具（精确文件 + plan 模式才放行）。
 *  含 read_file——计划文件在 `.run-agent` 危险段下，路径危险段（第 5 步）会先于 plan 分支
 *  拦截读，不豁免则模型写后无法回读（盲写）。豁免仍是精确文件，不放大 `.run-agent/**`。 */
const PLAN_FILE_TOOLS = new Set(["write_file", "edit_file", "read_file"]);

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

/**
 * bash 命令影响半径分类（近期落地版，见 docs/expected-permissions.md §2）：
 *   - `readonly`  R0 纯只读（闭集白名单，自动 allow）——engine / verification 全部放行
 *   - `local-exec` R3a 本地执行（解释器跑脚本/检查命令）——engine ask；verification 放行（跑构建/测试/lint）
 *   - `http-get`  R4a 普通网络只读采样（curl 到 stdout，无写文件）——engine ask；verification 放行（curl 采样页面）
 *   - `network`   R4a 网络副作用（git 拉/推/克隆、装依赖、wget/gh）——engine ask；verification deny
 *   - `write`     R1 项目内写 / 重定向写 / 无法证明安全（兜底）——engine ask；verification deny
 *   - `dangerous` R2 系统级写 / R3b 远程拉取执行 / R4b 发布强推——engine deny（任何规则/模式不可解除）
 * git 系列刻意不归 `readonly`：仓库级 `.git/config` 可定义 alias/pager/external-diff 执行任意命令，
 * 恶意仓库能在只读子命令（status/log/diff）下注入执行——一律走 `write` 兜底 ask，用户可配 allow 规则。
 */
export type BashDanger = "readonly" | "local-exec" | "http-get" | "network" | "write" | "dangerous";

/** 危险命令（R2 系统写 / R3b 远程拉取执行 / R4b 发布强推）：命中即内置 deny。
 *  bypass 删除后成为最高级、任何规则/模式不可解除的保护。
 *  注意：rm 目标以 / 或 ~ 开头即命中；不接 \b，否则 "rm -rf /" / "rm -rf ~"（目标在串尾）会漏掉。 */
const DANGEROUS_PATTERNS: RegExp[] = [
  // R2 系统级写：根删除（含 `echo x | rm -rf /` 管道变体，P4 补齐；sudo 前缀并入）
  /(?:^\s*|[;&|]\s*)(?:sudo\s+)?rm\s+(?:-[a-z]*[rR][a-z]*\s+)?(\/|~)/i,
  // R2：磁盘格式化
  /\b(mkfs|fdisk|mkswap|format)\b/i,
  // R2：dd 到设备/系统路径（P4：`of=//dev` 这类双斜杠变体也要拦）
  /\bdd\b.*\bof=(?:\/\/)?\/?(?:dev|etc|var)\b/i,
  // R2：关机重启
  /^\s*(shutdown|reboot|halt|poweroff)\b/i,
  // R3b：远程拉取执行（curl|sh / wget|bash）
  /(?:^|[;&|]\s*)(curl|wget)\b.*\s\|\s*(?:sh|bash)\b/i,
  // R4b：git 强推（P4：`git -C repo push --force` 这类前置参数变体）与发布包
  // `.*\bpush\b`：git 后允许任意参数串到 push 子命令（含 -C 双 token 参数形态）；
  // 代价是 `git log -- git push --force` 这类嵌套文本也会命中——方向是更严（deny），可接受
  /git\s+.*\bpush\b.*(--force\b|-[a-z]*f\b)/i,
  /\b(npm|pnpm|yarn)\s+(publish|prune)\b/i,
  // R4b：hard reset（丢弃工作区/历史，破坏性同强推）
  /\bgit\s+.*\breset\s+--hard\b/i,
];

/** R3a 本地执行：解释器 / 包管理器脚本 / 源码加载。engine ask（执行任意代码影响半径大）。 */
const LOCAL_EXEC_PATTERNS: RegExp[] = [
  /^\s*(node|nodejs|npm|npx|pnpm|yarn|bun|deno|python|python3|pip|pip3|perl|php|ruby|bash|sh|zsh|ksh|fish|pwsh|powershell|eval|source|nohup|env)\b/i,
  // `./script.sh` 直接执行当前目录脚本
  /^\s*\.\//i,
];

/** R4a 网络副作用：git 拉/推/克隆、装依赖、wget（默认写文件）/gh。engine ask；verification deny。 */
const NETWORK_PATTERNS: RegExp[] = [
  /\bgit\s+(fetch|pull|clone|push|ls-remote)\b/i,
  /^\s*(npm|pnpm|yarn)\s+(install|ci|add|login|logout|ping|view|search)\b/i,
  /^\s*(wget|gh)\b/i,
];

/** R1 项目内写 / 变更命令 + 重定向写。engine ask；verification deny。 */
const WRITE_PATTERNS: RegExp[] = [
  /\brm\b/i,
  /\bsudo\b/i,
  /\b(mv|mkdir|touch|cp|rmdir|ln|chmod|chown|truncate|install)\b/i,
  /\b(sed|awk)\b/i, // sed -i / awk 写
  /\b(git|hg|svn)\s+(add|commit|rm|mv|checkout|reset|merge|rebase|tag|branch|init|apply|am|clean|stash)\b/i,
  />>?/, // 重定向写
];

/**
 * R0 闭集白名单：可证明无副作用的只读命令（自动 allow，全模式共享）。
 * 闭集证明制的最小形态：命令 ∈ 闭集 且 无管道/重定向/命令替换/子 shell/逻辑符 且 参数不越界。
 * 只收 ls/pwd/echo/cat（git 因仓库级 alias 注入面不入；PowerShell 全名 Get-ChildItem 等走 ask）。
 */
function isReadonlyBashCommand(cmd: string): boolean {
  const trimmed = cmd.trim();
  // 任何管道/重定向/命令替换/子 shell/换行/逻辑符 → 不算只读
  if (/[|&;<>`$(){}\n]/.test(trimmed)) return false;
  if (/^pwd\s*$/.test(trimmed)) return true;
  // ls 允许任意 flag/参数（仅列出无副作用）
  if (/^ls(?:\s+-[A-Za-z]+)*(?:\s+[^\s]+)*$/.test(trimmed)) return true;
  if (/^echo\s+\S+(\s+\S+)*$/.test(trimmed)) return true;
  // cat 严格单参数：纯相对路径（拒绝绝对/越界/展开/通配符）
  const cat = /^cat\s+([^\s]+)$/.exec(trimmed);
  if (cat) {
    const arg = cat[1]!;
    if (arg.startsWith("/") || arg.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(arg)) return false; // 绝对路径
    if (arg.startsWith("~") || arg.startsWith("$")) return false; // 展开 / 环境变量
    if (arg.includes("..") || /[*?[\]]/.test(arg)) return false; // 越界 / 通配符
    return true;
  }
  return false;
}

/** R4a 只读采样：curl 到 stdout（无 -o/-O/-J/-C 写文件）。engine ask；verification 放行（curl 采样页面）。 */
function isHttpGetCommand(cmd: string): boolean {
  if (!/^\s*curl\b/i.test(cmd)) return false;
  if (/\s-(?:o|O|J|C)\b/i.test(cmd)) return false; // 下载到文件 → 归 write（有副作用）
  return true;
}

/**
 * 语义化分类 bash 命令。规则保守：拿不准就往下调一档（写 → ask），宁 ask 勿漏。
 * 只识别字符串模式；PowerShell 别名/全名（Remove-Item、Get-ChildItem 等）走模式未命中时
 * 归 `write` 兜底 ask，由用户规则收口（见 Plan_V2 §6.4）。
 */
export function classifyBashCommand(cmd: string): BashDanger {
  if (DANGEROUS_PATTERNS.some((re) => re.test(cmd))) return "dangerous";
  if (isReadonlyBashCommand(cmd)) return "readonly";
  // network 先于 local-exec：`npm install` 归 network（装依赖副作用），`npm test` 归 local-exec
  if (NETWORK_PATTERNS.some((re) => re.test(cmd))) return "network";
  if (LOCAL_EXEC_PATTERNS.some((re) => re.test(cmd))) return "local-exec";
  if (isHttpGetCommand(cmd)) return "http-get";
  if (WRITE_PATTERNS.some((re) => re.test(cmd))) return "write";
  return "write"; // 兜底：无法证明安全 → 按写处理（engine 下 ask）
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
 * 路径是否在 cwd 内（决策 B 白名单）。安全边界看物理位置：real(p) 落在 real(cwd) 内才算 cwd 内。
 *   - 换名逃逸（foo → /etc/passwd）：real(p) 越出 real(cwd) → false，与旧「双形态都必须在内」
 *     对逃逸的拦截一致（escape 的另一方向——逃进 .git/.run-agent——由 hasDeniedDirSegment 对双形态
 *     `forms.some` 各自兜底；memory 豁免由 `forms.every` 守住，都不依赖本函数）。
 *   - macOS /var→/private/var 系统 symlink：POSIX getcwd() 在 chdir 进符号链接后返回物理路径
 *     （子进程 process.cwd() = /private/var/...），而入参可能是逻辑形态（/var/folders/...）。
 *     旧实现要求 p 的 resolved 形态也匹配 cwd 形态 → 别名形态匹配不上「已物理化」的 cwd → 误判
 *     cwd 外 → ask → headless 降级 deny（V6-3，macOS CI 全挂）。realpath 后两侧归一 → 修复。
 */
export function pathInCwd(p: string, cwd: string): boolean {
  const cwdReal = pathForms(cwd)[1];
  const sep = cwdReal.endsWith(path.sep) ? cwdReal : cwdReal + path.sep;
  const pReal = pathForms(p)[1];
  return pReal === cwdReal || pReal.startsWith(sep);
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

/** P2 收窄：acceptEdits 只预授权 cwd 内的路径写工具（write_file/edit_file）。
 *  无路径工具（remember）、MCP 写工具、其它有路径工具在 acceptEdits 下不再无条件放行。 */
const PATH_WRITE_TOOLS = new Set(["write_file", "edit_file"]);

/**
 * 判定一次工具调用是否允许。纯函数：ask 的处理（确认/降级）在 prompt 层，不在此。
 * 判定顺序（收口前置单线管线，P1/P3/P5 修复后的稳定语义）：
 *   1. 用户 deny 规则 → deny（P3：先于一切内置放行，含导航工具）
 *   2. 内置危险命令（classify dangerous：R2/R3b/R4b）→ deny（任何规则/模式不可覆盖）
 *   3. 命令文本危险段（.run-agent/.git/.claude，/i）→ deny（第二道防线，尽力而为）
 *   4. 记忆读专属通道（只读 × .run-agent/memory/** × Trust）→ allow
 *   4.5. plan 文件豁免（精确文件 + plan 模式，write/edit/read 该文件）→ allow（V8 决策 G2）
 *   5. 路径危险段（.git/.claude/.run-agent，未豁免）→ deny（P1：plan 下也跑）
 *   6. plan 分支：enter_plan_mode allow / exit_plan_mode ask / 只读 cwd 内 allow、cwd 外 ask /
 *      MCP 外部工具 ask（黑盒，用户显式确认）/ 写·执行·remember deny（读侧与 default 共享，见 3-5）
 *   7. 导航工具（非 plan）免确认（enter/exit_plan_mode）
 *   8. 用户 allow 规则 → allow（cwd 外访问的唯一授权通道；对 cwd 内保留"始终允许"语义）
 *   9. 白名单 + 模式兜底：run_bash 按 classify——readonly 自动 allow、其余 ask
 *      （acceptEdits 不放行 bash）；Windows 可疑路径 → ask；无路径工具 readOnlyNames → allow
 *      否则 ask（P2：acceptEdits 不再放行）；cwd 内 readOnly → allow / acceptEdits 仅
 *      write_file·edit_file → allow / default 写 ask；cwd 外 → 只读也 ask
 * @param isTrusted 记忆读豁免的 Trust 门控；缺省 false（未传 = 无豁免）。
 * @param cwd 工作目录白名单边界；缺省 process.cwd()。
 * @param planFilePath V8 决策 G：当前 plan 会话的计划文件绝对路径（REPL 经 ctx 传入；
 *  缺省 undefined = 无 plan 文件豁免，现有行为不变）。
 */
export function hasPermissionsToUseTool(
  tool: string,
  input: unknown,
  mode: PermissionMode,
  rules: PermissionRule[],
  isTrusted = false,
  cwd = process.cwd(),
  readOnlyNames: (name: string) => boolean = isBuiltinReadOnlyTool,
  planFilePath?: string,
): Decision {
  const p = inputPath(input);
  const forms = p ? pathForms(p) : undefined;
  const cmd = tool === "run_bash" ? bashCommand(input) ?? "" : undefined;
  const bashDanger = cmd !== undefined ? classifyBashCommand(cmd) : undefined;

  // 1. 用户 deny 规则（P3：先于一切内置放行——用户显式 deny 优先级最高，含导航工具）
  for (const rule of rules) {
    if (rule.action === "deny" && ruleMatches(rule, tool, input, forms)) return "deny";
  }

  // 2. 内置危险命令（R2/R3b/R4b → classify dangerous；最高级，任何规则/模式不可覆盖）
  if (bashDanger === "dangerous") return "deny";

  // 3. 命令文本危险段（P5：三目录段 + /i，agent 自身目录/版本库/配置对模型完全只读）
  if (cmd !== undefined && DENY_BASH_SEGMENTS_RE.test(cmd)) return "deny";

  // 4. 专属通道：记忆读豁免。所有形态都必须是记忆目录才算豁免
  //    （防 `.run-agent/memory/out` → `/etc/passwd` 这类 symlink 指向记忆外的换名逃逸）。
  if (forms && forms.every((f) => isMemoryReadExempt(tool, f, isTrusted))) {
    return "allow";
  }

  // 4.5 V8 决策 G2：plan 文件豁免——精确文件 + 仅 plan 模式，比记忆读豁免更窄
  //    （只放开这一个文件，不放大 `.run-agent/**` 写禁令）。放在路径危险段（第 5 步）
  //    之前：计划文件在 `.run-agent` 段下，必须在该段 deny 前放行（同记忆豁免前置的原因）。
  //    所有形态都必须等于计划文件（realpath 双形态防 symlink 别名——`every` 自证不比豁免宽）。
  if (
    planFilePath !== undefined &&
    mode === "plan" &&
    PLAN_FILE_TOOLS.has(tool) &&
    forms !== undefined
  ) {
    const planForms = pathForms(planFilePath);
    if (forms.every((f) => planForms.some((pf) => f === pf))) return "allow";
  }

  // 5. 路径危险段（小写化比较，任一形态命中即 deny；P1：plan 下也跑——收口前置单线）
  if (forms && forms.some(hasDeniedDirSegment)) {
    return "deny";
  }

  // 6. V5 决策 A1：plan 分支（读侧已与 default 共享——危险段/记忆豁免在第 3-5 步前置处理；
  //    写/执行一律 deny，不受用户模式影响）。判定顺序见文件头注释。
  if (mode === "plan") {
    // enter_plan_mode 放行（它自身处理「已在 plan 中」报错）
    if (tool === "enter_plan_mode") return "allow";
    // exit_plan_mode 返回 ask：engine 放行工具本身，用户审批由 repl 的 ask 弹窗负责
    if (tool === "exit_plan_mode") return "ask";
    // V8 决策：MCP 外部工具在 plan 下也 ask（参数是 server 黑盒，run-agent 无法判断读写；
    //   要求用户显式确认每次外部调用；headless canPrompt=false 时由 prompt 层降级 deny）。
    //   先于只读判定：无论装配闭包是否把某 MCP 工具归只读，plan 下都一律 ask。
    if (tool.startsWith("mcp__")) return "ask";
    // 只读探索（readOnlyNames 覆盖内置只读 + explore）：
    //   无路径入参（explore/repo_map）→ allow；cwd 内 → allow；cwd 外 → ask
    if (readOnlyNames(tool)) {
      if (!p) return "allow";
      if (pathInCwd(p, cwd)) return "allow";
      return "ask";
    }
    // 其余（写类 / run_bash / remember / 未知外部工具）→ deny
    return "deny";
  }

  // 7. 导航工具（非 plan 模式）：模式切换免权限确认；「不在 plan 模式」的报错语义在工具层。
  //    （V8 重设计①：mcp_connect 工具已移除——连接完全配置驱动 + /mcp connect 命令。）
  if (tool === "enter_plan_mode" || tool === "exit_plan_mode") return "allow";

  // 8. 用户 allow 规则（cwd 外唯一授权通道；也可显式放行 run_bash 等）
  for (const rule of rules) {
    if (rule.action === "allow" && ruleMatches(rule, tool, input, forms)) return "allow";
  }

  // 9. 白名单 + 模式兜底
  if (cmd !== undefined) {
    // run_bash（plan 分支已在上层 deny 全部 bash）：R0 闭集白名单 → allow（default/acceptEdits 共享）；
    // 其余一律 ask（acceptEdits 不放行非 R0 bash）
    if (bashDanger === "readonly") return "allow";
    return "ask";
  }
  if (p && forms && forms.some((f) => suspiciousOutsideCwd(f, cwd))) return "ask";
  if (!p) {
    // 无路径入参的工具（repo_map/explore/remember/glob 无 path 等）：不参与 cwd 边界。
    // 用 readOnlyNames（V5 决策 B4）而非硬编码 READ_ONLY_TOOLS：让 REPL/CLI 装配的扩展闭包
    // （协调者三件套 agent/send_message/task_stop + explore）在 default 下也免确认。
    // V8：MCP 工具不再并入——参数是 server 黑盒，三模式一律 ask（见 cli/index.ts readOnlyNames 注释）。
    // P2：acceptEdits 不再无条件放行无路径工具（remember 等 → ask）。
    if (readOnlyNames(tool)) return "allow";
    return "ask";
  }
  if (pathInCwd(p, cwd)) {
    if (readOnlyNames(tool)) return "allow";
    // P2 收窄：acceptEdits 只预授权 cwd 内 write_file/edit_file，不放行 MCP 写工具等
    if (mode === "acceptEdits" && PATH_WRITE_TOOLS.has(tool)) return "allow";
    return "ask";
  }
  // cwd 外：只读工具也 ask（修缺口 ④）；one-shot canPrompt=false 时由 prompt 层降级 deny
  return "ask";
}
