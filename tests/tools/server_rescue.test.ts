import { describe, it, expect, vi } from "vitest";
import { makeServerRescueTool } from "../../src/tools/wrappers/server_rescue.js";
import { INVALID_IDS, label } from "../_id-payloads.js";
import { OPERATIONS } from "../../src/tools/generated/operations.js";

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
  it("offers exactly the rescue types the vendored spec accepts (B-018)", () => {
    const op = OPERATIONS.find((o) => o.toolName === "hcloud_server_enable_rescue_action");
    const specType = (op?.requestBodySchema as { properties: { type: { enum: string[]; default: string } } })
      .properties.type;
    const tool = makeServerRescueTool({ client: { request: vi.fn() } as any, actionPoll: pollOpts });
    const type = (tool.inputSchema as { properties: { type: { enum: string[]; default: string } } })
      .properties.type;
    expect(type.enum).toEqual(specType.enum);
    expect(type.default).toBe("linux64");
    expect(type.enum).toContain(type.default);
  });

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

describe("server_rescue - id guard (issue #54)", () => {
  for (const [i, id] of INVALID_IDS.entries()) {
    it(`rejects id ${label(id, i)} without issuing any request`, async () => {
      const request = vi.fn();
      const tool = makeServerRescueTool({ client: { request } as any, actionPoll: pollOpts });
      const res = await tool.handler({ id, enable: true });
      expect(res.isError).toBe(true);
      expect((res.content[0] as { text: string }).text).toMatch(/Invalid `id`/);
      expect(request).not.toHaveBeenCalled();
    });
  }

  it("leaves a valid integer id byte-identical in the path (encoding is a no-op)", async () => {
    const request = responder();
    const tool = makeServerRescueTool({ client: { request } as any, actionPoll: pollOpts });
    const res = await tool.handler({ id: 5, enable: true });
    expect(res.isError).toBeFalsy();
    expect(request).toHaveBeenCalledWith("POST", "/servers/5/actions/enable_rescue", { body: { type: "linux64" } });
  });
});

describe("server_rescue ssh_keys - a caller value is never silently dropped (refs #54 QA)", () => {
  function harness() {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const request = vi.fn(async (method: string, path: string, opts?: { body?: unknown }) => {
      calls.push({ method, path, body: opts?.body });
      return { ok: true, status: 201, body: { action: { id: 1, status: "success" } } };
    });
    const tool = makeServerRescueTool({
      client: { request } as never,
      actionPoll: { timeoutMs: 10, intervalMs: 1 },
    });
    return { tool, calls, request };
  }

  it("normalises a scalar ssh_keys into a one-element array", async () => {
    const { tool, calls } = harness();
    const res = await tool.handler({ id: 5, enable: true, ssh_keys: 42, wait: false });
    expect(res.isError).toBeUndefined();
    // The regression: previously the scalar was dropped and rescue mode came up
    // WITHOUT the requested key, while the call reported success.
    expect((calls[0]!.body as { ssh_keys?: unknown }).ssh_keys).toEqual([42]);
  });

  it("passes an array through unchanged", async () => {
    const { tool, calls } = harness();
    await tool.handler({ id: 5, enable: true, ssh_keys: [42, 43], wait: false });
    expect((calls[0]!.body as { ssh_keys?: unknown }).ssh_keys).toEqual([42, 43]);
  });

  it("refuses an unusable ssh_keys element instead of dropping it, and sends nothing", async () => {
    for (const bad of [["x"], [0], [-1], [1.5], [null], "x", 0]) {
      const { tool, request } = harness();
      const res = await tool.handler({ id: 5, enable: true, ssh_keys: bad, wait: false });
      expect(res.isError, `ssh_keys=${JSON.stringify(bad)}`).toBe(true);
      expect(request).not.toHaveBeenCalled();
    }
  });

  it("omits ssh_keys entirely when the caller omits it", async () => {
    const { tool, calls } = harness();
    await tool.handler({ id: 5, enable: true, wait: false });
    expect(calls[0]!.body).not.toHaveProperty("ssh_keys");
  });
});
