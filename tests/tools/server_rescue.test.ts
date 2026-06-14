import { describe, it, expect, vi } from "vitest";
import { makeServerRescueTool } from "../../src/tools/wrappers/server_rescue.js";

const pollOpts = { timeoutMs: 1000, intervalMs: 1, sleep: async () => {}, now: () => 0 };

function responder() {
  return vi.fn(async (_m: string, p: string) => ({
    status: p.startsWith("/actions/") ? 200 : 201,
    headers: new Headers(),
    body: {
      action: { id: 1, status: "success", command: "enable_rescue", progress: 100, started: "", finished: "", resources: [], error: null },
      root_password: "secret",
    },
  }));
}

describe("hcloud_server_rescue", () => {
  it("enables rescue with default type linux64", async () => {
    const request = responder();
    const tool = makeServerRescueTool({ client: { request } as any, actionPoll: pollOpts });
    await tool.handler({ id: 5, enable: true });
    expect(request).toHaveBeenCalledWith(
      "POST",
      "/servers/5/actions/enable_rescue",
      { body: { type: "linux64" } },
    );
  });

  it("forwards ssh_keys when given", async () => {
    const request = responder();
    const tool = makeServerRescueTool({ client: { request } as any, actionPoll: pollOpts });
    await tool.handler({ id: 5, enable: true, ssh_keys: [1, 2] });
    expect(request).toHaveBeenCalledWith(
      "POST",
      "/servers/5/actions/enable_rescue",
      { body: { type: "linux64", ssh_keys: [1, 2] } },
    );
  });

  it("disables rescue", async () => {
    const request = responder();
    const tool = makeServerRescueTool({ client: { request } as any, actionPoll: pollOpts });
    await tool.handler({ id: 5, enable: false });
    expect(request).toHaveBeenCalledWith("POST", "/servers/5/actions/disable_rescue", {});
  });

  it("polls and returns final success action", async () => {
    let getCount = 0;
    const request = vi.fn(async (_m: string, p: string) => {
      if (p.endsWith("/actions/enable_rescue")) {
        return {
          status: 201,
          headers: new Headers(),
          body: {
            action: { id: 7, status: "running", command: "enable_rescue", progress: 0, started: "", finished: null, resources: [], error: null },
            root_password: "secret",
          },
        };
      }
      if (p === "/actions/7") {
        getCount++;
        const status = getCount >= 2 ? "success" : "running";
        return {
          status: 200,
          headers: new Headers(),
          body: { action: { id: 7, status, command: "enable_rescue", progress: status === "success" ? 100 : 50, started: "", finished: status === "success" ? "" : null, resources: [], error: null } },
        };
      }
      throw new Error(`unexpected request: ${p}`);
    });
    const tool = makeServerRescueTool({ client: { request } as any, actionPoll: pollOpts });
    const res = await tool.handler({ id: 5, enable: true });
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.action.status).toBe("success");
    expect(parsed.polling_timed_out).toBe(false);
    expect(getCount).toBeGreaterThanOrEqual(2);
  });
});
