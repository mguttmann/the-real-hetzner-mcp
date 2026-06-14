import { describe, it, expect, vi } from "vitest";
import { makeApplyFirewallToServerTool } from "../../src/tools/wrappers/apply_firewall_to_server.js";

const pollOpts = { timeoutMs: 1000, intervalMs: 1, sleep: async () => {}, now: () => 0 };

function responder() {
  return vi.fn(async (_m: string, p: string, opts?: any) => {
    if (p === "/firewalls" && opts?.query?.name === "web-fw") {
      return { status: 200, headers: new Headers(), body: {
        firewalls: [{ id: 11, name: "web-fw" }],
        meta: { pagination: { page: 1, per_page: 25, next_page: null, last_page: 1 } },
      }};
    }
    if (p.includes("/firewalls/11/actions/apply_to_resources")) {
      return { status: 201, headers: new Headers(), body: { actions: [
        { id: 1, status: "success", command: "apply_firewall", progress: 100, started: "", finished: "", resources: [{ id: 7, type: "server" }], error: null },
      ] } };
    }
    throw new Error(`unexpected ${p}`);
  });
}

describe("hcloud_apply_firewall_to_server", () => {
  it("looks up firewall by name and applies to server", async () => {
    const request = responder();
    const tool = makeApplyFirewallToServerTool({ client: { request } as any, actionPoll: pollOpts });
    await tool.handler({ firewall_name: "web-fw", server_id: 7 });
    const calls = request.mock.calls;
    expect(calls[0]![1]).toBe("/firewalls");
    expect(calls[1]![1]).toBe("/firewalls/11/actions/apply_to_resources");
    expect(calls[1]![2].body).toEqual({
      apply_to: [{ type: "server", server: { id: 7 } }],
    });
  });

  it("accepts firewall_id directly", async () => {
    const request = responder();
    const tool = makeApplyFirewallToServerTool({ client: { request } as any, actionPoll: pollOpts });
    await tool.handler({ firewall_id: 11, server_id: 7 });
    const calls = request.mock.calls;
    expect(calls[0]![1]).toBe("/firewalls/11/actions/apply_to_resources");
  });

  it("surfaces 4xx on the firewall lookup branch as isError, not 'not found'", async () => {
    const request = vi.fn(async () => ({
      status: 401,
      headers: new Headers(),
      body: { error: { code: "unauthorized", message: "invalid token" } },
    }));
    const tool = makeApplyFirewallToServerTool({ client: { request } as any, actionPoll: pollOpts });
    const res = await tool.handler({ firewall_name: "web-fw", server_id: 7 });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("401");
    expect(text).toContain("unauthorized");
    expect(text).toContain("invalid token");
    expect(text).not.toMatch(/not found/i);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
