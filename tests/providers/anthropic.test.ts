import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock 会被提升到文件顶部，因此 mock 工厂需要的数据必须用 vi.hoisted 定义，
// 否则会因暂时性死区(TDZ)报错。
// createMock 必须返回同一个实例（单例）：源码里是 `new Anthropic(...)`，若每次调用
// 返回新对象，new Anthropic() 与测试里 createMock() 会拿到不同实例，断言得到 0 次调用。
const { createMock, mockClient } = vi.hoisted(() => {
  const mockClient = {
    messages: {
      create: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "pong" }] }),
    },
  };
  return {
    createMock: vi.fn(function mockAnthropic() {
      return mockClient;
    }),
    mockClient,
  };
});

vi.mock("@anthropic-ai/sdk", () => ({ default: createMock }));

import { createAnthropicClient } from "../../src/providers/anthropic.js";

describe("createAnthropicClient", () => {
  beforeEach(() => {
    // 只清空调用记录，不清除实现（mockResolvedValue 等保留）
    vi.clearAllMocks();
  });

  it("调用 SDK 并返回文本", async () => {
    const client = createAnthropicClient({ apiKey: "test-key" });
    const reply = await client.chat([{ role: "user", content: "ping" }]);
    expect(reply).toBe("pong");
    expect(mockClient.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: expect.any(String) }),
    );
  });

  it("把 system 消息映射到顶层 system 参数", async () => {
    const client = createAnthropicClient({ apiKey: "test-key" });
    await client.chat([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ]);
    const args = mockClient.messages.create.mock.calls[0]![0];
    expect(args.system).toBe("be brief");
    expect(args.messages).toEqual([{ role: "user", content: "hi" }]);
  });
});
