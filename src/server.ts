import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "pino";
import type { ToolRegistry } from "./tools/registry.js";

export function createMcpServer(
  registry: ToolRegistry,
  logger: Logger,
): Server {
  const server = new Server(
    { name: "the-real-hetzner-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: registry.getAll().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = registry.getByName(req.params.name);
    if (!tool) {
      throw new Error(`Unknown tool: ${req.params.name}`);
    }
    logger.debug({ tool: tool.name }, "tools/call");
    try {
      return await tool.handler(req.params.arguments ?? {});
    } catch (err) {
      logger.warn({ tool: tool.name, err }, "tool handler failed");
      return {
        content: [
          {
            type: "text",
            text: err instanceof Error ? err.message : String(err),
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}
