/**
 * BackgroundTaskManager — V7 决策 A6/C2/C3：后台子 agent 任务注册表。
 * spawn 注册 + fire-and-forget 执行（runAgent，独立上下文/transcript）；
 * 可寻址（id）支持 SendMessage（pending 注入队列）/ TaskStop（abort 传播）；
 * 轮末 awaitAll 等全部 running 完成并汇总（done/stopped/failed 区分）。
 * 单线程事件循环内 send/poll 无竞态（poll 原子取空 pending）。
 * awaitAll 只汇总「尚未报告过」的任务——防跨 end_turn 重复注入死循环。
 */
import type { LLMClient, LLMMessage } from "../../../providers/types.js";
import type { PermissionCheckResult } from "../../../core/execute.js";
import { decisionOf } from "../../../core/execute.js";
import { runAgent } from "../../../core/run_agent.js";
import type { Tool } from "../../../tools.js";
import path from "node:path";

export type BackgroundTaskStatus = "running" | "done" | "stopped" | "failed";

export interface BackgroundTaskInfo {
  id: string;
  type: string;
  prompt: string;
  status: BackgroundTaskStatus;
  reply: string;
}

export interface SpawnTaskOptions {
  type: string;
  prompt: string;
  client: LLMClient;
  tools: Tool[] | (() => Tool[]);
  system?: string;
  contextWindow?: number;
  checkPermission?: (tool: Tool, input: unknown, source?: string) => Promise<PermissionCheckResult>;
  maxIterations?: number;
  resultsDir?: string;
  onText?: (t: string) => void;
  /** V7 决策 C4：后台任务独立 transcript 目录（每个任务一个 `<transcriptDir>/subagent-<id>.jsonl`）。 */
  transcriptDir?: string;
}

interface BackgroundTask extends BackgroundTaskInfo {
  pending: string[];
  abort: AbortController;
  done: Promise<void>;
  resolveDone: () => void;
  /** 是否已被 awaitAll 汇总过（防重复注入） */
  reported: boolean;
}

const REPLY_PREVIEW = 80;

export class BackgroundTaskManager {
  private readonly tasks = new Map<string, BackgroundTask>();
  private seq = 0;

  /** 注册 + 启动后台执行，返回可寻址 id。执行异常不冒泡（记入 status= failed）。 */
  spawn(opts: SpawnTaskOptions): string {
    const id = `task-${++this.seq}`;
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    const task: BackgroundTask = {
      id,
      type: opts.type,
      prompt: opts.prompt,
      status: "running",
      reply: "",
      pending: [],
      abort: new AbortController(),
      done,
      resolveDone,
      reported: false,
    };
    this.tasks.set(id, task);
    void this.execute(id, opts);
    return id;
  }

  private async execute(id: string, opts: SpawnTaskOptions): Promise<void> {
    const t = this.tasks.get(id)!;
    // 后台永不弹窗：子查询权限把 ask 降级 deny（主循环 bridge 的 ask 走 REPL readline，
    // 后台任务轮末 awaitAll 时 REPL 不空闲，弹窗会死锁；协调者只能被动等待，无法确认）。
    const bgCheck: SpawnTaskOptions["checkPermission"] = opts.checkPermission
      ? async (tool: Tool, input: unknown): Promise<PermissionCheckResult> => {
          const r = await opts.checkPermission!(tool, input);
          return decisionOf(r) === "ask" ? { decision: "deny" } : r;
        }
      : undefined;
    // V7 决策 C4：独立 transcript（与主会话同目录、命名不冲突）
    const transcriptFile = opts.transcriptDir
      ? path.join(opts.transcriptDir, `subagent-${id}.jsonl`)
      : undefined;
    try {
      const result = await runAgent({
        prompt: opts.prompt,
        client: opts.client,
        tools: opts.tools,
        ...(opts.system !== undefined ? { system: opts.system } : {}),
        ...(opts.contextWindow !== undefined ? { contextWindow: opts.contextWindow } : {}),
        ...(bgCheck !== undefined ? { checkPermission: bgCheck } : {}),
        ...(opts.maxIterations !== undefined ? { maxIterations: opts.maxIterations } : {}),
        ...(opts.onText !== undefined ? { onText: opts.onText } : {}),
        ...(opts.resultsDir !== undefined ? { resultsDir: opts.resultsDir } : {}),
        ...(transcriptFile !== undefined ? { transcriptFile } : {}),
        signal: t.abort.signal,
        pollExternal: () => this.poll(id),
      });
      const cur = this.tasks.get(id);
      if (!cur) return;
      cur.reply = result.reply;
      cur.status = result.aborted ? "stopped" : "done";
    } catch (e) {
      const cur = this.tasks.get(id);
      if (!cur) return;
      cur.reply = `失败: ${e instanceof Error ? e.message : String(e)}`;
      cur.status = "failed";
    } finally {
      this.tasks.get(id)?.resolveDone();
    }
  }

  /** V7 决策 C2：SendMessage 注入队列。running 才接受；已结束返回状态 + reply 摘要让协调者决定重新委派。 */
  send(id: string, message: string): string {
    const t = this.tasks.get(id);
    if (!t) return `任务 ${id} 不存在`;
    if (t.status !== "running") {
      return `任务 ${id} 已结束(${t.status})，无法发送${t.reply ? `；当前结果: ${t.reply.slice(0, REPLY_PREVIEW)}` : ""}`;
    }
    t.pending.push(message);
    return `已发送给后台子 agent ${id}: ${message.slice(0, 60)}`;
  }

  /** V7 决策 C3：TaskStop——abort 传播 + 标记 stopped。幂等。 */
  stop(id: string): string {
    const t = this.tasks.get(id);
    if (!t) return `任务 ${id} 不存在`;
    if (t.status !== "running") return `任务 ${id} 已结束(${t.status})`;
    t.abort.abort();
    t.status = "stopped";
    return `已请求停止后台子 agent ${id}`;
  }

  /** 子查询迭代边界取 pending 并清空（SendMessage 送达）。无 pending → undefined（零开销）。 */
  poll(id: string): LLMMessage[] | undefined {
    const t = this.tasks.get(id);
    if (!t || t.pending.length === 0) return undefined;
    const msgs: LLMMessage[] = t.pending.map((m) => ({ role: "user", content: m }));
    t.pending = [];
    return msgs;
  }

  isAborted(id: string): boolean {
    return this.tasks.get(id)?.abort.signal.aborted ?? false;
  }

  /** V7 决策 A7：等全部 running 完成，返回「尚未报告过」任务的摘要行（done/stopped/failed 区分）。
   * 报告过的任务不再返回——第二次 end_turn 不会重复注入，防死循环。 */
  async awaitAll(): Promise<string[]> {
    const running = [...this.tasks.values()].filter((t) => t.status === "running");
    if (running.length > 0) await Promise.all(running.map((t) => t.done));
    const summaries: string[] = [];
    for (const t of this.tasks.values()) {
      if (t.reported) continue;
      t.reported = true;
      const preview = t.reply ? t.reply.slice(0, REPLY_PREVIEW) : "";
      const head = t.status === "stopped" ? "[已停止]" : t.status === "failed" ? "[失败]" : "";
      summaries.push(`- ${t.id}(${t.type}): ${head}${preview}`);
    }
    return summaries;
  }

  list(): BackgroundTaskInfo[] {
    return [...this.tasks.values()].map(({ id, type, prompt, status, reply }) => ({
      id,
      type,
      prompt,
      status,
      reply,
    }));
  }
}
