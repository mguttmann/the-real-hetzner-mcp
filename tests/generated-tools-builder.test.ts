import { describe, it, expect, vi } from "vitest";
import { buildGeneratedTools } from "../src/tools/generated/tools.js";
import type { OperationDef } from "../src/types.js";

const fakeClient = (responder: (m: string, p: string, o?: any) => any) => ({
  request: vi.fn(async (...args: any[]) => responder(args[0], args[1], args[2])),
});

describe("buildGeneratedTools", () => {
  it("returns one ToolDef per operation", () => {
    const ops: OperationDef[] = [
      {
        operationId: "list_actions", toolName: "hcloud_list_actions",
        method: "GET", path: "/actions",
        summary: "List actions", description: "",
        tags: ["Actions"], parameters: [],
        returnsAction: false, isDestructive: false,
      },
    ];
    const client = fakeClient(() => ({ status: 200, headers: new Headers(), body: {} }));
    const tools = buildGeneratedTools(client as any, ops, { maxItems: 500, maxPages: 10 });
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("hcloud_list_actions");
    expect(tools[0]!.annotations.readOnlyHint).toBe(true);
  });

  it("substitutes path parameters", async () => {
    const ops: OperationDef[] = [
      {
        operationId: "get_server", toolName: "hcloud_get_server_raw",
        method: "GET", path: "/servers/{id}",
        summary: "", description: "", tags: [],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        returnsAction: false, isDestructive: false,
      },
    ];
    const client = fakeClient((m, p) => {
      expect(p).toBe("/servers/42");
      return { status: 200, headers: new Headers(), body: { server: { id: 42 } } };
    });
    const [tool] = buildGeneratedTools(client as any, ops, { maxItems: 500, maxPages: 10 });
    await tool!.handler({ id: 42 });
    expect(client.request).toHaveBeenCalled();
  });

  it("splits query and body", async () => {
    const ops: OperationDef[] = [
      {
        operationId: "create_server", toolName: "hcloud_create_server",
        method: "POST", path: "/servers",
        summary: "", description: "", tags: [],
        parameters: [{ name: "verbose", in: "query", required: false, schema: { type: "boolean" } }],
        requestBodySchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        returnsAction: false, isDestructive: false,
      },
    ];
    const client = fakeClient((m, p, o) => {
      expect(m).toBe("POST");
      expect(o.query).toEqual({ verbose: true });
      expect(o.body).toEqual({ name: "test" });
      return { status: 201, headers: new Headers(), body: { server: { id: 1, name: "test" } } };
    });
    const [tool] = buildGeneratedTools(client as any, ops, { maxItems: 500, maxPages: 10 });
    await tool!.handler({ verbose: true, body: { name: "test" } });
  });

  it("marks DELETE handlers as destructive in annotations", () => {
    const ops: OperationDef[] = [
      {
        operationId: "delete_server", toolName: "hcloud_delete_server",
        method: "DELETE", path: "/servers/{id}",
        summary: "", description: "", tags: [],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        returnsAction: false, isDestructive: true,
      },
    ];
    const client = fakeClient(() => ({ status: 204, headers: new Headers(), body: undefined }));
    const [tool] = buildGeneratedTools(client as any, ops, { maxItems: 500, maxPages: 10 });
    expect(tool!.annotations.destructiveHint).toBe(true);
    expect(tool!.annotations.readOnlyHint).toBe(false);
  });

  it("polls action when returnsAction=true (default wait=true)", async () => {
    const ops: OperationDef[] = [
      {
        operationId: "poweron_server", toolName: "hcloud_server_poweron_action",
        method: "POST", path: "/servers/{id}/actions/poweron",
        summary: "", description: "", tags: [],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        returnsAction: true, isDestructive: false,
      },
    ];
    let callIdx = 0;
    const client = {
      request: vi.fn(async (m: string, p: string) => {
        callIdx++;
        if (callIdx === 1) {
          // initial POST returns running action
          return {
            status: 201,
            headers: new Headers(),
            body: { action: { id: 7, status: "running", command: "poweron", progress: 50,
              started: "", finished: null, resources: [], error: null } },
          };
        }
        // subsequent GET /actions/7
        expect(p).toBe("/actions/7");
        return {
          status: 200,
          headers: new Headers(),
          body: { action: { id: 7, status: "success", command: "poweron", progress: 100,
            started: "", finished: "", resources: [], error: null } },
        };
      }),
    };
    const [tool] = buildGeneratedTools(client as any, ops, {
      maxItems: 500, maxPages: 10,
      actionPoll: { timeoutMs: 5000, intervalMs: 1, sleep: async () => {}, now: () => 0 },
    });
    const res = await tool!.handler({ id: 99 });
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.action.status).toBe("success");
    expect(client.request).toHaveBeenCalledTimes(2);
  });

  it("does NOT poll when wait=false", async () => {
    const ops: OperationDef[] = [
      {
        operationId: "poweron_server", toolName: "hcloud_server_poweron_action",
        method: "POST", path: "/servers/{id}/actions/poweron",
        summary: "", description: "", tags: [],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        returnsAction: true, isDestructive: false,
      },
    ];
    const client = {
      request: vi.fn(async () => ({
        status: 201, headers: new Headers(),
        body: { action: { id: 7, status: "running", command: "poweron", progress: 50,
          started: "", finished: null, resources: [], error: null } },
      })),
    };
    const [tool] = buildGeneratedTools(client as any, ops, { maxItems: 500, maxPages: 10 });
    await tool!.handler({ id: 99, wait: false });
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  it("surfaces Hetzner 4xx error envelope as isError, not as a happy-path body", async () => {
    const ops: OperationDef[] = [
      {
        operationId: "get_server", toolName: "hcloud_get_server_raw",
        method: "GET", path: "/servers/{id}",
        summary: "", description: "", tags: [],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        returnsAction: false, isDestructive: false,
      },
    ];
    const client = fakeClient(() => ({
      status: 401,
      headers: new Headers(),
      body: { error: { code: "unauthorized", message: "invalid token" } },
    }));
    const [tool] = buildGeneratedTools(client as any, ops, { maxItems: 500, maxPages: 10 });
    const res = await tool!.handler({ id: 42 });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("401");
    expect(text).toContain("unauthorized");
    expect(text).toContain("invalid token");
  });

  it("auto-paginates per-resource action history (GET /servers/{id}/actions)", async () => {
    const ops: OperationDef[] = [
      {
        operationId: "list_server_actions", toolName: "hcloud_list_server_actions",
        method: "GET", path: "/servers/{id}/actions",
        summary: "", description: "", tags: [],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        returnsAction: false, isDestructive: false,
      },
    ];
    const pages = [
      {
        actions: [{ id: 1 }, { id: 2 }],
        meta: { pagination: { page: 1, per_page: 2, next_page: 2, last_page: 2, total_entries: 4 } },
      },
      {
        actions: [{ id: 3 }, { id: 4 }],
        meta: { pagination: { page: 2, per_page: 2, next_page: null, last_page: 2, total_entries: 4 } },
      },
    ];
    let idx = 0;
    const client = {
      request: vi.fn(async (m: string, p: string) => {
        expect(m).toBe("GET");
        expect(p).toBe("/servers/42/actions");
        return { status: 200, headers: new Headers(), body: pages[idx++] };
      }),
    };
    const [tool] = buildGeneratedTools(client as any, ops, { maxItems: 500, maxPages: 10 });
    // auto_paginate should be on the input schema for this list endpoint
    expect((tool!.inputSchema as any).properties.auto_paginate).toBeTruthy();
    const res = await tool!.handler({ id: 42 });
    expect(client.request).toHaveBeenCalledTimes(2);
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.actions).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
    expect(parsed.truncated).toBe(false);
  });

  it("does NOT poll the action when the initial POST returns a 4xx", async () => {
    const ops: OperationDef[] = [
      {
        operationId: "poweron_server", toolName: "hcloud_server_poweron_action",
        method: "POST", path: "/servers/{id}/actions/poweron",
        summary: "", description: "", tags: [],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        returnsAction: true, isDestructive: false,
      },
    ];
    const client = {
      request: vi.fn(async () => ({
        status: 409,
        headers: new Headers(),
        body: { error: { code: "conflict", message: "locked" } },
      })),
    };
    const [tool] = buildGeneratedTools(client as any, ops, { maxItems: 500, maxPages: 10 });
    const res = await tool!.handler({ id: 99 });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain("conflict");
    // Crucially: we did NOT proceed to poll /actions/...
    expect(client.request).toHaveBeenCalledTimes(1);
  });
});
