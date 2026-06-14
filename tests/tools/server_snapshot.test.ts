import { describe, it, expect, vi } from "vitest";
import { makeServerSnapshotTool } from "../../src/tools/wrappers/server_snapshot.js";

const pollOpts = { timeoutMs: 1000, intervalMs: 1, sleep: async () => {}, now: () => 0 };

function responder() {
  return vi.fn(async (_m: string, p: string) => {
    if (p.includes("/actions/create_image")) {
      return { status: 201, headers: new Headers(), body: {
        action: { id: 1, status: "running", command: "create_image", progress: 0, started: "", finished: null, resources: [], error: null },
        image: { id: 99, type: "snapshot", description: "test" },
      }};
    }
    return { status: 200, headers: new Headers(), body: { action: { id: 1, status: "success", command: "create_image", progress: 100, started: "", finished: "", resources: [], error: null } } };
  });
}

describe("hcloud_server_snapshot", () => {
  it("defaults type to 'snapshot' and forwards description/labels", async () => {
    const request = responder();
    const tool = makeServerSnapshotTool({ client: { request } as any, actionPoll: pollOpts });
    await tool.handler({ id: 7, description: "manual backup" });
    expect(request).toHaveBeenCalledWith(
      "POST",
      "/servers/7/actions/create_image",
      { body: { type: "snapshot", description: "manual backup" } },
    );
  });

  it("supports type='backup' explicitly", async () => {
    const request = responder();
    const tool = makeServerSnapshotTool({ client: { request } as any, actionPoll: pollOpts });
    await tool.handler({ id: 7, type: "backup", description: "x" });
    expect(request).toHaveBeenCalledWith(
      "POST",
      "/servers/7/actions/create_image",
      { body: { type: "backup", description: "x" } },
    );
  });

  it("polls and returns final success action", async () => {
    let getCount = 0;
    const request = vi.fn(async (_m: string, p: string) => {
      if (p.endsWith("/actions/create_image")) {
        return {
          status: 201,
          headers: new Headers(),
          body: {
            action: { id: 7, status: "running", command: "create_image", progress: 0, started: "", finished: null, resources: [], error: null },
            image: { id: 99, type: "snapshot", description: "test" },
          },
        };
      }
      if (p === "/actions/7") {
        getCount++;
        const status = getCount >= 2 ? "success" : "running";
        return {
          status: 200,
          headers: new Headers(),
          body: { action: { id: 7, status, command: "create_image", progress: status === "success" ? 100 : 50, started: "", finished: status === "success" ? "" : null, resources: [], error: null } },
        };
      }
      throw new Error(`unexpected request: ${p}`);
    });
    const tool = makeServerSnapshotTool({ client: { request } as any, actionPoll: pollOpts });
    const res = await tool.handler({ id: 7, description: "manual backup" });
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.action.status).toBe("success");
    expect(parsed.polling_timed_out).toBe(false);
    expect(getCount).toBeGreaterThanOrEqual(2);
  });
});
