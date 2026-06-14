import { describe, it, expect, vi } from "vitest";
import { makeServerRebuildTool } from "../../src/tools/wrappers/server_rebuild.js";

const pollOpts = { timeoutMs: 1000, intervalMs: 1, sleep: async () => {}, now: () => 0 };

function actionResponder() {
  return vi.fn(async (m: string, p: string, _o?: any) => {
    if (p.startsWith("/servers/") && p.endsWith("/actions/rebuild")) {
      return { status: 201, headers: new Headers(), body: { action: { id: 1, status: "running", command: "rebuild", progress: 0, started: "", finished: null, resources: [], error: null } } };
    }
    if (p.startsWith("/actions/")) {
      return { status: 200, headers: new Headers(), body: { action: { id: 1, status: "success", command: "rebuild", progress: 100, started: "", finished: "", resources: [], error: null } } };
    }
    throw new Error(`unexpected ${m} ${p}`);
  });
}

describe("hcloud_server_rebuild", () => {
  it("passes image as integer when image_id is provided", async () => {
    const request = actionResponder();
    const tool = makeServerRebuildTool({ client: { request } as any, actionPoll: pollOpts });
    await tool.handler({ id: 99, image_id: 42 });
    expect(request).toHaveBeenCalledWith("POST", "/servers/99/actions/rebuild", { body: { image: 42 } });
  });

  it("passes image as string when image_name is provided", async () => {
    const request = actionResponder();
    const tool = makeServerRebuildTool({ client: { request } as any, actionPoll: pollOpts });
    await tool.handler({ id: 99, image_name: "ubuntu-22.04" });
    expect(request).toHaveBeenCalledWith("POST", "/servers/99/actions/rebuild", { body: { image: "ubuntu-22.04" } });
  });

  it("rejects when both or neither image_id and image_name are given", async () => {
    const tool = makeServerRebuildTool({ client: { request: vi.fn() } as any, actionPoll: pollOpts });
    let res = await tool.handler({ id: 1 });
    expect(res.isError).toBe(true);
    res = await tool.handler({ id: 1, image_id: 2, image_name: "x" });
    expect(res.isError).toBe(true);
  });

  it("declares destructiveHint=true (rebuild is destructive)", () => {
    const tool = makeServerRebuildTool({ client: { request: vi.fn() } as any, actionPoll: pollOpts });
    expect(tool.annotations.destructiveHint).toBe(true);
  });

  it("polls and returns final success action", async () => {
    let getCount = 0;
    const request = vi.fn(async (_m: string, p: string) => {
      if (p.startsWith("/servers/") && p.endsWith("/actions/rebuild")) {
        return {
          status: 201,
          headers: new Headers(),
          body: { action: { id: 7, status: "running", command: "rebuild", progress: 0, started: "", finished: null, resources: [], error: null } },
        };
      }
      if (p === "/actions/7") {
        getCount++;
        const status = getCount >= 2 ? "success" : "running";
        return {
          status: 200,
          headers: new Headers(),
          body: { action: { id: 7, status, command: "rebuild", progress: status === "success" ? 100 : 50, started: "", finished: status === "success" ? "" : null, resources: [], error: null } },
        };
      }
      throw new Error(`unexpected request: ${p}`);
    });
    const tool = makeServerRebuildTool({ client: { request } as any, actionPoll: pollOpts });
    const res = await tool.handler({ id: 99, image_id: 42 });
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.action.status).toBe("success");
    expect(parsed.polling_timed_out).toBe(false);
    expect(getCount).toBeGreaterThanOrEqual(2);
  });
});
