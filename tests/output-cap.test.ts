import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { capToolResult, DEFAULT_MAX_OUTPUT_BYTES } from "../src/tools/output-cap.js";
import { createMcpServer } from "../src/server.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ToolDef, ToolResult } from "../src/types.js";

const wireBytes = (text: string) => Buffer.byteLength(JSON.stringify(text));
const text = (r: ToolResult) => (r.content[0] as { text: string }).text;

describe("capToolResult", () => {
  it("returns a result under the cap unchanged", () => {
    const r: ToolResult = { content: [{ type: "text", text: '{"servers": []}' }] };
    expect(capToolResult(r, 1000).result).toBe(r);
    expect(capToolResult(r, 1000).truncated).toBe(false);
  });

  it("cuts a long text to the cap and appends a clear marker", () => {
    const r: ToolResult = { content: [{ type: "text", text: "a".repeat(5000) }] };
    const out = capToolResult(r, 1000);
    expect(out.truncated).toBe(true);
    expect(wireBytes(text(out.result))).toBeLessThanOrEqual(1000);
    expect(text(out.result).startsWith("aaaa")).toBe(true);
    expect(text(out.result)).toMatch(/\[output truncated by MAX_OUTPUT_BYTES=1000: .* of 5002 bytes shown\]$/);
  });

  it("counts the JSON escaping that goes on the wire", () => {
    const r: ToolResult = { content: [{ type: "text", text: '"'.repeat(800) }] };
    const out = capToolResult(r, 1000);
    expect(out.truncated).toBe(true);
    expect(wireBytes(text(out.result))).toBeLessThanOrEqual(1000);
  });

  it("never splits a surrogate pair", () => {
    const r: ToolResult = { content: [{ type: "text", text: "\u{1F600}".repeat(1000) }] };
    const out = capToolResult(r, 1001);
    expect(text(out.result)).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("keeps isError", () => {
    const r: ToolResult = { content: [{ type: "text", text: "x".repeat(5000) }], isError: true };
    expect(capToolResult(r, 1000).result.isError).toBe(true);
  });
});

function bigTool(size: number): ToolDef {
  return {
    name: "hcloud_big",
    description: "big",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    handler: async () => ({ content: [{ type: "text", text: "a".repeat(size) }] }),
  };
}

describe("tool output cap in the server", () => {
  it("with the default cap, a 12 MiB result stays below the 10 MiB stdio line limit", async () => {
    const registry = new ToolRegistry();
    registry.register(bigTool(12 * 1024 * 1024));
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const server = createMcpServer(registry, logger as never);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    await server.connect(new StdioServerTransport(stdin, stdout));
    const chunks: Buffer[] = [];
    stdout.on("data", (d: Buffer) => chunks.push(d));
    const send = (m: unknown) => stdin.write(JSON.stringify(m) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "hcloud_big", arguments: {} } });
    await vi.waitFor(() => expect(Buffer.concat(chunks).toString()).toContain('"id":2'), { timeout: 10_000 });
    const lines = Buffer.concat(chunks).toString().split("\n").filter(Boolean);
    const line = lines.find((l) => l.includes('"id":2'))!;
    expect(Buffer.byteLength(line)).toBeLessThan(10 * 1024 * 1024);
    expect(line).toContain("output truncated by MAX_OUTPUT_BYTES");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "hcloud_big", max_output_bytes: DEFAULT_MAX_OUTPUT_BYTES }),
      "tool output truncated",
    );
    stdin.end();
    await server.close();
  });

  it("honours a lower configured cap", async () => {
    const registry = new ToolRegistry();
    registry.register(bigTool(5000));
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const server = createMcpServer(registry, logger as never, { maxOutputBytes: 1000 });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    await server.connect(new StdioServerTransport(stdin, stdout));
    const chunks: Buffer[] = [];
    stdout.on("data", (d: Buffer) => chunks.push(d));
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } } }) + "\n");
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "hcloud_big", arguments: {} } }) + "\n");
    await vi.waitFor(() => expect(Buffer.concat(chunks).toString()).toContain('"id":2'));
    const line = Buffer.concat(chunks).toString().split("\n").find((l) => l.includes('"id":2'))!;
    const result = JSON.parse(line).result;
    expect(wireBytes(result.content[0].text)).toBeLessThanOrEqual(1000);
    stdin.end();
    await server.close();
  });
});
