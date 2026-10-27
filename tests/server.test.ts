import { describe, it, expect, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createMcpServer } from "../src/server.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createLogger } from "../src/logger.js";
import type { ToolDef } from "../src/types.js";

const echoTool: ToolDef = {
  name: "hcloud_echo",
  description: "Returns its input as text.",
  inputSchema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  handler: async (input) => ({
    content: [{ type: "text", text: String(input.message) }],
  }),
};

describe("createMcpServer", () => {
  it("lists registered tools via tools/list", async () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);

    const server = createMcpServer(registry, createLogger("error"));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
    await client.connect(clientTransport);

    const result = await client.listTools();
    expect(result.tools.map((t) => t.name)).toEqual(["hcloud_echo"]);
    expect(result.tools[0]!.description).toBe("Returns its input as text.");

    await client.close();
    await server.close();
  });

  it("dispatches tools/call to the registered handler", async () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);

    const server = createMcpServer(registry, createLogger("error"));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "hcloud_echo",
      arguments: { message: "hi" },
    });
    expect(result.content).toEqual([{ type: "text", text: "hi" }]);

    await client.close();
    await server.close();
  });

  it("returns an error result for unknown tool", async () => {
    const server = createMcpServer(new ToolRegistry(), createLogger("error"));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
    await client.connect(clientTransport);

    await expect(
      client.callTool({ name: "nope", arguments: {} }),
    ).rejects.toThrow(/unknown tool|not found/i);

    await client.close();
    await server.close();
  });
});

describe("createMcpServer - inputSchema validation (issue #54, layer d)", () => {
  function guardedTool(handler: ReturnType<typeof vi.fn>): ToolDef {
    return {
      name: "hcloud_guarded",
      description: "Guarded tool.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "integer", minimum: 1 } },
        required: ["id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      handler: handler as unknown as ToolDef["handler"],
    };
  }

  async function call(tool: ToolDef, args: Record<string, unknown>) {
    const registry = new ToolRegistry();
    registry.register(tool);
    const server = createMcpServer(registry, createLogger("error"));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
    await client.connect(clientTransport);
    const res = await client.callTool({ name: tool.name, arguments: args });
    await client.close();
    await server.close();
    return {
      isError: res.isError as boolean | undefined,
      text: (res.content as Array<{ text: string }>)[0]!.text,
    };
  }

  it("rejects a path-injection payload without ever invoking the handler", async () => {
    const handler = vi.fn(async () => ({ content: [{ type: "text", text: "ran" }] }));
    const res = await call(guardedTool(handler), { id: "42/actions/reset_password#" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/^Invalid input for hcloud_guarded: /);
    expect(res.text).toMatch(/`id` must be integer/);
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects a missing required property", async () => {
    const handler = vi.fn(async () => ({ content: [{ type: "text", text: "ran" }] }));
    const res = await call(guardedTool(handler), {});
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/missing required property `id`/);
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects an unknown property when additionalProperties is false", async () => {
    const handler = vi.fn(async () => ({ content: [{ type: "text", text: "ran" }] }));
    const res = await call(guardedTool(handler), { id: 1, evil: "x" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/unknown property `evil`/);
    expect(handler).not.toHaveBeenCalled();
  });

  it("tolerates confirm:'YES' even when the schema does not declare it", async () => {
    const handler = vi.fn(async () => ({ content: [{ type: "text", text: "ran" }] }));
    const res = await call(guardedTool(handler), { id: 1, confirm: "YES" });
    expect(res.isError).toBeFalsy();
    expect(res.text).toBe("ran");
    expect(handler).toHaveBeenCalledWith({ id: 1, confirm: "YES" }, { signal: expect.any(AbortSignal) });
  });

  it("keeps the rejected argument value out of the log", async () => {
    // The caller gets its own value quoted back (it is their data); the log must
    // only ever see the shape, because request bodies carry private keys and
    // passwords and pino only redacts known token fields.
    const secret =
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDSUPERSECRET";
    const warn = vi.fn();
    const logger = { debug: vi.fn(), warn, info: vi.fn(), error: vi.fn() };
    const registry = new ToolRegistry();
    registry.register({
      name: "hcloud_needs_object",
      description: "Takes an object body.",
      inputSchema: {
        type: "object",
        properties: { body: { type: "object" } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      handler: async () => ({ content: [{ type: "text", text: "ran" }] }),
    });
    const server = createMcpServer(registry, logger as never);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
    await client.connect(clientTransport);
    const res = await client.callTool({
      name: "hcloud_needs_object",
      arguments: { body: secret },
    });
    await client.close();
    await server.close();

    // The caller sees the value...
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0]!.text).toContain("BEGIN PRIVATE KEY");
    // ...the log does not, in any of its fields.
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls[0]);
    expect(logged).not.toContain("PRIVATE KEY");
    expect(logged).not.toContain("SUPERSECRET");
    expect(logged).toContain("hcloud_needs_object");
    expect(logged).toContain(`string(${secret.length} chars)`);
  });

  it("passes valid arguments through unchanged", async () => {
    const handler = vi.fn(async (input: Record<string, unknown>) => ({
      content: [{ type: "text", text: `got ${input.id}` }],
    }));
    const res = await call(guardedTool(handler), { id: 42 });
    expect(res.isError).toBeFalsy();
    expect(res.text).toBe("got 42");
    expect(handler).toHaveBeenCalledWith({ id: 42 }, { signal: expect.any(AbortSignal) });
  });
});

describe("createMcpServer - protocol negotiation (SDK v2, server.connect)", () => {
  async function initialize(protocolVersion: string) {
    const server = createMcpServer(new ToolRegistry(), createLogger("error"));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const replies: Array<Record<string, unknown>> = [];
    clientTransport.onmessage = (msg) => {
      replies.push(msg as Record<string, unknown>);
    };
    await server.connect(serverTransport);
    await clientTransport.start();
    await clientTransport.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: "raw", version: "0" },
      },
    });
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    await server.close();
    return replies[0]!.result as { protocolVersion: string };
  }

  it.each(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"])(
    "answers initialize %s with the same revision",
    async (v) => {
      expect((await initialize(v)).protocolVersion).toBe(v);
    },
  );

  it("answers a 2026-07-28 initialize with 2025-11-25 (server.connect serves the 2025 era only)", async () => {
    expect((await initialize("2026-07-28")).protocolVersion).toBe("2025-11-25");
  });
});
