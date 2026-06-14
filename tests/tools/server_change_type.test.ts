import { describe, it, expect, vi } from "vitest";
import { makeServerChangeTypeTool } from "../../src/tools/wrappers/server_change_type.js";

const pollOpts = { timeoutMs: 1000, intervalMs: 1, sleep: async () => {}, now: () => 0 };

function actionResponder() {
  return vi.fn(async (_m: string, p: string) => {
    if (p.includes("/actions/change_type")) {
      return { status: 201, headers: new Headers(), body: { action: { id: 1, status: "running", command: "change_type", progress: 0, started: "", finished: null, resources: [], error: null } } };
    }
    return { status: 200, headers: new Headers(), body: { action: { id: 1, status: "success", command: "change_type", progress: 100, started: "", finished: "", resources: [], error: null } } };
  });
}

describe("hcloud_server_change_type", () => {
  it("sends server_type and upgrade_disk:false by default", async () => {
    const request = actionResponder();
    const tool = makeServerChangeTypeTool({ client: { request } as any, actionPoll: pollOpts });
    await tool.handler({ id: 9, server_type: "cpx41" });
    expect(request).toHaveBeenCalledWith(
      "POST",
      "/servers/9/actions/change_type",
      { body: { server_type: "cpx41", upgrade_disk: false } },
    );
  });

  it("honours upgrade_disk:true when explicitly given", async () => {
    const request = actionResponder();
    const tool = makeServerChangeTypeTool({ client: { request } as any, actionPoll: pollOpts });
    await tool.handler({ id: 1, server_type: "cpx21", upgrade_disk: true });
    expect(request).toHaveBeenCalledWith(
      "POST",
      "/servers/1/actions/change_type",
      { body: { server_type: "cpx21", upgrade_disk: true } },
    );
  });

  it("polls and returns final success action", async () => {
    let getCount = 0;
    const request = vi.fn(async (_m: string, p: string) => {
      if (p.endsWith("/actions/change_type")) {
        return {
          status: 201,
          headers: new Headers(),
          body: { action: { id: 7, status: "running", command: "change_type", progress: 0, started: "", finished: null, resources: [], error: null } },
        };
      }
      if (p === "/actions/7") {
        getCount++;
        const status = getCount >= 2 ? "success" : "running";
        return {
          status: 200,
          headers: new Headers(),
          body: { action: { id: 7, status, command: "change_type", progress: status === "success" ? 100 : 50, started: "", finished: status === "success" ? "" : null, resources: [], error: null } },
        };
      }
      throw new Error(`unexpected request: ${p}`);
    });
    const tool = makeServerChangeTypeTool({ client: { request } as any, actionPoll: pollOpts });
    const res = await tool.handler({ id: 9, server_type: "cpx41" });
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.action.status).toBe("success");
    expect(parsed.polling_timed_out).toBe(false);
    expect(getCount).toBeGreaterThanOrEqual(2);
  });
});
