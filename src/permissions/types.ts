/**
 * V2 权限引擎的类型定义。
 * 模式：default（危险/写操作询问）/ acceptEdits（写/改免确认，bash 仍询问）/ bypass（全部放行）。
 */
export type PermissionMode = "default" | "acceptEdits" | "bypass";

export type Decision = "allow" | "ask" | "deny";

/** 用户规则：首条命中短路。tool/path/command 缺省则对该维度不设限。 */
export interface PermissionRule {
  /** 工具名精确匹配，如 "run_bash" / "edit_file" / "*" */
  tool?: string;
  /** glob，作用于 file_path / path / cwd（路径先 resolve + 归一化） */
  path?: string;
  /** 正则，作用于 run_bash 的 command 字段 */
  command?: string;
  action: Decision;
}

/** 权限上下文：CLI 在启动时组装，注入 checkPermission 回调。 */
export interface PermissionContext {
  mode: PermissionMode;
  rules: PermissionRule[];
  /** 能否弹交互确认（仅 REPL + TTY）；否则 ask 降级 deny */
  canPrompt: boolean;
  /** 当前项目是否已受信任（决定是否加载项目级规则） */
  isTrusted: boolean;
}
