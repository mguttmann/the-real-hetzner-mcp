// Mutation proof for issue #54: the tests that assert "no request goes out" have
// to fail when the guard is removed, otherwise they are green for some other
// reason and would not notice a regression.
//
// `pathSegmentIssue` is neutered here (and only here) to the value it effectively
// had before the fix - "nothing is ever a problem" - while every other layer stays
// real: schema validation, encodeURIComponent at the interpolation site, and the
// client's own path assertions all still run. If the assertions in
// tests/origin-view-invariant.test.ts hold anyway, they are not testing the guard.
//
// This file therefore asserts the OPPOSITE of the rest of the suite: with the
// guard off, `hcloud_delete_zone {id_or_name: "../servers/42"}` must reach fetch
// as `/v1/zones/..%2Fservers%2F42` - the exact URL the issue reproduced, which the
// Hetzner API resolves to `/v1/servers/42`.
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/tools/_validate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tools/_validate.js")>();
  return { ...actual, pathSegmentIssue: () => null };
});

const { Client, InMemoryTransport } = await import("@modelcontextprotocol/client");
const { HetznerHttpClient } = await import("../src/http/client.js");
const { createMcpServer } = await import("../src/server.js");
const { createLogger } = await import("../src/logger.js");
const { ToolRegistry } = await import("../src/tools/registry.js");
const { buildGeneratedTools } = await import("../src/tools/generated/tools.js");
const { OPERATIONS } = await import("../src/tools/generated/operations.js");

const API_ORIGIN = "https://api.hetzner.cloud";

/** Same origin-decode view as tests/origin-view-invariant.test.ts. */
function originView(pathname: string): string {
  return pathname.replace(/%2f/gi, "/").replace(/%5c/gi, "\\").replace(/%2e/gi, ".");
}

async function unguarded() {
  const urls: string[] = [];
  const fetchImpl = vi.fn(async (input: unknown) => {
    urls.push(typeof input === "string" ? input : String((input as Request).url));
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });
  const client = new HetznerHttpClient({
    baseUrl: `${API_ORIGIN}/v1`,
    token: "mutation-token",
    fetch: fetchImpl as unknown as typeof globalThis.fetch,
    sleep: async () => {},
    maxRetries: 0,
  });
  const registry = new ToolRegistry();
  for (const tool of buildGeneratedTools(client, OPERATIONS, {
    maxItems: 20,
    maxPages: 2,
    actionPoll: { timeoutMs: 0, intervalMs: 0, sleep: async () => {}, now: () => 0 },
  })) {
    registry.register(tool);
  }
  const server = createMcpServer(registry, createLogger("error"));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcp = new Client({ name: "mutant", version: "0" }, { capabilities: {} });
  await mcp.connect(clientTransport);
  return {
    urls,
    async call(name: string, args: Record<string, unknown>) {
      const res = await mcp.callTool({ name, arguments: args });
      return { isError: res.isError === true };
    },
    async close() {
      await mcp.close();
      await server.close();
    },
  };
}

describe("issue #54 - the segment guard is what stops the traversal", () => {
  it("with the guard neutered, the reproduced request goes out again", async () => {
    const h = await unguarded();
    try {
      const res = await h.call("hcloud_delete_zone", { id_or_name: "../servers/42" });
      // Encoding and the client's path assertions are still active and still let
      // it through - that is precisely why the guard had to be added.
      expect(res.isError).toBe(false);
      expect(h.urls).toEqual([`${API_ORIGIN}/v1/zones/..%2Fservers%2F42`]);
      // And the URL that leaves the process is not stable under one decode: the
      // origin resolves it to /v1/servers/42.
      const pathname = new URL(h.urls[0]!).pathname;
      expect(originView(pathname)).toBe("/v1/zones/../servers/42");
      expect(new URL(`${API_ORIGIN}${originView(pathname)}`).pathname).toBe("/v1/servers/42");
    } finally {
      await h.close();
    }
  });

  it("with the guard neutered, the read pivot goes out again too", async () => {
    const h = await unguarded();
    try {
      expect((await h.call("hcloud_get_zone", { id_or_name: "../ssh_keys" })).isError).toBe(false);
      expect(h.urls).toEqual([`${API_ORIGIN}/v1/zones/..%2Fssh_keys`]);
      expect(
        new URL(`${API_ORIGIN}${originView(new URL(h.urls[0]!).pathname)}`).pathname,
      ).toBe("/v1/ssh_keys");
    } finally {
      await h.close();
    }
  });
});
