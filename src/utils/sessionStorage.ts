import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { COMPACT_MARKER } from "../core/compact.js";
import type { LLMMessage } from "../providers/types.js";

/** 会话根目录：~/.local/share/run-agent/sessions（与配置路径同样基于 homedir） */
export function sessionsDir(): string {
  return path.join(homedir(), ".local", "share", "run-agent", "sessions");
}

/** 单条持久化记录：时间戳 + 一条内部消息。逐行 JSONL 追加。 */
export interface SessionRecord {
  ts: string;
  message: LLMMessage;
}

async function ensureDir(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  return dir;
}

/** 新建一个会话文件：<ts>-<id>.jsonl */
export async function createSessionFile(dir: string = sessionsDir()): Promise<string> {
  await ensureDir(dir);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const id = Math.random().toString(36).slice(2, 8);
  return path.join(dir, `${ts}-${id}.jsonl`);
}

/** 追加一条消息到会话文件 */
export async function appendMessage(file: string, message: LLMMessage): Promise<void> {
  const record: SessionRecord = { ts: new Date().toISOString(), message };
  await appendFile(file, JSON.stringify(record) + "\n", "utf8");
}

/**
 * 读取会话。JSONL 保持追加式，但遇到含压缩哨兵的边界消息时重置加载点：
 * 只保留该边界消息与其之后的消息（旧历史留在文件但被忽略），实现压缩后 resume 从摘要续起。
 */
export async function loadSession(file: string): Promise<LLMMessage[]> {
  const raw = await readFile(file, "utf8");
  let messages: LLMMessage[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as SessionRecord;
      if (rec && rec.message) {
        messages.push(rec.message);
        if (
          typeof rec.message.content === "string" &&
          rec.message.content.includes(COMPACT_MARKER)
        ) {
          // 边界即新上下文的起点：清掉更早的历史
          messages = [rec.message];
        }
      }
    } catch {
      // 跳过损坏的行，保证 --resume 不会因单行坏数据而失败
    }
  }
  return messages;
}

/** 最新的会话文件（按文件名 ISO 时间戳倒序），供 --resume 使用；没有则返回 undefined */
export async function latestSessionFile(dir: string = sessionsDir()): Promise<string | undefined> {
  await ensureDir(dir);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return undefined;
  }
  const jsonl = files.filter((f) => f.endsWith(".jsonl"));
  if (jsonl.length === 0) return undefined;

  // 文件名形如 2026-08-10T22-59-00.000Z-abc123.jsonl，ISO 时间戳的字典序即时间顺序
  const sorted = jsonl.sort((a, b) => (a < b ? 1 : -1));
  return path.join(dir, sorted[0]!);
}
