import { describe, it, expect, vi } from "vitest";
import { makeServerBackupTool } from "../../src/tools/wrappers/server_backup.js";

const pollOpts = { timeoutMs: 1000, intervalMs: 1, sleep: async () => {}, now: () => 0 };

function responder() {
  return vi.fn(async (_m: string, p: string) => {
    return { status: p.startsWith("/actions/") ? 200 : 201, headers: new Headers(),
      body: { action: { id: 1, status: "success", command: "enable_backup", progress: 100, started: "", finished: "", resources: [], error: null } } };
  });
}

describe("hcloud_server_backup", () => {
  it("enables backup", async () => {
    const request = responder();
    const tool = makeServerBackupTool({ client: { request } as any, actionPoll: pollOpts });
    await tool.handler({ id: 5, enable: true });
    expect(request).toHaveBeenCalledWith("POST", "/servers/5/actions/enable_backup", {});
  });

  it("disables backup", async () => {
    const request = responder();
    const tool = makeServerBackupTool({ client: { request } as any, actionPoll: pollOpts });
    await tool.handler({ id: 5, enable: false });
    expect(request).toHaveBeenCalledWith("POST", "/servers/5/actions/disable_backup", {});
  });

  it("polls and returns final success action", async () => {
    let getCount = 0;
    const request = vi.fn(async (_m: string, p: string) => {
      if (p.endsWith("/actions/enable_backup")) {
        return {
          status: 201,
          headers: new Headers(),
          body: { action: { id: 7, status: "running", command: "enable_backup", progress: 0, started: "", finished: null, resources: [], error: null } },
        };
      }
      if (p === "/actions/7") {
        getCount++;
        const status = getCount >= 2 ? "success" : "running";
        return {
          status: 200,
          headers: new Headers(),
          body: { action: { id: 7, status, command: "enable_backup", progress: status === "success" ? 100 : 50, started: "", finished: status === "success" ? "" : null, resources: [], error: null } },
        };
      }
      throw new Error(`unexpected request: ${p}`);
    });
    const tool = makeServerBackupTool({ client: { request } as any, actionPoll: pollOpts });
    const res = await tool.handler({ id: 5, enable: true });
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.action.status).toBe("success");
    expect(parsed.polling_timed_out).toBe(false);
    expect(getCount).toBeGreaterThanOrEqual(2);
  });
});
