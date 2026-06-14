import { describe, it, expect } from "vitest";
import {
  InMemoryTransport,
} from "@modelcontextprotocol/sdk/inMemory.js";
import {
  Client,
} from "@modelcontextprotocol/sdk/client/index.js";
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
