import type { Transport } from "@modelcontextprotocol/server";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import type { Logger } from "pino";
import { createMcpServer } from "./server.js";
import type { ToolRegistry } from "./tools/registry.js";
import { watchTransport } from "./transport-lifecycle.js";

export type ServeOptions = {
  maxOutputBytes?: number;
  /**
   * MCP_SERVE_MODERN_PROTOCOL. false (default): `server.connect`, which
   * negotiates the 2025-era revisions only, as before. true: `serveStdio`, which
   * also serves 2026-07-28 to a client that opens with `server/discover`; a
   * client that opens with `initialize` gets the same 2025-era session as before.
   */
  serveModernProtocol?: boolean;
  /** Defaults to stdio of this process; tests pass their own. */
  transport?: Transport;
  exit?: (code: number) => void;
};

export type ServeHandle = { close(): Promise<void> };

export async function serve(
  registry: ToolRegistry,
  logger: Logger,
  opts: ServeOptions = {},
): Promise<ServeHandle> {
  const transport = opts.transport ?? new StdioServerTransport();
  const make = () => {
    const server = createMcpServer(registry, logger, {
      ...(opts.maxOutputBytes !== undefined ? { maxOutputBytes: opts.maxOutputBytes } : {}),
    });
    watchTransport(server, logger, opts.exit);
    return server;
  };

  if (!opts.serveModernProtocol) {
    const server = make();
    await server.connect(transport);
    return { close: () => server.close() };
  }

  // One server instance per connection, created when the client's first
  // message picks the era. Transport errors reach that instance's onerror, so
  // watchTransport logs them and exits on a fatal close as in the default mode.
  // Errors before an instance exists (an unsupported revision, a malformed
  // envelope) are reported here.
  return serveStdio(() => make(), {
    transport,
    onerror: (err) => logger.warn({ error: { name: err.name, message: err.message.slice(0, 300) } }, "mcp stdio entry error"),
  });
}
