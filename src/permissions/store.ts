/**
 * 权限持久化：规则（~/.config/run-agent/permissions.json）与信任（trust.json）。
 * 读失败一律返回空（绝不因配置损坏让 CLI 崩溃）；写失败静默（尽量不影响主流程）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { PermissionRule } from "./types.js";

function configDir(): string {
  return path.join(homedir(), ".config", "run-agent");
}

function normalize(p: string): string {
  return path.normalize(path.resolve(p));
}

function writeJson(file: string, data: unknown): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
  } catch {
    // 写失败不抛：权限配置是辅助能力，不应阻断 agent 主流程
  }
}

export function permissionsFilePath(): string {
  return path.join(configDir(), "permissions.json");
}

export function loadRules(file: string = permissionsFilePath()): PermissionRule[] {
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { rules?: PermissionRule[] };
    return Array.isArray(raw.rules) ? raw.rules : [];
  } catch {
    return [];
  }
}

export function addRule(
  rule: PermissionRule,
  file: string = permissionsFilePath(),
): PermissionRule[] {
  const rules = loadRules(file);
  rules.push(rule);
  writeJson(file, { rules });
  return rules;
}

export function trustFilePath(): string {
  return path.join(configDir(), "trust.json");
}

export function loadTrustedProjects(file: string = trustFilePath()): string[] {
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { trustedProjects?: string[] };
    return Array.isArray(raw.trustedProjects) ? raw.trustedProjects.map(normalize) : [];
  } catch {
    return [];
  }
}

/** 当前目录（或子目录）是否在受信任列表中。 */
export function isProjectTrusted(cwd: string, trusted: string[]): boolean {
  const n = normalize(cwd);
  return trusted.some((t) => n === t || n.startsWith(t + path.sep));
}

export function addTrustedProject(p: string, file: string = trustFilePath()): string[] {
  const list = loadTrustedProjects(file);
  const n = normalize(p);
  if (!list.includes(n)) list.push(n);
  writeJson(file, { trustedProjects: list });
  return list;
}

export function removeTrustedProject(p: string, file: string = trustFilePath()): string[] {
  const list = loadTrustedProjects(file);
  const n = normalize(p);
  const next = list.filter((t) => t !== n);
  writeJson(file, { trustedProjects: next });
  return next;
}
