import { describe, it, expect, vi } from "vitest";
import { makeServerPowerTool } from "../../src/tools/wrappers/server_power.js";

function client(success = true) {
  return {
    request: vi.fn(async (_m: string, p: string) => {
      const isAction = p.startsWith("/actions/");
      return {
        status: isAction ? 200 : 201,
        headers: new Headers(),
        body: {
          action: {
            id: 1,
            status: isAction ? (success ? "success" : "error") : "running",
            command: "poweron",
            progress: isAction ? 100 : 50,
            started: "",
            finished: isAction ? "" : null,
            resources: [],
            error: null,
          },
        },
      };
    }),
  };
}

const pollOpts = { timeoutMs: 1000, intervalMs: 1, sleep: async () => {}, now: () => 0 };

describe("hcloud_server_power", () => {
  it("dispatches POST /servers/{id}/actions/{op}", async () => {
    const c = client();
    const tool = makeServerPowerTool({ client: c as any, actionPoll: pollOpts });
    await tool.handler({ id: 42, op: "reboot" });
    expect(c.request).toHaveBeenCalledWith("POST", "/servers/42/actions/reboot", {});
  });

  it("rejects unknown op via schema enum (handler-side guard for safety)", async () => {
    const c = client();
    const tool = makeServerPowerTool({ client: c as any, actionPoll: pollOpts });
    const res = await tool.handler({ id: 1, op: "nuke" });
    expect(res.isError).toBe(true);
  });

  it("marks destructiveHint=true for poweroff/reset", () => {
    const c = client();
    const tool = makeServerPowerTool({ client: c as any, actionPoll: pollOpts });
    expect(tool.annotations.destructiveHint).toBe(true);
  });

  it("polls and returns final success action", async () => {
    const c = client(true);
    const tool = makeServerPowerTool({ client: c as any, actionPoll: pollOpts });
    const res = await tool.handler({ id: 42, op: "poweron" });
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.action.status).toBe("success");
  });
});
