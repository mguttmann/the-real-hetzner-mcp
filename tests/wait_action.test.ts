import { describe, it, expect, vi } from "vitest";
import { makeWaitActionTool } from "../src/tools/wait_action.js";

const pollOpts = { timeoutMs: 1000, intervalMs: 1, sleep: async () => {}, now: () => 0 };

describe("hcloud_wait_action", () => {
  it("polls /actions/{id} until success", async () => {
    let n = 0;
    const request = vi.fn(async () => {
      n++;
      return {
        status: 200,
        headers: new Headers(),
        body: {
          action: {
            id: 5, command: "x",
            status: n < 3 ? "running" : "success",
            progress: n < 3 ? 50 : 100,
            started: "", finished: n < 3 ? null : "",
            resources: [], error: null,
          },
        },
      };
    });
    const tool = makeWaitActionTool({ client: { request } as any, defaultPoll: pollOpts });
    const res = await tool.handler({ id: 5 });
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.action.status).toBe("success");
    expect(parsed.polling_timed_out).toBe(false);
  });

  it("returns timed_out=true when the action stays running", async () => {
    const request = vi.fn(async () => ({
      status: 200, headers: new Headers(),
      body: { action: { id: 5, status: "running", command: "x", progress: 0, started: "", finished: null, resources: [], error: null } },
    }));
    let t = 0;
    const tool = makeWaitActionTool({
      client: { request } as any,
      defaultPoll: { timeoutMs: 50, intervalMs: 10, sleep: async (ms) => { t += ms; }, now: () => t },
    });
    const res = await tool.handler({ id: 5 });
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.polling_timed_out).toBe(true);
  });

  it("accepts a per-call timeout override", async () => {
    const request = vi.fn(async () => ({
      status: 200, headers: new Headers(),
      body: { action: { id: 5, status: "success", command: "x", progress: 100, started: "", finished: "", resources: [], error: null } },
    }));
    const tool = makeWaitActionTool({ client: { request } as any, defaultPoll: pollOpts });
    await tool.handler({ id: 5, timeout_ms: 500 });
    expect(request).toHaveBeenCalled();
  });
});
