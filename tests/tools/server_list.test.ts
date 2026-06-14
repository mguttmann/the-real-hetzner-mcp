import { describe, it, expect, vi } from "vitest";
import { makeServerListTool } from "../../src/tools/wrappers/server_list.js";

function fakeClient(servers: Array<{ id: number; name: string }>) {
  return {
    request: vi.fn(async () => ({
      status: 200,
      headers: new Headers(),
      body: {
        servers,
        meta: {
          pagination: {
            page: 1,
            per_page: servers.length,
            next_page: null,
            last_page: 1,
            total_entries: servers.length,
          },
        },
      },
    })),
  };
}

describe("hcloud_list_servers wrapper", () => {
  it("returns all servers when no filter is given", async () => {
    const client = fakeClient([
      { id: 1, name: "alpha" },
      { id: 2, name: "beta" },
    ]);
    const tool = makeServerListTool(client as any, { maxItems: 500, maxPages: 10 });
    const res = await tool.handler({});
    const payload = JSON.parse(
      (res.content[0] as { text: string }).text,
    ) as { servers: Array<{ name: string }> };
    expect(payload.servers.map((s) => s.name)).toEqual(["alpha", "beta"]);
  });

  it("filters by name_contains case-insensitively", async () => {
    const client = fakeClient([
      { id: 1, name: "Alpha-Prod" },
      { id: 2, name: "Beta-Dev" },
      { id: 3, name: "ALPHA-Stage" },
    ]);
    const tool = makeServerListTool(client as any, { maxItems: 500, maxPages: 10 });
    const res = await tool.handler({ name_contains: "alpha" });
    const payload = JSON.parse(
      (res.content[0] as { text: string }).text,
    ) as { servers: Array<{ id: number }> };
    expect(payload.servers.map((s) => s.id).sort()).toEqual([1, 3]);
  });

  it("defaults sort to name", async () => {
    const client = fakeClient([]);
    const tool = makeServerListTool(client as any, { maxItems: 500, maxPages: 10 });
    await tool.handler({});
    const callArgs = client.request.mock.calls[0]!;
    expect(callArgs[0]).toBe("GET");
    expect(callArgs[1]).toBe("/servers");
    expect((callArgs[2] as { query: { sort: string } }).query.sort).toBe("name");
  });

  it("uses caller-provided sort verbatim", async () => {
    const client = fakeClient([]);
    const tool = makeServerListTool(client as any, { maxItems: 500, maxPages: 10 });
    await tool.handler({ sort: "created" });
    const callArgs = client.request.mock.calls[0]!;
    expect((callArgs[2] as { query: { sort: string } }).query.sort).toBe("created");
  });

  it("declares readOnlyHint=true and destructiveHint=false", () => {
    const client = fakeClient([]);
    const tool = makeServerListTool(client as any, { maxItems: 500, maxPages: 10 });
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.annotations.destructiveHint).toBe(false);
  });
});
