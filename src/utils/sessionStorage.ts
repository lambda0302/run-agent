import { createHash } from "node:crypto";
import { appendFile, mkdir, open, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { COMPACT_MARKER } from "../core/compact.js";
import type { LLMMessage } from "../providers/types.js";

/** 会话根目录：~/.local/share/run-agent/sessions。传 cwd 时按 cwd 分目录（V8 ①，修跨项目串会话）。 */
export function sessionsDir(cwd?: string): string {
  const base = path.join(homedir(), ".local", "share", "run-agent", "sessions");
  return cwd ? path.join(base, sanitizePath(cwd)) : base;
}

/** 路径 → 目录名：非字母数字 → '-'，超长截断 200 字符 + hash 后缀保唯一（对齐 CC sessionStoragePortable）。 */
export function sanitizePath(p: string): string {
  const resolved = path.resolve(p);
  const s = resolved.replace(/[^a-zA-Z0-9]/g, "-");
  if (s.length <= 200) return s;
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 8);
  return `${s.slice(0, 200)}-${hash}`;
}

/** 会话首行元数据（V8 ②）：resume 可知上次 model/provider；--list 只读首行即得列表元数据。 */
export interface SessionMeta {
  cwd: string;
  model?: string;
  provider?: string;
  version?: string;
}

/** 单条持久化记录：时间戳 + 一条内部消息；首行元数据行只有 meta 无 message。逐行 JSONL 追加。 */
export interface SessionRecord {
  ts: string;
  message?: LLMMessage;
  meta?: SessionMeta;
}

/** 子 agent transcript 文件前缀（V7 决策 C4：与主会话同目录、独立文件）。 */
export const SUBAGENT_FILE_PREFIX = "subagent-";

