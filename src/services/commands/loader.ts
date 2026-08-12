/**
 * V6 决策 C1：自定义命令扫描 + 形态识别（prompt / local）。
 *
 * 路径（自有路径，与技能同语义）：
 *   - 项目级 <cwd>/.run-agent/commands/<name>.md|.py|.js|.ts（仅 Trust 加载）
 *   - 用户级 ~/.config/run-agent/commands/<name>.md|.py|.js|.ts（始终加载）
 * prompt 形态（.md）= 模板；local 形态（.py/.js/.ts）= 脚本。
 * 命令名 = 文件名去扩展名，须不含空白（`/` 内不允许，路径段天然排除）。
 * local-jsx 形态明确不落地（需 React/Ink 渲染器，推 V8 TUI 打磨）。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface PromptCommand {
  type: "prompt";
  name: string;
  source: "user" | "project";
  /** .md 模板全文 */
  template: string;
}

export interface LocalCommand {
  type: "local";
  name: string;
  source: "user" | "project";
  /** 脚本绝对路径 */
  file: string;
  ext: "py" | "js" | "ts";
}

export type CustomCommand = PromptCommand | LocalCommand;

/** 单个命令文件上限（防恶意巨型模板）。 */
export const MAX_COMMAND_BYTES = 100 * 1024;

const LOCAL_EXTS = new Set(["py", "js", "ts"]);

/** 命令名合法性：无空白、非空（文件名天然无 `/`）。 */
function validName(name: string): boolean {
  return /^\S+$/.test(name) && name.length > 0;
}

/** 扫描单目录；非法名/超限 → 记入 skipped。 */
function scanDir(dir: string, source: "user" | "project", skipped: string[]): CustomCommand[] {
  const out: CustomCommand[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const ext = path.extname(ent.name).slice(1).toLowerCase();
    const name = path.basename(ent.name, path.extname(ent.name));
    if (!validName(name)) {
      skipped.push(ent.name);
      continue;
    }
    const file = path.join(dir, ent.name);
    if (ext === "md") {
      let text: string;
      try {
        if (statSync(file).size > MAX_COMMAND_BYTES) {
          skipped.push(ent.name);
          continue;
        }
        text = readFileSync(file, "utf8");
      } catch {
        skipped.push(ent.name);
        continue;
      }
      out.push({ type: "prompt", name, source, template: text });
    } else if (LOCAL_EXTS.has(ext)) {
      out.push({
        type: "local",
        name,
        source,
        file,
        ext: ext as LocalCommand["ext"],
      });
    }
    // 其它扩展名 → 忽略
  }
  return out;
}

/**
 * 合读用户级 + 项目级命令。项目级仅 Trust。
 * 同名去重：用户级优先（后出现同名命令丢弃）。
 */
export function loadCommands(
  cwd: string,
  isTrusted: boolean,
  homeDir: string = homedir(),
): { commands: CustomCommand[]; skipped: string[] } {
  const skipped: string[] = [];
  const seen = new Set<string>();
  const commands: CustomCommand[] = [];
  for (const cmd of [
    ...scanDir(path.join(homeDir, ".config", "run-agent", "commands"), "user", skipped),
    ...(isTrusted ? scanDir(path.join(cwd, ".run-agent", "commands"), "project", skipped) : []),
  ]) {
    if (seen.has(cmd.name)) continue;
    seen.add(cmd.name);
    commands.push(cmd);
  }
  return { commands, skipped };
}

/** 命令注册表：REPL 装配用（与 SkillRegistry 同语义的薄封装）。 */
export class CommandRegistry {
  readonly all: CustomCommand[];
  constructor(commands: CustomCommand[]) {
    this.all = commands;
  }

  find(name: string): CustomCommand | undefined {
    return this.all.find((c) => c.name === name);
  }
}
