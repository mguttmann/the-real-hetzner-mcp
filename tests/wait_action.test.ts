import { describe, it, expect, vi } from "vitest";
import { makeWaitActionTool } from "../src/tools/wait_action.js";
import { INVALID_IDS, label } from "./_id-payloads.js";

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

  it("polls the exact path for a valid integer id (encoding is a no-op)", async () => {
    const request = vi.fn(async () => ({
      status: 200, headers: new Headers(),
      body: { action: { id: 5, status: "success", command: "x", progress: 100, started: "", finished: "", resources: [], error: null } },
    }));
    const tool = makeWaitActionTool({ client: { request } as any, defaultPoll: pollOpts });
    await tool.handler({ id: 5 });
    expect(request).toHaveBeenNthCalledWith(1, "GET", "/actions/5", { timeoutMs: expect.any(Number) });
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

describe("hcloud_wait_action clamps caller overrides", () => {
  const running = { id: 5, status: "running", command: "x", progress: 0, started: "", finished: null, resources: [], error: null };

  it("never waits longer than the configured poll budget, whatever timeout_ms asks for", async () => {
    const request = vi.fn(async () => ({ status: 200, headers: new Headers(), body: { action: running } }));
    let t = 0;
    const tool = makeWaitActionTool({
      client: { request } as any,
      defaultPoll: { timeoutMs: 45_000, intervalMs: 2_000, sleep: async (ms) => { t += ms; }, now: () => t },
    });
    const res = await tool.handler({ id: 5, timeout_ms: 3_600_000 });
    expect(JSON.parse((res.content[0] as { text: string }).text).polling_timed_out).toBe(true);
    expect(t).toBeLessThanOrEqual(45_000);
  });

  it("still lets timeout_ms shorten the wait", async () => {
    const request = vi.fn(async () => ({ status: 200, headers: new Headers(), body: { action: running } }));
    let t = 0;
    const tool = makeWaitActionTool({
      client: { request } as any,
      defaultPoll: { timeoutMs: 45_000, intervalMs: 2_000, sleep: async (ms) => { t += ms; }, now: () => t },
    });
    await tool.handler({ id: 5, timeout_ms: 5_000 });
    expect(t).toBeLessThanOrEqual(5_000);
  });

  it("does not poll faster than once a second, whatever interval_ms asks for", async () => {
    const request = vi.fn(async () => ({ status: 200, headers: new Headers(), body: { action: running } }));
    let t = 0;
    const sleeps: number[] = [];
    const tool = makeWaitActionTool({
      client: { request } as any,
      defaultPoll: { timeoutMs: 10_000, intervalMs: 2_000, sleep: async (ms) => { sleeps.push(ms); t += ms; }, now: () => t },
    });
    await tool.handler({ id: 5, interval_ms: 1 });
    expect(Math.min(...sleeps.slice(0, -1))).toBeGreaterThanOrEqual(1_000);
    expect(request.mock.calls.length).toBeLessThanOrEqual(11);
  });
});

describe("hcloud_wait_action - id guard (issue #54, sink S2)", () => {
  for (const [i, id] of INVALID_IDS.entries()) {
    it(`rejects id ${label(id, i)} without issuing any request`, async () => {
      const request = vi.fn();
      const tool = makeWaitActionTool({ client: { request } as any, defaultPoll: pollOpts });
      const res = await tool.handler({ id });
      expect(res.isError).toBe(true);
      expect((res.content[0] as { text: string }).text).toMatch(/Invalid `id`/);
      expect(request).not.toHaveBeenCalled();
    });
  }
});
