/**
 * 跨平台 ShellProvider：Windows 用 PowerShell，macOS/Linux 用 bash。
 * 命令以单参数传给 shell 执行；可用 RUN_AGENT_SHELL / 显式 override 覆盖。
 */

export interface ShellSpec {
  command: string;
  /** 传给 command 的参数（不含待执行脚本本身） */
  args: string[];
}

/** 解析用户自定义 shell 字符串，如 "/bin/zsh" 或 "C:\\Program Files\\Git\\bin\\bash.exe" */
export function parseShellOverride(shell: string): ShellSpec {
  const trimmed = shell.trim();
  if (!trimmed) return defaultShell();
  if (process.platform === "win32" && /[A-Za-z]:[\\/]/.test(trimmed)) {
    // Windows 路径可能含空格，不能简单 split
    return { command: trimmed.replace(/^"(.*)"$/, "$1"), args: ["-c"] };
  }
  const parts = trimmed.split(/\s+/);
  return { command: parts[0]!, args: parts.slice(1) };
}

export function defaultShell(): ShellSpec {
  return process.platform === "win32"
    ? { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command"] }
    : { command: "/bin/bash", args: ["-lc"] };
}

/** 解析最终使用的 shell：override > RUN_AGENT_SHELL 环境变量 > 平台默认。 */
export function resolveShell(override?: string): ShellSpec {
  if (override) return parseShellOverride(override);
  const envShell = process.env.RUN_AGENT_SHELL;
  if (envShell) return parseShellOverride(envShell);
  return defaultShell();
}
