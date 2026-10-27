import { describe, it, expect } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createMcpServer } from "../src/server.js";
import { createLogger } from "../src/logger.js";
import { HetznerHttpClient } from "../src/http/client.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { makeServerListTool } from "../src/tools/wrappers/server_list.js";
import { makeWaitActionTool } from "../src/tools/wait_action.js";
import { makeServerRebuildTool } from "../src/tools/wrappers/server_rebuild.js";
import { buildGeneratedTools } from "../src/tools/generated/tools.js";
import { OPERATIONS } from "../src/tools/generated/operations.js";

// Non-2xx responses consumed by auto-pagination or action polling must reach the
// caller as isError with the same HetznerApiError text asToolError produces,
// never as an empty or partial list that looks complete.

type Route = (method: string, url: URL) => Response | Promise<Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const UNAUTHORIZED = { error: { code: "unauthorized", message: "unable to authenticate" } };
const UNAVAILABLE = { error: { code: "unavailable", message: "service unavailable" } };

async function callViaServer(route: Route, name: string, args: Record<string, unknown>) {
  const client = new HetznerHttpClient({
    baseUrl: "http://127.0.0.1:1/v1",
    token: "t",
    sleep: async () => {},
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return route(init?.method ?? "GET", url);
    }) as typeof globalThis.fetch,
  });
  const registry = new ToolRegistry();
  registry.register(makeServerListTool(client, { maxItems: 500, maxPages: 10 }));
  const poll = { timeoutMs: 5_000, intervalMs: 1, sleep: async () => {} };
  registry.register(makeWaitActionTool({ client, defaultPoll: poll }));
  registry.register(makeServerRebuildTool({ client, actionPoll: poll }));
  for (const tool of buildGeneratedTools(client, OPERATIONS, {
    maxItems: 500,
    maxPages: 10,
    actionPoll: poll,
  })) {
    if (!registry.getByName(tool.name)) registry.register(tool);
  }

  const server = createMcpServer(registry, createLogger("error"));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcp = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await mcp.connect(clientTransport);
  try {
    const result = await mcp.callTool({ name, arguments: args });
    return result as { content: Array<{ type: string; text: string }>; isError?: boolean };
  } finally {
    await mcp.close();
    await server.close();
  }
}

const page1 = {
  servers: [{ id: 1, name: "a" }],
  meta: {
    pagination: { page: 1, per_page: 1, previous_page: null, next_page: 2, last_page: 2, total_entries: 2 },
  },
};

describe("auto-pagination surfaces upstream errors", () => {
  for (const tool of ["hcloud_list_servers", "hcloud_list_servers_raw"]) {
    it(`${tool}: 401 on page 1 is isError with the Hetzner error text`, async () => {
      const res = await callViaServer(() => json(401, UNAUTHORIZED), tool, {});
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toBe("HetznerApiError[401 unauthorized]: unable to authenticate");
    });

    it(`${tool}: 503 on page 2 is isError, not a partial list`, async () => {
      const res = await callViaServer(
        (_m, url) => (url.searchParams.get("page") === "2" ? json(503, UNAVAILABLE) : json(200, page1)),
        tool,
        {},
      );
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toBe("HetznerApiError[503 unavailable]: service unavailable");
    });
  }

  it("a per-resource action list with 404 is isError", async () => {
    const res = await callViaServer(
      () => json(404, { error: { code: "not_found", message: "server not found" } }),
      "hcloud_list_server_actions",
      { id: 5 },
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe("HetznerApiError[404 not_found]: server not found");
  });
});

describe("action polling surfaces upstream errors", () => {
  it("hcloud_wait_action: 404 on /actions/{id} is isError at once, not a synthetic running action", async () => {
    let polls = 0;
    const res = await callViaServer(
      () => {
        polls++;
        return json(404, { error: { code: "not_found", message: "action not found" } });
      },
      "hcloud_wait_action",
      { id: 99 },
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe("HetznerApiError[404 not_found]: action not found");
    expect(polls).toBe(1);
  });
});

describe("hcloud_get_pricing", () => {
  const pricing = { pricing: { currency: "EUR", vat_rate: "19.00", server_types: [] } };

  it("works with default arguments and returns the pricing object", async () => {
    const res = await callViaServer(() => json(200, pricing), "hcloud_get_pricing", {});
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0]!.text)).toEqual(pricing);
  });

  it("keeps auto_paginate in its schema (contract unchanged)", () => {
    const client = new HetznerHttpClient({ baseUrl: "http://127.0.0.1:1/v1", token: "t" });
    const tool = buildGeneratedTools(client, OPERATIONS, { maxItems: 1, maxPages: 1 })
      .find((t) => t.name === "hcloud_get_pricing")!;
    expect(Object.keys(tool.inputSchema.properties as object)).toEqual(["auto_paginate"]);
  });

  it("surfaces a 401 as isError", async () => {
    const res = await callViaServer(() => json(401, UNAUTHORIZED), "hcloud_get_pricing", {});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe("HetznerApiError[401 unauthorized]: unable to authenticate");
  });
});

describe("a poll failure after a successful write keeps the write result", () => {
  const running = { id: 99, command: "create_server", status: "running", progress: 0,
    started: "2026-10-27T10:00:00Z", finished: null, resources: [], error: null };
  const created = { server: { id: 4711, name: "web-1" }, root_password: "S3cret", action: running };

  const failures: Array<[string, () => Response, string]> = [
    ["the poll request throws", () => { throw new TypeError("fetch failed"); }, "fetch failed"],
    ["the poll answers 503", () => json(503, UNAVAILABLE), "HetznerApiError[503 unavailable]: service unavailable"],
  ];

  for (const [label, failPoll, expected] of failures) {
    it(`hcloud_create_server: ${label} -> write body plus polling_error, not isError`, async () => {
      const res = await callViaServer(
        (method, url) => (method === "POST" && url.pathname === "/v1/servers" ? json(201, created) : failPoll()),
        "hcloud_create_server",
        { body: { name: "web-1", server_type: "cx22", image: "ubuntu-24.04" } },
      );
      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse(res.content[0]!.text);
      expect(parsed.server.id).toBe(4711);
      expect(parsed.root_password).toBe("S3cret");
      expect(parsed.action).toEqual(running);
      expect(parsed.polling_timed_out).toBe(true);
      expect(parsed.polling_error).toBe(expected);
    });
  }

  it("hcloud_server_rebuild: the poll request throws -> root_password kept", async () => {
    const res = await callViaServer(
      (method) => {
        if (method === "POST") return json(201, { root_password: "R3build", action: { ...running, command: "rebuild_server" } });
        throw new TypeError("fetch failed");
      },
      "hcloud_server_rebuild",
      { id: 42, image_name: "ubuntu-24.04" },
    );
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content[0]!.text);
    expect(parsed.root_password).toBe("R3build");
    expect(parsed.polling_timed_out).toBe(true);
    expect(parsed.polling_error).toBe("fetch failed");
  });
});