async function ensureDir(dir: string): Promise<string> {
  // V8 ③：权限收紧——新建目录 0o700（Node 的 mode 只对新建项生效，既有目录/文件不变）
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** 新建一个会话文件：<ts>-<id>.jsonl；给定 meta 时第 1 行写入元数据（第 2 行起才是消息行）。 */
export async function createSessionFile(
  dir: string = sessionsDir(),
  meta?: SessionMeta,
): Promise<string> {
  await ensureDir(dir);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const id = Math.random().toString(36).slice(2, 8);
  const file = path.join(dir, `${ts}-${id}.jsonl`);
  if (meta) {
    // 首行元数据（无 message 字段）；mode 只在新文件创建时生效
    const record: SessionRecord = { ts: new Date().toISOString(), meta };
    await appendFile(file, JSON.stringify(record) + "\n", { encoding: "utf8", mode: 0o600 });
  }
  return file;
}

/** 追加一条消息到会话文件（追加模式；mode 对已存在文件无效，天然幂等） */
export async function appendMessage(file: string, message: LLMMessage): Promise<void> {
  const record: SessionRecord = { ts: new Date().toISOString(), message };
  await appendFile(file, JSON.stringify(record) + "\n", { encoding: "utf8", mode: 0o600 });
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
      // V8 ②：元数据行（meta 无 message）跳过，不进消息流
      if (rec && rec.meta) continue;
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
  // 排除子 agent transcript（subagent-*.jsonl 以字母开头，倒序字典序恒排在时间戳主会话之前，
  // 不排除会误选成主会话续接——见 docs/session-persistence.md §1.8）
  const jsonl = files.filter((f) => f.endsWith(".jsonl") && !f.startsWith(SUBAGENT_FILE_PREFIX));
  if (jsonl.length === 0) return undefined;

  // 文件名形如 2026-08-10T22-59-00.000Z-abc123.jsonl，ISO 时间戳的字典序即时间顺序
  const sorted = jsonl.sort((a, b) => (a < b ? 1 : -1));
  return path.join(dir, sorted[0]!);
}

/**
 * 会话 id（文件名 <ts>-<id> 不含 .jsonl）里的 UTC 时间戳 → 本地时区显示串。
 * 存储保持 UTC（文件名 `2026-08-14T06-30-00-000Z-abc123` 的字典序==时间序不变式依赖 UTC），
 * 仅显示层转本地时区（地区自适应：跟随系统时区，UTC+8 机器即显示北京时间）。非标准格式兜底原样截断。
 */
export function sessionIdTime(id: string): string {
  // 时间戳前缀形如 2026-08-14T06-30-00-000Z（toISOString 去冒号点）
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(id);
  if (!m) return id.slice(0, 19).replace("T", " ");
  const [, y, mo, d, h, mi, s] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
  if (Number.isNaN(date.getTime())) return id.slice(0, 19).replace("T", " ");
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

/** 会话列表条目（V8 ④ --list 数据源）：id 为文件名 <ts>-<id>（不含 .jsonl）。 */
export interface SessionSummary {
  id: string;
  file: string;
  meta?: SessionMeta;
  /** 首条用户 prompt 截断 60 字符（预览）。 */
  preview?: string;
}

/** 读文件头部字节数：够拿首行 meta + 第二行 prompt 前缀即可（渐进式，不整读大文件）。 */
const HEAD_BYTES = 8192;

/** 从消息行提取首条用户 prompt 文本（string 或 text block）→ 折叠空白 + 截断 60。 */
function messagePreview(line: string): string {
  let content: unknown;
  try {
    const rec = JSON.parse(line) as SessionRecord;
    if (!rec?.message) return "";
    content = rec.message.content;
  } catch {
    return "";
  }
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    const firstBlock = content.find((b): b is { type: "text"; text: string } => b?.type === "text");
    text = firstBlock?.text ?? "";
  }
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 60 ? `${collapsed.slice(0, 60)}…` : collapsed;
}

/**
 * V8 ④：列出目录下会话（排除 subagent-），每文件只读前 HEAD_BYTES 字节取首两行。
 * 排序按文件名字典序倒序（ISO 时间戳在文件名里，天然时间序）。目录不存在返回空数组。
 */
export async function listSessions(dir: string): Promise<SessionSummary[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const jsonl = files
    .filter((f) => f.endsWith(".jsonl") && !f.startsWith(SUBAGENT_FILE_PREFIX))
    .sort((a, b) => (a < b ? 1 : -1));

  const out: SessionSummary[] = [];
  for (const f of jsonl) {
    const file = path.join(dir, f);
    let meta: SessionMeta | undefined;
    let preview: string | undefined;
    const fh = await open(file, "r");
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
      const head = buf.toString("utf8", 0, bytesRead);
      const lines = head.split("\n");
      const first = lines[0]?.trim();
      let messageLine = first;
      if (first) {
        try {
          const rec = JSON.parse(first) as SessionRecord;
          if (rec?.meta) {
            meta = rec.meta;
            messageLine = lines[1]?.trim();
          }
        } catch {
          // 旧文件首行就是消息行（无 meta），按消息行处理
        }
      }
      if (messageLine) preview = messagePreview(messageLine);
    } finally {
      await fh.close();
    }
    out.push({ id: f.slice(0, -".jsonl".length), file, ...(meta ? { meta } : {}), ...(preview !== undefined ? { preview } : {}) });
  }
  return out;
}

/**
 * V8 ⑤：按 id 定位会话文件（不存在 / 非法返回 undefined）。id 为文件名 <ts>-<id>，
 * 正则排除路径分隔符与 `.`/`..`（防路径穿越），首字符必须字母数字。
 */
export async function findSessionFile(dir: string, id: string): Promise<string | undefined> {
  if (!/^[0-9A-Za-z][0-9A-Za-z.\-]*$/.test(id)) return undefined;
  const file = path.join(dir, `${id}.jsonl`);
  try {
    await stat(file);
    return file;
  } catch {
    return undefined;
  }
}
