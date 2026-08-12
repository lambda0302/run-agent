/**
 * V7 决策 E(0.7.1)——后台记忆提取引擎(双轨之一)。
 * 游标增量:ExtractCursor = messages.length,每次只分析新增;增量太少(< MIN_EXTRACT_INCREMENT)跳过
 * 不发请求(成本守卫,不推进游标 → 累积到下次);
 * 互斥:增量里出现 remember tool_use(主 agent 本轮已直接写)→ 跳过并推进游标;
 * 成功才推进游标,失败静默不推进(下次重试);fire-and-forget:trigger 不抛、不阻断主循环。
 * 触发开关:仅 Trust 且非 bare;RUN_AGENT_DISABLE_MEMORY_EXTRACT 关闭。
 * 提取子 agent = extractMemories 类型,直接 runAgent(独立执行路径,不入 task registry / awaitAll)。
 */
import type { LLMClient, LLMMessage } from "../../providers/types.js";
import { runAgent } from "../../core/run_agent.js";
import { buildMemoryIndexBlock, memoryDirPath } from "../../core/memory.js";
import {
  EXTRACT_MEMORY_SYSTEM,
  extractMemoriesDef,
  makeExtractMemCheckPermission,
} from "../agents/builtin/extractMemories.js";
import type { Tool } from "../../tools.js";

/** 增量太少(< N 条)直接跳过——成本守卫,不推进游标。 */
export const MIN_EXTRACT_INCREMENT = 4;
/** 注入 prompt 的增量消息条数上限。 */
export const MAX_EXTRACT_MESSAGES = 30;
/** 注入 prompt 的增量消息字节上限。 */
export const MAX_EXTRACT_BYTES = 60 * 1024;

export interface ExtractEngineOptions {
  cwd: string;
  isTrusted: boolean;
  bare: boolean;
  client: LLMClient;
  /** 父级工具池 getter(read_file/glob/grep/remember,remember 已注入 cwd/isTrusted)。 */
  parentTools: () => Tool[];
  contextWindow?: number;
  resultsDir?: string;
  /** 低成本模型工厂(extractMemories 类型 frontmatter model);缺省继承主模型。 */
  makeModelClient?: (model: string) => LLMClient;
  /** RUN_AGENT_DISABLE_MEMORY_EXTRACT 开关(CLI 装配时读 env)。 */
  disabled?: boolean;
}

/** 增量消息里是否有主 agent 已写的 remember(互斥:主/后台每轮互斥,防重复写)。 */
function hasMemoryWrite(messages: LLMMessage[]): boolean {
  return messages.some(
    (m) =>
      m.role === "assistant" &&
      Array.isArray(m.content) &&
      m.content.some((b) => b.type === "tool_use" && b.name === "remember"),
  );
}

/** 组装提取 prompt:现有记忆索引 + 增量消息文本(截断条数/字节)。 */
export function buildExtractPrompt(recent: LLMMessage[], manifest?: string): string {
  const lines: string[] = [];
  let acc = 0;
  for (const m of recent.slice(-MAX_EXTRACT_MESSAGES)) {
    const text =
      m.role === "tool"
        ? `[工具结果 for ${m.tool_use_id}]\n${m.content}`
        : typeof m.content === "string"
          ? m.content
          : m.content
              .map((b) => (b.type === "text" ? b.text : `[调用了 ${b.name}]`))
              .join("\n");
    const line = `--- ${m.role} ---\n${text}`;
    const bytes = Buffer.byteLength(line + "\n", "utf8");
    if (bytes > MAX_EXTRACT_BYTES) continue; // 单条超限 → 跳过该条，不中断后续
    if (acc + bytes > MAX_EXTRACT_BYTES) break; // 预算用尽 → 截断
    acc += bytes;
    lines.push(line);
  }
  const manifestBlock = manifest ?? "（无现有记忆索引）";
  return (
    `以下是本轮会话增量消息。判断是否有值得跨会话沉淀的稳定结论,用 remember 写入项目记忆` +
    `(先读索引防重复,见 system 指引)。\n\n=== 现有记忆索引 ===\n${manifestBlock}\n\n` +
    `=== 增量消息(按序) ===\n${lines.join("\n")}`
  );
}

export class ExtractMemoriesEngine {
  /** 上次成功提取时的消息数(游标)。 */
  private cursor = 0;
  /** 在飞提取(合并并发触发,防重复提取同一批消息)。 */
  private current: Promise<void> | null = null;

  constructor(private readonly opts: ExtractEngineOptions) {}

  /** 本会话是否启用(引擎创建时已保证,仍防御)。 */
  enabled(): boolean {
    return !this.opts.bare && this.opts.isTrusted && !this.opts.disabled;
  }

  /** fire-and-forget 触发。返回 promise 供测试 await;REPL 用 void 忽略。 */
  trigger(messages: LLMMessage[]): Promise<void> {
    if (!this.enabled()) return Promise.resolve();
    if (this.current) return this.current; // 已在飞 → 合并
    this.current = this.run(messages).finally(() => {
      this.current = null;
    });
    return this.current;
  }

  private async run(messages: LLMMessage[]): Promise<void> {
    try {
      const recent = messages.slice(this.cursor);
      if (recent.length === 0) return;
      // 互斥:主 agent 本轮已直接 remember → 跳过并推进游标(增量已被处理)
      if (hasMemoryWrite(recent)) {
        this.cursor = messages.length;
        return;
      }
      // 增量太少 → 跳过不发请求,不推进游标(累积到下次)
      if (recent.length < MIN_EXTRACT_INCREMENT) return;
      const manifest = await buildMemoryIndexBlock(memoryDirPath(this.opts.cwd), true);
      const prompt = buildExtractPrompt(recent, manifest);
      const modelName = extractMemoriesDef.model;
      let client = this.opts.client;
      if (modelName && this.opts.makeModelClient) client = this.opts.makeModelClient(modelName);
      await runAgent({
        prompt,
        client,
        tools: extractMemoriesDef.resolveTools(this.opts.parentTools),
        system: EXTRACT_MEMORY_SYSTEM,
        checkPermission: makeExtractMemCheckPermission(this.opts.isTrusted),
        ...(extractMemoriesDef.maxIterations !== undefined
          ? { maxIterations: extractMemoriesDef.maxIterations }
          : {}),
        querySource: "extract_memories",
        ...(this.opts.contextWindow !== undefined ? { contextWindow: this.opts.contextWindow } : {}),
        ...(this.opts.resultsDir !== undefined ? { resultsDir: this.opts.resultsDir } : {}),
      });
      // 成功才推进游标
      this.cursor = messages.length;
    } catch {
      // 失败静默:不推进游标 → 下次触发重试;绝不抛出(不阻断主流程)
    }
  }
}
