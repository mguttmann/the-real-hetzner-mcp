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
    expect(request).toHaveBeenCalledWith("GET", "/actions/1234");
  });
});
