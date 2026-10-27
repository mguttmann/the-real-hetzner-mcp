# ADR 0001: MCP TypeScript SDK v2, runtime floor Node 22.12

- Status: accepted
- Date: 2026-10-27

## Context

Up to 0.2.0 the server depended on `@modelcontextprotocol/sdk` with the range
`^1.0.0` (lockfile 1.32.2). SDK v1 speaks protocol revisions up to 2025-11-25
and only receives fixes until about 2027-01-27. SDK v2
(`@modelcontextprotocol/server`, needs zod >= 4.2) is the maintained line and
can serve the 2026-07-28 revision as an opt-in.

The server uses only a small part of the SDK: the low-level `Server` with two
request handlers (`tools/list`, `tools/call`) that pass raw JSON schemas from
the registry through unchanged, and the stdio transport. The model for the
migration is mguttmann/action1-mcp v0.6.0 (its ADR 0001), which moved to
`@modelcontextprotocol/server` and first served only the 2025-era protocols
via `server.connect` behind a `tools/list` baseline test.

Consumers include MCP gateways that negotiate up to 2026-07-28 and
fingerprint every tool by name, description and input schema, so the
migration must not change what `tools/list` returns.

## Decision rule

Migrate to SDK v2 only if all of these hold, otherwise revert completely and
stay on `@modelcontextprotocol/sdk` `^1.32.2`:

1. The contract snapshot (`tests/snapshots/tools-contract.json`) stays
   byte-identical and the full test suite passes.
2. The `tools/list` result over stdio stays identical (no gateway
   fingerprint change).
3. The older protocol revisions keep negotiating as before.

## Result

All three hold, so the server moves to v2:

- `dependencies`: `@modelcontextprotocol/server` `^2.4.0` replaces
  `@modelcontextprotocol/sdk`. zod 4.6.7 comes in transitively.
  `@modelcontextprotocol/node` is not added: it only provides the HTTP
  transports, and this server is stdio only.
- `devDependencies`: `@modelcontextprotocol/client` `^2.4.0` for the tests
  that drive the server through `Client` and `InMemoryTransport`.
- Code: `Server` is imported from `@modelcontextprotocol/server`, the
  stdio transport from `@modelcontextprotocol/server/stdio`, and the handlers
  are registered by method name (`setRequestHandler("tools/list", ...)`)
  instead of v1 request schemas. The server still connects with
  `server.connect(new StdioServerTransport())`.

Evidence (2026-10-27):

- The raw `tools/list` JSON-RPC line written to stdout by the built server
  is byte-identical before and after the migration (201 tools), and so is
  the `initialize` answer.
- `initialize` with 2024-11-05, 2025-03-26, 2025-06-18 and 2025-11-25 is
  answered with the same revision; 2026-07-28 is answered with 2025-11-25,
  exactly as with SDK v1 (`tests/server.test.ts`).
- `tests/tools-contract.test.ts` passes unchanged.
- One wire difference: a `tools/call` request whose envelope is malformed
  (for example no `name`) now gets JSON-RPC error -32602 (invalid params)
  instead of -32603 (internal error). Well-formed calls, unknown tool names
  and input validation errors answer exactly as before.

## Serving 2026-07-28: opt-in

SDK v2 can serve the 2026-07-28 revision on stdio through
`serveStdio(factory, { legacy: "serve" })`, which picks the era from the
client's first message. It is not on by default. A client in auto mode
(such as the python `mcp` client) switches to the modern era as soon as the
server offers it, which changes the session handshake for every such client.

Since 2026-10-27 it is available behind `MCP_SERVE_MODERN_PROTOCOL` (default
`false`, `src/serve.ts`):

- `false`: `server.connect(new StdioServerTransport())` exactly as before.
- `true`: `serveStdio` with one `createMcpServer` instance per connection and
  `legacy: "serve"`. A client that opens with `initialize` gets the same
  2025-era session as with `false`; a client that opens with
  `server/discover` gets 2026-07-28. The tool list is the same in both eras.
  The transport lifecycle (log, exit 1 on a fatal close) is attached to that
  instance.

Evidence: `tests/serve-protocol.test.ts` drives both settings with the SDK
client (2025-era `initialize`, auto mode and a client pinned to 2026-07-28)
and checks the 10 MiB fatal close in the modern setting. Against the built
`dist/index.js` over stdio, the SDK client got 2025-11-25 with the switch off
(a pinned 2026-07-28 client is refused), and 2026-07-28 in auto and pinned
mode with the switch on, with an identical `tools/list` in every case.
Turning it on for a deployment needs a check with its client first.

## Runtime floor

`engines.node` is `>=22.12.0`. Node 20 is end of life since 2026-04-30, the
Node 24 is the active LTS line, and 22.12 is the oldest release the
current test toolchain supports (vitest 5: `^22.12.0 || ^24.0.0 || >=26.0.0`).
`@types/node` follows the oldest supported line (`^22`). TypeScript stays on
6.0 (`~6.0.3`); TypeScript 7 is a separate decision.
