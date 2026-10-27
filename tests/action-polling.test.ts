import { describe, it, expect, vi } from "vitest";
import { pollAction } from "../src/http/action-polling.js";

function actionResponse(status: "running" | "success" | "error", id = 99) {
  return {
    status: 200,
    headers: new Headers(),
    body: {
      action: {
        id,
        command: "reboot",
        status,
        progress: status === "success" ? 100 : 50,
        started: "2026-05-25T10:00:00Z",
        finished: status === "running" ? null : "2026-05-25T10:00:05Z",
        resources: [{ id, type: "server" }],
        error: status === "error" ? { code: "fail", message: "nope" } : null,
      },
    },
  };
}

describe("pollAction", () => {
  it("polls until status is success", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(actionResponse("running"))
      .mockResolvedValueOnce(actionResponse("running"))
      .mockResolvedValueOnce(actionResponse("success"));
    const sleeps: number[] = [];

    const result = await pollAction(request, 99, {
      timeoutMs: 60_000,
      intervalMs: 1_000,
      sleep: async (ms) => { sleeps.push(ms); },
      now: () => 0,
    });

    expect(result.timedOut).toBe(false);
    expect(result.action.status).toBe("success");
    expect(request).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1000, 1000]);
  });

  it("returns immediately on error status", async () => {
    const request = vi.fn().mockResolvedValueOnce(actionResponse("error"));
    const result = await pollAction(request, 99, {
      timeoutMs: 60_000,
      intervalMs: 1_000,
      sleep: async () => {},
      now: () => 0,
    });
    expect(result.timedOut).toBe(false);
    expect(result.action.status).toBe("error");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("times out and returns last seen action with timedOut=true", async () => {
    const request = vi.fn().mockResolvedValue(actionResponse("running"));
    let t = 0;
    const result = await pollAction(request, 99, {
      timeoutMs: 5_000,
      intervalMs: 1_000,
      sleep: async (ms) => { t += ms; },
      now: () => t,
    });
    expect(result.timedOut).toBe(true);
    expect(result.action.status).toBe("running");
    expect(request).toHaveBeenCalled();
  });

  it("polls correct path", async () => {
    const request = vi.fn().mockResolvedValueOnce(actionResponse("success"));
    await pollAction(request, 1234, {
      timeoutMs: 1_000,
      intervalMs: 100,
      sleep: async () => {},
      now: () => 0,
    });
    expect(request.mock.calls[0]!.slice(0, 2)).toEqual(["GET", "/actions/1234"]);
  });
});

describe("pollAction - path encoding (issue #54, layer b)", () => {
  it("percent-encodes a hostile actionId instead of letting it reshape the path", async () => {
    const request = vi.fn().mockResolvedValueOnce(actionResponse("success"));
    await pollAction(request, "42/../../ssh_keys#" as unknown as number, {
      timeoutMs: 1_000,
      intervalMs: 100,
      sleep: async () => {},
      now: () => 0,
    });
    expect(request.mock.calls[0]![1]).toBe("/actions/42%2F..%2F..%2Fssh_keys%23");
  });

  it("percent-encodes a query/fragment truncation payload", async () => {
    const request = vi.fn().mockResolvedValueOnce(actionResponse("success"));
    await pollAction(request, "42?x=1" as unknown as number, {
      timeoutMs: 1_000,
      intervalMs: 100,
      sleep: async () => {},
      now: () => 0,
    });
    expect(request.mock.calls[0]![1]).toBe("/actions/42%3Fx%3D1");
  });
});

describe("pollAction: wall-clock budget", () => {
  it("counts the time spent in poll requests and clips each request to the remaining budget", async () => {
    let t = 0;
    const budgets: number[] = [];
    const request = vi.fn(async (_m: string, _p: string, o?: { timeoutMs?: number }) => {
      budgets.push(o!.timeoutMs!);
      t += 3_000; // every poll request takes 3 s
      return actionResponse("running");
    });
    const result = await pollAction(request as any, 99, {
      timeoutMs: 10_000,
      intervalMs: 2_000,
      sleep: async (ms) => { t += ms; },
      now: () => t,
    });
    expect(result.timedOut).toBe(true);
    expect(t).toBeLessThanOrEqual(10_000 + 3_000);
    expect(budgets).toEqual([10_000, 5_000]);
  });

  it("starts the budget at startedAt and returns the initial action when nothing is left", async () => {
    const request = vi.fn();
    const initial = actionResponse("running", 7).body.action;
    const result = await pollAction(request, 7, {
      timeoutMs: 5_000,
      intervalMs: 1_000,
      sleep: async () => {},
      now: () => 6_000,
      startedAt: 0,
    }, initial as any);
    expect(request).not.toHaveBeenCalled();
    expect(result).toEqual({ action: initial, timedOut: true });
  });
});
