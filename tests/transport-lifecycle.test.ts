import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createMcpServer } from "../src/server.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { watchTransport } from "../src/transport-lifecycle.js";
import pino from "pino";

function setup() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const exit = vi.fn();
  const server = createMcpServer(new ToolRegistry(), logger as never);
  watchTransport(server, logger as never, exit);
  const transport = new StdioServerTransport(stdin, stdout);
  return { stdin, stdout, logger, exit, server, transport };
}

describe("stdio transport lifecycle", () => {
  it("logs and exits non-zero when the SDK closes the transport on an oversized line", async () => {
    const { stdin, logger, exit, server, transport } = setup();
    await server.connect(transport);
    // The SDK caps one unterminated stdio line at 10 MiB and closes the transport.
    stdin.write(Buffer.alloc(10 * 1024 * 1024 + 1, "a"));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: { name: expect.any(String), message: expect.any(String) } }),
      "mcp transport error",
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: { name: expect.any(String), message: expect.any(String) } }),
      "mcp transport closed after an error, exiting",
    );
  });

  it("logs a normal stdin close without forcing an exit", async () => {
    const { stdin, logger, exit, server, transport } = setup();
    await server.connect(transport);
    stdin.end();
    await vi.waitFor(() =>
      expect(logger.info).toHaveBeenCalledWith("mcp transport closed"),
    );
    expect(exit).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs a non-fatal message error and keeps serving", async () => {
    const { stdin, stdout, logger, exit, server, transport } = setup();
    await server.connect(transport);
    const out: string[] = [];
    stdout.on("data", (d) => out.push(String(d)));
    // Valid JSON but not a JSON-RPC message: reported via onerror, transport stays open.
    stdin.write('{"hello":"world"}\n');
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));
    stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      }) + "\n",
    );
    await vi.waitFor(() => expect(out.join("")).toContain('"protocolVersion":"2025-11-25"'));
    stdin.end();
    await vi.waitFor(() => expect(logger.info).toHaveBeenCalledWith("mcp transport closed"));
    expect(exit).not.toHaveBeenCalled();
  });

  it("keeps stderr small for one large invalid line (name and a short message, no stack)", async () => {
    const lines: string[] = [];
    const sink = new PassThrough();
    sink.on("data", (d) => lines.push(String(d)));
    const logger = pino({ level: "info" }, sink);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const server = createMcpServer(new ToolRegistry(), logger);
    watchTransport(server, logger, vi.fn());
    await server.connect(new StdioServerTransport(stdin, stdout));
    // About 1 MiB of valid JSON that is not a JSON-RPC message: the SDK reports
    // it through onerror with a validation message that quotes the input.
    const big = JSON.stringify({ jsonrpc: "2.0", junk: "a".repeat(1024 * 1024) });
    stdin.write(big + "\n");
    await vi.waitFor(() => expect(lines.join("")).toContain("mcp transport error"));
    const logged = lines.join("");
    expect(logged.length).toBeLessThan(2048);
    expect(logged).not.toContain("stack");
    const entry = JSON.parse(logged.split("\n").find((l) => l.includes("mcp transport error"))!);
    const message: string = entry.error.message;
    const cut = message.indexOf(" [truncated, ");
    expect(cut).toBe(300);
    expect(message).toMatch(/ \[truncated, \d+ more characters\]$/);
    stdin.end();
  });
});
