import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { serve } from "../src/serve.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createLogger } from "../src/logger.js";
import type { ToolDef } from "../src/types.js";

// B-023: MCP_SERVE_MODERN_PROTOCOL=true serves the 2026-07-28 revision over
// stdio next to the 2025-era revisions; the default keeps server.connect.

const echoTool: ToolDef = {
  name: "hcloud_echo",
  description: "Returns its input as text.",
  inputSchema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  handler: async (input) => ({ content: [{ type: "text", text: String(input.message) }] }),
};

function registry(): ToolRegistry {
  const r = new ToolRegistry();
  r.register(echoTool);
  return r;
}

async function connect(
  modern: boolean,
  versionNegotiation?: { mode: "auto" } | { mode: { pin: string } },
) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = await serve(registry(), createLogger("error"), {
    serveModernProtocol: modern,
    transport: serverTransport,
    exit: vi.fn(),
  });
  const client = new Client(
    { name: "test", version: "0" },
    { capabilities: {}, ...(versionNegotiation ? { versionNegotiation } : {}) },
  );
  await client.connect(clientTransport);
  return { client, handle };
}

async function initialize(modern: boolean, protocolVersion: string) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = await serve(registry(), createLogger("error"), {
    serveModernProtocol: modern,
    transport: serverTransport,
    exit: vi.fn(),
  });
  const replies: Array<Record<string, unknown>> = [];
  clientTransport.onmessage = (msg) => {
    replies.push(msg as Record<string, unknown>);
  };
  await clientTransport.start();
  await clientTransport.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion, capabilities: {}, clientInfo: { name: "raw", version: "0" } },
  });
  await vi.waitFor(() => expect(replies).toHaveLength(1));
  await handle.close();
  return replies[0]!.result as { protocolVersion: string };
}

describe("serve: MCP_SERVE_MODERN_PROTOCOL=false (default)", () => {
  it.each(["2025-06-18", "2025-11-25"])("answers initialize %s with the same revision", async (v) => {
    expect((await initialize(false, v)).protocolVersion).toBe(v);
  });

  it("answers a 2026-07-28 initialize with 2025-11-25", async () => {
    expect((await initialize(false, "2026-07-28")).protocolVersion).toBe("2025-11-25");
  });

  it("a client in auto mode falls back to the 2025 era and still lists and calls tools", async () => {
    const { client, handle } = await connect(false, { mode: "auto" });
    expect(client.getProtocolEra()).toBe("legacy");
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["hcloud_echo"]);
    await client.close();
    await handle.close();
  });

  it("a client pinned to 2026-07-28 cannot connect", async () => {
    await expect(connect(false, { mode: { pin: "2026-07-28" } })).rejects.toThrow();
  });
});

describe("serve: MCP_SERVE_MODERN_PROTOCOL=true", () => {
  it.each(["2025-06-18", "2025-11-25"])(
    "still answers a 2025-era initialize %s with the same revision",
    async (v) => {
      expect((await initialize(true, v)).protocolVersion).toBe(v);
    },
  );

  it("a client pinned to 2026-07-28 connects, lists the same tools and calls one", async () => {
    const { client, handle } = await connect(true, { mode: { pin: "2026-07-28" } });
    expect(client.getProtocolEra()).toBe("modern");
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))).toEqual([
      { name: echoTool.name, description: echoTool.description, inputSchema: echoTool.inputSchema },
    ]);
    const res = await client.callTool({ name: "hcloud_echo", arguments: { message: "hi" } });
    expect((res.content as Array<{ text: string }>)[0]!.text).toBe("hi");
    await client.close();
    await handle.close();
  });

  it("a client in auto mode negotiates the modern era", async () => {
    const { client, handle } = await connect(true, { mode: "auto" });
    expect(client.getProtocolEra()).toBe("modern");
    await client.close();
    await handle.close();
  });

  it("logs and exits non-zero when one stdio line exceeds the 10 MiB limit", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const exit = vi.fn();
    await serve(registry(), logger as never, {
      serveModernProtocol: true,
      transport: new StdioServerTransport(stdin, stdout),
      exit,
    });
    // Open the connection first, so an instance is pinned.
    stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      }) + "\n",
    );
    await new Promise((r) => setTimeout(r, 20));
    stdin.write(Buffer.alloc(10 * 1024 * 1024 + 1, "a"));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: { name: expect.any(String), message: expect.any(String) } }),
      "mcp transport closed after an error, exiting",
    );
  });
});
