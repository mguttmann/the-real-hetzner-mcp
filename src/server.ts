import { Server, type Tool } from "@modelcontextprotocol/server";
import type { Logger } from "pino";
import type { ToolRegistry } from "./tools/registry.js";
import { validateToolInput } from "./tools/validate-input.js";
import { describeError } from "./tools/_error.js";
import { capToolResult, DEFAULT_MAX_OUTPUT_BYTES } from "./tools/output-cap.js";
import type { ToolResult } from "./types.js";
import { SERVER_VERSION } from "./version.js";

export function createMcpServer(
  registry: ToolRegistry,
  logger: Logger,
  opts: { maxOutputBytes?: number } = {},
): Server {
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const server = new Server(
    { name: "the-real-hetzner-mcp", version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler("tools/list", async () => ({
    tools: registry.getAll().map((t) => ({
      name: t.name,
      description: t.description,
      // Raw JSON schemas from the registry, passed through unchanged.
      inputSchema: t.inputSchema as Tool["inputSchema"],
      annotations: t.annotations,
    })),
  }));

  server.setRequestHandler("tools/call", async (req, ctx) => {
    const tool = registry.getByName(req.params.name);
    if (!tool) {
      throw new Error(`Unknown tool: ${req.params.name}`);
    }
    logger.debug({ tool: tool.name }, "tools/call");
    // The low-level SDK Server validates the request envelope only, never the
    // declared inputSchema - do it here, before any handler sees the arguments.
    const args = req.params.arguments ?? {};
    const errors = validateToolInput(tool.inputSchema, args);
    if (errors.length > 0) {
      // The caller gets its own value quoted back; the log gets the same messages
      // with types in place of values, because bodies may carry secrets and pino
      // only redacts known token fields.
      logger.warn(
        {
          tool: tool.name,
          errors: validateToolInput(tool.inputSchema, args, { redactValues: true }),
        },
        "invalid tool input",
      );
      return {
        content: [
          {
            type: "text",
            text: `Invalid input for ${tool.name}: ${errors.join(" ")}`,
          },
        ],
        isError: true,
      };
    }
    let result: ToolResult;
    try {
      result = await tool.handler(args, { signal: ctx.mcpReq.signal });
    } catch (err) {
      if (ctx.mcpReq.signal.aborted) {
        logger.info({ tool: tool.name }, "tool call cancelled");
      } else {
        logger.warn({ tool: tool.name, err }, "tool handler failed");
      }
      result = {
        content: [
          {
            type: "text",
            text: describeError(err),
          },
        ],
        isError: true,
      };
    }
    const capped = capToolResult(result, maxOutputBytes);
    if (capped.truncated) {
      logger.warn(
        { tool: tool.name, bytes: capped.totalBytes, max_output_bytes: maxOutputBytes },
        "tool output truncated",
      );
    }
    return capped.result;
  });

  return server;
}
