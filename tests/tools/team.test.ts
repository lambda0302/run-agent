import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSendMessageTool } from "../../src/tools/send_message.js";
import { makeTaskStopTool } from "../../src/tools/task_stop.js";
import { BackgroundTaskManager } from "../../src/services/agents/team/registry.js";

describe("协调者三件套：send_message / task_stop（V7 决策 C2/C3）", () => {
  let mgr: BackgroundTaskManager;

  beforeEach(() => {
    mgr = new BackgroundTaskManager();
  });

  it("send_message：透传 task_id/message 给 manager.send", async () => {
    const spy = vi.spyOn(mgr, "send").mockReturnValue("已发送");
    const tool = makeSendMessageTool(mgr);
    const r = await tool.call({ task_id: "task-3", message: "补充要求" });
    expect(spy).toHaveBeenCalledWith("task-3", "补充要求");
    expect(r.result).toBe("已发送");
  });

  it("send_message：任务不存在时返回提示（走 manager 真实逻辑）", async () => {
    const tool = makeSendMessageTool(mgr);
    const r = await tool.call({ task_id: "nope", message: "hi" });
    expect(r.result).toContain("不存在");
  });

  it("task_stop：透传 task_id 给 manager.stop", async () => {
    const spy = vi.spyOn(mgr, "stop").mockReturnValue("已停止");
    const tool = makeTaskStopTool(mgr);
    const r = await tool.call({ task_id: "task-2" });
    expect(spy).toHaveBeenCalledWith("task-2");
    expect(r.result).toBe("已停止");
  });

  it("task_stop：任务不存在时返回提示", async () => {
    const tool = makeTaskStopTool(mgr);
    const r = await tool.call({ task_id: "nope" });
    expect(r.result).toContain("不存在");
  });
});
