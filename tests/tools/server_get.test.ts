import { describe, it, expect, vi } from "vitest";
import { makeServerGetTool } from "../../src/tools/wrappers/server_get.js";

function clientWith(handler: (m: string, p: string, o?: any) => any) {
  return { request: vi.fn(async (...args: any[]) => handler(args[0], args[1], args[2])) };
}

describe("hcloud_get_server wrapper", () => {
  it("fetches by numeric id directly", async () => {
    const client = clientWith((m, p) => {
      expect(m).toBe("GET");
      expect(p).toBe("/servers/42");
      return {
        status: 200,
        headers: new Headers(),
        body: { server: { id: 42, name: "test" } },
      };
    });
    const tool = makeServerGetTool(client as any);
    const res = await tool.handler({ id: 42 });
    const payload = JSON.parse((res.content[0] as { text: string }).text);
    expect(payload.server.id).toBe(42);
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  it("looks up by name via /servers?name=...", async () => {
    const client = clientWith((m, p, o) => {
      expect(m).toBe("GET");
      expect(p).toBe("/servers");
      expect(o.query.name).toBe("example-server-1");
      return {
        status: 200,
        headers: new Headers(),
        body: {
          servers: [{ id: 100, name: "example-server-1" }],
          meta: { pagination: { page: 1, per_page: 25, next_page: null, last_page: 1 } },
        },
      };
    });
    const tool = makeServerGetTool(client as any);
    const res = await tool.handler({ name: "example-server-1" });
    const payload = JSON.parse((res.content[0] as { text: string }).text);
    expect(payload.server.id).toBe(100);
  });

  it("returns isError when name has no match", async () => {
    const client = clientWith(() => ({
      status: 200,
      headers: new Headers(),
      body: {
        servers: [],
        meta: { pagination: { page: 1, per_page: 25, next_page: null, last_page: 1 } },
      },
    }));
    const tool = makeServerGetTool(client as any);
    const res = await tool.handler({ name: "nope" });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/not found/i);
  });

  it("requires either id or name", async () => {
    const client = clientWith(() => ({ status: 200, headers: new Headers(), body: {} }));
    const tool = makeServerGetTool(client as any);
    const res = await tool.handler({});
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/id.*name/i);
  });

  it("rejects when both id and name are provided", async () => {
    const client = clientWith(() => ({ status: 200, headers: new Headers(), body: {} }));
    const tool = makeServerGetTool(client as any);
    const res = await tool.handler({ id: 1, name: "foo" });
    expect(res.isError).toBe(true);
  });

  it("surfaces Hetzner 4xx error envelope as isError with code/message", async () => {
    const client = clientWith(() => ({
      status: 401,
      headers: new Headers(),
      body: { error: { code: "unauthorized", message: "invalid token" } },
    }));
    const tool = makeServerGetTool(client as any);
    const res = await tool.handler({ id: 42 });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("401");
    expect(text).toContain("unauthorized");
    expect(text).toContain("invalid token");
    expect(text).not.toMatch(/not found/i);
  });

  it("surfaces 4xx on the name-lookup branch as isError, not 'not found'", async () => {
    const client = clientWith(() => ({
      status: 403,
      headers: new Headers(),
      body: { error: { code: "forbidden", message: "missing scope" } },
    }));
    const tool = makeServerGetTool(client as any);
    const res = await tool.handler({ name: "anything" });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("403");
    expect(text).toContain("forbidden");
    expect(text).toContain("missing scope");
    expect(text).not.toMatch(/not found/i);
  });
});
