/**
 * V3 权限引擎的类型定义（V4.5 决策 A：bypass 已于 0.4.2 删除；V5 决策 A1：加 plan）。
 * 模式：default（危险/写操作询问）/ acceptEdits（写/改免确认——仅 cwd 内，bash 仍询问）/
 *       plan（强制只读计划态——只读探索 allow、写/执行 deny；非 CLI 可选项，仅由
 *       enter_plan_mode / /plan 进入、exit_plan_mode 退出）。
 */
export type PermissionMode = "default" | "acceptEdits" | "plan";

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
  /** 当前项目是否已受信任（决定是否加载项目级规则 + 记忆读专属通道） */
  isTrusted: boolean;
  /** 工作目录白名单边界（V4.5 决策 B）：路径在 cwd 外的工具调用一律 ask/deny，
   *  除非命中用户 allow 规则或专属通道。 */
  cwd: string;
}
