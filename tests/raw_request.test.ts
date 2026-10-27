import { describe, it, expect, vi } from "vitest";
import { makeRawRequestTool } from "../src/tools/raw_request.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { HetznerHttpClient } from "../src/http/client.js";
import { createMcpServer } from "../src/server.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createLogger } from "../src/logger.js";

describe("hcloud_raw_request", () => {
  it("forwards method, path, query, body verbatim", async () => {
    const request = vi.fn(async () => ({
      status: 200,
      headers: new Headers(),
      body: { ok: true },
    }));
    const tool = makeRawRequestTool({
      client: { request } as any,
      confirmWrites: false,
    });
    await tool.handler({
      method: "POST",
      path: "/networks",
      query: { foo: "bar" },
      body: { name: "test" },
    });
    expect(request).toHaveBeenCalledWith("POST", "/networks", {
      query: { foo: "bar" },
      body: { name: "test" },
    });
  });

  it("rejects percent-encoded separators and dots in the path, sending nothing (B-020)", async () => {
    // The origin decodes these before routing, so inside one segment they would
    // still change which path is addressed.
    const request = vi.fn();
    const tool = makeRawRequestTool({ client: { request } as any, confirmWrites: false });
    for (const path of [
      "/servers/1%2Factions",
      "/servers/1%2factions",
      "/servers/1%5Cactions",
      "/servers/1%5cactions",
      "/servers/%2E",
      "/servers/a%2eb",
    ]) {
      const res = await tool.handler({ method: "GET", path });
      expect(res.isError, path).toBe(true);
      expect((res.content[0] as { text: string }).text).toMatch(/percent-encoded/);
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("still forwards other percent-encoded characters (B-020)", async () => {
    const request = vi.fn(async () => ({ status: 200, headers: new Headers(), body: {} }));
    const tool = makeRawRequestTool({ client: { request } as any, confirmWrites: false });
    const res = await tool.handler({ method: "GET", path: "/zones/m%C3%BCnchen.de/rrsets/%40/A" });
    expect(res.isError).toBeUndefined();
    expect(request).toHaveBeenCalledWith("GET", "/zones/m%C3%BCnchen.de/rrsets/%40/A", {
      query: undefined,
      body: undefined,
    });
  });

  it("rejects unsupported methods", async () => {
    const tool = makeRawRequestTool({
      client: { request: vi.fn() } as any,
      confirmWrites: false,
    });
    const res = await tool.handler({ method: "OPTIONS", path: "/x" });
    expect(res.isError).toBe(true);
  });

  it("rejects paths that do not start with '/'", async () => {
    const tool = makeRawRequestTool({
      client: { request: vi.fn() } as any,
      confirmWrites: false,
    });
    const res = await tool.handler({ method: "GET", path: "servers" });
    expect(res.isError).toBe(true);
  });

  it("returns the raw response body and status", async () => {
    const request = vi.fn(async () => ({
      status: 201,
      headers: new Headers({ "x-foo": "bar" }),
      body: { created: 1 },
    }));
    const tool = makeRawRequestTool({
      client: { request } as any,
      confirmWrites: false,
    });
    const res = await tool.handler({ method: "POST", path: "/x", body: {} });
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed).toMatchObject({ status: 201, body: { created: 1 } });
  });

  it("declares openWorld and destructive=true (caller controls method)", () => {
    const tool = makeRawRequestTool({
      client: { request: vi.fn() } as any,
      confirmWrites: false,
    });
    expect(tool.annotations.destructiveHint).toBe(true);
    expect(tool.annotations.openWorldHint).toBe(true);
  });

  describe("confirm-mode (self-guarded per spec §16)", () => {
    it("passes GET through even when confirmWrites=true and no confirm provided", async () => {
      const request = vi.fn(async () => ({
        status: 200,
        headers: new Headers(),
        body: { servers: [] },
      }));
      const tool = makeRawRequestTool({
        client: { request } as any,
        confirmWrites: true,
      });
      const res = await tool.handler({ method: "GET", path: "/servers" });
      expect(request).toHaveBeenCalledWith("GET", "/servers", {
        query: undefined,
        body: undefined,
      });
      expect((res.content[0] as { text: string }).text).not.toMatch(/PREVIEW/i);
    });

    it("returns PREVIEW for POST when confirmWrites=true and confirm missing", async () => {
      const request = vi.fn();
      const tool = makeRawRequestTool({
        client: { request } as any,
        confirmWrites: true,
      });
      const res = await tool.handler({
        method: "POST",
        path: "/networks",
        body: { name: "n" },
      });
      expect(request).not.toHaveBeenCalled();
      expect((res.content[0] as { text: string }).text).toMatch(/PREVIEW/i);
      expect((res.content[0] as { text: string }).text).toMatch(/hcloud_raw_request/);
      expect(res.isError).toBeFalsy();
    });

    it("executes POST when confirmWrites=true and confirm='YES'", async () => {
      const request = vi.fn(async () => ({
        status: 201,
        headers: new Headers(),
        body: { id: 7 },
      }));
      const tool = makeRawRequestTool({
        client: { request } as any,
        confirmWrites: true,
      });
      const res = await tool.handler({
        method: "POST",
        path: "/networks",
        body: { name: "n" },
        confirm: "YES",
      });
      expect(request).toHaveBeenCalledWith("POST", "/networks", {
        query: undefined,
        body: { name: "n" },
      });
      expect((res.content[0] as { text: string }).text).not.toMatch(/PREVIEW/i);
    });

    it("guards PUT/PATCH/DELETE like POST when confirmWrites=true", async () => {
      for (const method of ["PUT", "PATCH", "DELETE"] as const) {
        const request = vi.fn();
        const tool = makeRawRequestTool({
          client: { request } as any,
          confirmWrites: true,
        });
        const res = await tool.handler({ method, path: "/x" });
        expect(request, `${method} should preview`).not.toHaveBeenCalled();
        expect(
          (res.content[0] as { text: string }).text,
          `${method} should produce PREVIEW`,
        ).toMatch(/PREVIEW/i);
      }
    });

    it("ignores confirm and passes through all methods when confirmWrites=false", async () => {
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
        const request = vi.fn(async () => ({
          status: 200,
          headers: new Headers(),
          body: null,
        }));
        const tool = makeRawRequestTool({
          client: { request } as any,
          confirmWrites: false,
        });
        await tool.handler({ method, path: "/x" });
        expect(request, `${method} should pass through`).toHaveBeenCalled();
      }
    });

    it("does not require confirm for GET when confirmWrites=true even if confirm is provided", async () => {
      const request = vi.fn(async () => ({
        status: 200,
        headers: new Headers(),
        body: null,
      }));
      const tool = makeRawRequestTool({
        client: { request } as any,
        confirmWrites: true,
      });
      await tool.handler({ method: "GET", path: "/servers", confirm: "YES" });
      expect(request).toHaveBeenCalled();
    });
  });

  describe("body schema", () => {
    it("declares an explicit type array for body in inputSchema", () => {
      const tool = makeRawRequestTool({
        client: { request: vi.fn() } as any,
        confirmWrites: false,
      });
      const props = (tool.inputSchema as any).properties;
      expect(props.body.type).toEqual([
        "object",
        "array",
        "string",
        "number",
        "boolean",
        "null",
      ]);
    });

    it("forwards non-object body values (e.g. string) to the client unchanged", async () => {
      const request = vi.fn(async () => ({
        status: 200,
        headers: new Headers(),
        body: null,
      }));
      const tool = makeRawRequestTool({
        client: { request } as any,
        confirmWrites: false,
      });
      await tool.handler({ method: "POST", path: "/x", body: "string body" });
      expect(request).toHaveBeenCalledWith("POST", "/x", {
        query: undefined,
        body: "string body",
      });
    });

    it("declares confirm in inputSchema (always present, even when guard inactive)", () => {
      const tool = makeRawRequestTool({
        client: { request: vi.fn() } as any,
        confirmWrites: false,
      });
      const props = (tool.inputSchema as any).properties;
      expect(props.confirm).toBeDefined();
      expect(props.confirm.enum).toEqual(["YES"]);
    });
  });
});

describe("hcloud_raw_request - path hardening reaches the caller (issue #54)", () => {
  function serve() {
    const fetchImpl = vi.fn(async () =>
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
    const client = new HetznerHttpClient({
      baseUrl: "https://api.hetzner.cloud/v1",
      token: "secret",
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
    });
    const registry = new ToolRegistry();
    registry.register(makeRawRequestTool({ client, confirmWrites: false }));
    return { registry, fetchImpl };
  }

  async function callTool(
    registry: ToolRegistry,
    args: Record<string, unknown>,
  ): Promise<{ isError?: boolean; text: string }> {
    const server = createMcpServer(registry, createLogger("error"));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const mcp = new Client({ name: "test", version: "0" }, { capabilities: {} });
    await mcp.connect(clientTransport);
    const res = await mcp.callTool({ name: "hcloud_raw_request", arguments: args });
    await mcp.close();
    await server.close();
    return {
      isError: res.isError as boolean | undefined,
      text: (res.content as Array<{ text: string }>)[0]!.text,
    };
  }

  it("turns a query string inside `path` into an isError result pointing at `query`", async () => {
    const { registry, fetchImpl } = serve();
    const res = await callTool(registry, { method: "GET", path: "/servers?name=x" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/`query` field/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks a traversal payload and never leaks the bearer token", async () => {
    const { registry, fetchImpl } = serve();
    const res = await callTool(registry, { method: "POST", path: "/servers/1/../../ssh_keys" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/".." segments are not allowed/);
    expect(res.text).not.toMatch(/secret|Bearer/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("still forwards a legitimate path with a separate query object", async () => {
    const { registry, fetchImpl } = serve();
    const res = await callTool(registry, {
      method: "GET",
      path: "/servers",
      query: { name: "web-1" },
    });
    expect(res.isError).toBeFalsy();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toBe(
      "https://api.hetzner.cloud/v1/servers?name=web-1",
    );
  });

  it("describes what the client really applies: token, retries, no pagination (B-002)", async () => {
    const calls: Array<{ method: string; auth: string | null }> = [];
    let n = 0;
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        method: String(init?.method),
        auth: new Headers(init?.headers).get("authorization"),
      });
      n++;
      return n === 1
        ? new Response("{}", { status: 503, headers: { "content-type": "application/json" } })
        : new Response('{"servers":[]}', { status: 200, headers: { "content-type": "application/json" } });
    };
    const client = new HetznerHttpClient({
      baseUrl: "https://api.hetzner.cloud/v1",
      token: "secret",
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      sleep: async () => {},
    });
    const tool = makeRawRequestTool({ client, confirmWrites: false });
    const res = await tool.handler({ method: "GET", path: "/servers" });
    expect(res.isError).toBeUndefined();
    // The token is sent and a 503 on GET is retried.
    expect(calls).toEqual([
      { method: "GET", auth: "Bearer secret" },
      { method: "GET", auth: "Bearer secret" },
    ]);
    expect(tool.description).not.toMatch(/NOT applied/);
    expect(tool.description).toMatch(/token/);
    expect(tool.description).toMatch(/retr/i);
    expect(tool.description).toMatch(/pagination/i);
  });
});
