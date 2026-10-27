# the-real-hetzner-mcp

An unofficial local [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server
(stdio) for the Hetzner Cloud API: every operation of the vendored Hetzner Cloud API
specification as a typed tool, read and write, plus hand-tuned wrappers for the common server
operations. npm package: `@mguttmann/hetzner-cloud-mcp`.

**Unofficial project.** This server is not affiliated with, endorsed by, sponsored by or
supported by Hetzner Online GmbH. "Hetzner" is a trademark of Hetzner Online GmbH. The vendored
API specification (`specs/cloud.spec.json`) is Hetzner's and is not covered by this project's
MIT License. See [`NOTICE`](NOTICE).

## Maintenance status

- Maintained on a best-effort basis by one maintainer
  ([@mguttmann](https://github.com/mguttmann)) in spare time. There is no support contract and
  no guaranteed response time.
- Security fixes take priority over features. Report vulnerabilities privately through GitHub
  private vulnerability reporting, never in a public issue; see [SECURITY.md](SECURITY.md).
- Only the latest minor release gets fixes ([SECURITY.md](SECURITY.md) lists the supported
  versions).
- Dependency updates come from Dependabot; CI fails when a runtime dependency has a known high
  or critical advisory.
- Releases are built and published by GitHub Actions from a tag on `main`, with a CycloneDX
  SBOM, `SHA256SUMS` and build provenance ([CHANGELOG.md](CHANGELOG.md) lists the changes).
- Issues and pull requests are welcome. Tool names, parameters and environment variables are
  kept stable between releases; see [AGENTS.md](AGENTS.md) for the contract rules.

## Features

- Full coverage of the Hetzner Cloud API via codegen from `specs/cloud.spec.json` (one generated tool per operation), plus hand-tuned wrappers for the common server operations. The exact tool list and count are pinned by `tests/tools-contract.test.ts` against `tests/snapshots/tools-contract.json`.
- `hcloud_raw_request` as a generic escape hatch for any endpoint.
- Capped 429 backoff, automatic pagination with a soft-cap, action polling with a wall-clock budget (see [Timeouts and retries](#timeouts-and-retries)).
- Optional write guard `HETZNER_CONFIRM_WRITES=true`: every tool that is not read-only returns a preview (tool name and input) unless the call carries `confirm: "YES"`.
- Optional operator switches `HETZNER_READ_ONLY=true` (only read-only tools and `GET` through `hcloud_raw_request` run) and `HETZNER_DENY_TOOLS` (tool name globs that always return an error). Both leave the tool list and the schemas unchanged.

## Out of Scope

**Not covered:** Hetzner Robot (the dedicated-server API), Hetzner DNS (the standalone DNS product, a separate API from Cloud DNS) and Hetzner Storage Boxes. They are not part of the Cloud API and the codegen has no spec for them.

**Covered:** Cloud DNS zones and RRSets (`/v1/zones`) are part of the Cloud API spec, so they are in scope through the generated tools.

## Installation

Requires Node.js 22.12 or newer (`engines` in `package.json`; the CI matrix in `.github/workflows/ci.yml` tests the floor and the current Node lines).

**Do not install 0.1.x.** npm versions below 0.2.0 (0.1.0 and 0.1.1) are affected by a path-injection vulnerability that is fixed in 0.2.0, see [SECURITY.md](SECURITY.md).

### From npm (0.2.0 or newer)

The package name is exactly `@mguttmann/hetzner-cloud-mcp`; packages with similar names are not from this project.

```bash
npm install -g "@mguttmann/hetzner-cloud-mcp@>=0.2.0"
```

The version range makes npm refuse the vulnerable 0.1.x versions. If npm reports that no matching version exists, 0.2.0 is not published yet: install from a pinned git commit instead. In your MCP client config the `command` is then just `hetzner-cloud-mcp` (no path needed).

### With npx (no global install)

```bash
npx -y "@mguttmann/hetzner-cloud-mcp@>=0.2.0"
```

MCP clients start it the same way, see [Variant C](#variant-c-with-npx). Keep the version range: without it npx would take whatever version npm serves as `latest`.

### From the MCP Registry

Once listed, the server is in the official MCP Registry as `io.github.mguttmann/the-real-hetzner-mcp`, with the npm package above as its package. Clients that install from the registry use the same npm package.

### From a pinned git commit

```bash
git clone https://github.com/mguttmann/the-real-hetzner-mcp.git
cd the-real-hetzner-mcp
git checkout <full commit sha>
npm ci
npm run build
```

Pin a full commit SHA, not a branch name: the commit of the `v0.2.0` tag (`git rev-list -n 1 v0.2.0`) or a later commit on `main`. `npm ci` installs exactly the committed lockfile.

## Setup

With the npm package, set the variables in the `env` block of your MCP client configuration (see [MCP Connector Setup](#mcp-connector-setup-claude-desktop--claude-code)); the package ships no `.env` file. In a git checkout:

```bash
cp .env.example .env
# Add HETZNER_API_TOKEN to .env (Read & Write token from the Hetzner Cloud Console)
```

`npm run refresh-spec` and `npm run generate` are not part of the setup: they change the tool surface (see [Spec Updates](#spec-updates)).

The server reads its configuration from the environment. At startup it also loads the `.env` file in the package directory (next to `package.json`, `dotenv`), never one from the current working directory; variables that are already set win. A deployment can pass the file explicitly instead, from any working directory: `node --env-file=/path/to/.env dist/index.js`.

Optional smoke test against the real API (four read-only calls):

```bash
npm run test:live
```

### Configuration

Only `HETZNER_API_TOKEN` is required. The defaults below are pinned by `tests/config.test.ts`. A numeric value that is not a positive number, and an unknown boolean or log level, falls back to the default. Exceptions that stop the server at startup instead: an invalid `HETZNER_API_BASE` and an unknown `HETZNER_READ_ONLY` value.

| Variable | Default | Meaning |
|---|---|---|
| `HETZNER_API_TOKEN` | (required) | Hetzner Cloud API token, sent as a bearer token on every request. The server can do exactly what this token allows. |
| `HETZNER_API_BASE` | `https://api.hetzner.cloud/v1` | API base URL. Must be `https`; plain `http` only for `localhost`, `127.0.0.1` or `::1`. Any other value stops the server at startup. Override only for tests or a local fake upstream. |
| `HETZNER_CONFIRM_WRITES` | `false` | `true`, `1` or `yes`: every tool that is not read-only returns a preview unless the call carries `confirm: "YES"`. |
| `HETZNER_READ_ONLY` | `false` | `true`, `1` or `yes`: every tool that is not annotated read-only, and `hcloud_raw_request` with a method other than `GET`, returns `isError` without sending a request. Checked before the confirm guard. Tool list and schemas are unchanged. Any value other than `true`, `1`, `yes`, `false`, `0`, `no` or empty stops the server at startup. |
| `HETZNER_DENY_TOOLS` | (empty) | Comma-separated tool name globs (`*` any characters, `?` one character, whole name, case-sensitive), for example `hcloud_delete_*,hcloud_raw_request`. A matching tool returns `isError` without sending a request, read-only tools included. Tool list and schemas are unchanged. Patterns use the server's own `hcloud_*` names, not a gateway-prefixed name; a pattern that matches no tool stops the server at startup. Denying a tool does not block its endpoint through `hcloud_raw_request`, so deny `hcloud_raw_request` as well, otherwise every denied endpoint stays reachable through it. |
| `LOG_LEVEL` | `warn` | `debug`, `info`, `warn` or `error`. Logs are JSON on stderr; stdout carries the MCP protocol. |
| `HTTP_TIMEOUT_MS` | `30000` | Wall-clock budget for one API request, all attempts and retry delays included. |
| `HTTP_MAX_RETRY_DELAY_MS` | `10000` | Longest single retry delay. A 429 whose `Retry-After` asks for more is returned at once as an error. |
| `ACTION_POLL_TIMEOUT_MS` | `45000` | Wall-clock budget of a `wait: true` call, measured from the start of the call (write request, poll requests and their retries included). Also the ceiling for the `timeout_ms` argument of `hcloud_wait_action`. |
| `ACTION_POLL_INTERVAL_MS` | `2000` | Pause between two polls. The `interval_ms` argument of `hcloud_wait_action` cannot go below 1000 or this value, whichever is lower. |
| `PAGINATION_MAX_ITEMS` | `500` | Soft cap on the items an auto-paginated list collects; a capped list reports `truncated: true`. |
| `PAGINATION_MAX_PAGES` | `10` | Soft cap on the pages an auto-paginated list requests. |
| `MAX_OUTPUT_BYTES` | `8388608` | Largest tool result text in bytes, counted as sent (JSON-escaped). A longer result is cut and ends with `[output truncated by MAX_OUTPUT_BYTES=...]`. Values above the default are lowered to it, so one result line stays below the 10 MiB stdio limit. |
| `PAGINATION_TIMEOUT_MS` | `45000` | Wall-clock budget of one auto-paginated list. When it ends, the pages read so far come back with `truncated: true` and a `note`. |
| `MCP_SERVE_MODERN_PROTOCOL` | `false` | `true`, `1` or `yes`: also serve the MCP 2026-07-28 revision over stdio (see [MCP protocol](#mcp-protocol)). A client that opens with `initialize` gets the same 2025-era session as with `false`. |

Development only: `RUN_LIVE_TESTS=1` enables `tests/live-smoke.test.ts` (set by `npm run test:live`), and `HETZNER_LIVE_SMOKE_ANCHORS` optionally names servers that test expects to find.

### Timeouts and retries

Retries: a 429 is retried after `Retry-After`, or after a short backoff when the header is
missing (Hetzner refills one request per second; `RateLimit-Reset` is the time the bucket is
full again and is not used as a delay). A 5xx is retried with backoff, except for `POST`, which
may already have been processed. With the defaults one tool call answers within about
`max(HTTP_TIMEOUT_MS, ACTION_POLL_TIMEOUT_MS)` (`tests/call-budget.test.ts` measures this), so it
stays below a 60 s client call timeout, common in MCP clients and gateways. Keep that relation if you
raise the values. Auto-paginated lists run one request per page within
`PAGINATION_TIMEOUT_MS`; when that budget ends, the pages read so far come back with
`truncated: true` and a `note`, never as a list that looks complete.

When polling fails or the budget runs out after a successful write, the tool returns the write
response (for example the new resource id and a one-time `root_password`) with
`polling_timed_out: true`, plus `polling_error` if polling failed.

## MCP protocol

The server speaks MCP over stdio only and opens no network port.

- **Protocol revisions:** a client that asks for `2024-11-05`, `2025-03-26`, `2025-06-18` or
  `2025-11-25` gets that revision back; a client that asks for a newer one (for example
  `2026-07-28`) in `initialize` gets `2025-11-25` (`tests/server.test.ts`).
- **2026-07-28 is opt-in:** with `MCP_SERVE_MODERN_PROTOCOL=true` the server also answers a
  client that opens with `server/discover` and serves it the 2026-07-28 revision, with the same
  tools. A client that opens with `initialize` still gets the 2025-era session above
  (`tests/serve-protocol.test.ts`). The default is `false`: a client in auto mode (such as the
  python `mcp` client) would switch to the new revision as soon as it is offered, so turn it on
  only after checking the client. See `docs/adr/0001-mcp-sdk-v2.md`.
- **Message size limit:** one inbound JSON-RPC message (one stdin line) may be at most 10 MiB,
  the MCP SDK's stdio limit (`tests/transport-lifecycle.test.ts`). A longer line closes the
  transport: the server logs `mcp transport error` on stderr and exits with code 1. Keep large
  arguments (for example `user_data`) well below that size. Outbound, a tool result is cut at
  `MAX_OUTPUT_BYTES` (at most 8 MiB, `tests/output-cap.test.ts`) and then ends with an
  `[output truncated by MAX_OUTPUT_BYTES=...]` marker.

## MCP Connector Setup (Claude Desktop / Claude Code)

Append to your client's MCP config (`~/Library/Application Support/Claude/claude_desktop_config.json` for Claude Desktop, or the equivalent in Claude Code).

### Variant A: installed via npm

```json
{
  "mcpServers": {
    "hetzner-cloud": {
      "command": "hetzner-cloud-mcp",
      "env": {
        "HETZNER_API_TOKEN": "...",
        "HETZNER_CONFIRM_WRITES": "false",
        "LOG_LEVEL": "warn"
      }
    }
  }
}
```

### Variant B: from a git checkout

```json
{
  "mcpServers": {
    "hetzner-cloud": {
      "command": "node",
      "args": ["/absolute/path/to/the-real-hetzner-mcp/dist/index.js"],
      "env": {
        "HETZNER_API_TOKEN": "...",
        "HETZNER_CONFIRM_WRITES": "false",
        "LOG_LEVEL": "warn"
      }
    }
  }
}
```

### Variant C: with npx

```json
{
  "mcpServers": {
    "hetzner-cloud": {
      "command": "npx",
      "args": ["-y", "@mguttmann/hetzner-cloud-mcp@>=0.2.0"],
      "env": {
        "HETZNER_API_TOKEN": "...",
        "HETZNER_CONFIRM_WRITES": "false",
        "LOG_LEVEL": "warn"
      }
    }
  }
}
```

Restart the client to pick up the change. `tools/list` should expose the tools pinned in `tests/snapshots/tools-contract.json`, all named `hcloud_*`.

## Tools: overview

### Hand-tuned Wrappers

| Tool                              | What it does                                                                  |
|-----------------------------------|-------------------------------------------------------------------------------|
| `hcloud_list_servers`             | Server list with `name_contains` filter and default sort by `name`.           |
| `hcloud_get_server`               | Fetch a server by `id` OR `name`.                                             |
| `hcloud_server_power`             | poweron / poweroff / reboot / shutdown / reset in a single tool.              |
| `hcloud_server_rebuild`           | Rebuild a server, `image_id` OR `image_name`.                                 |
| `hcloud_server_snapshot`          | `create_image` with default `type=snapshot`.                                  |
| `hcloud_server_backup`            | Toggle automatic backups.                                                     |
| `hcloud_server_rescue`            | Toggle rescue mode, default `type=linux64`.                                   |
| `hcloud_server_change_type`       | Change server type, default `upgrade_disk=false`.                             |
| `hcloud_get_server_metrics`       | Server metrics, `id` OR `name`, default time window "last hour".              |
| `hcloud_apply_firewall_to_server` | Apply a firewall to a server, by-id OR by-name.                               |
| `hcloud_raw_request`              | Arbitrary request against the API. Query parameters go in `query`; a `path` that URL normalisation would alter, or that contains `%2F`, `%5C` or `%2E`, is rejected. |
| `hcloud_wait_action`              | Poll an action until success/error or timeout.                                |

### Generated Tools

One tool per OpenAPI operation, naming scheme `hcloud_<verb>_<resource>` or `hcloud_<resource>_<action>_action`. On name collision with a wrapper the generated tool gets the suffix `_raw` (`hcloud_list_servers_raw`, `hcloud_get_server_raw`, `hcloud_get_server_metrics_raw`).

Run `tools/list` in the Inspector to see the full list.

## Input Validation

Arguments are checked against the tool's declared `inputSchema` before the
handler runs. The low-level MCP SDK server validates only the shape of the
`tools/call` request, so this check is what makes the advertised schema binding.
A violation returns an `isError` result naming the offending property; the
handler is not invoked and no request reaches the Hetzner API.

What is enforced:

- **Resource ids must be JSON integers >= 1.** String-encoded numbers such as
  `"42"` are rejected rather than coerced. Path parameters that the API declares
  as strings (`id_or_name`, `rr_name`, `rr_type`) stay strings, but a string
  used in the path has to name a single segment, see below.
- **Top-level types, `enum`, `minimum`/`maximum`, `minLength`/`maxLength` and
  flat array elements** (element type, `items.enum`, `items.minimum`/`maximum`),
  plus `required`. For a parameter declared as an array of scalars a bare scalar
  is also accepted and checked against the element schema: for a repeatable *query* parameter such as `sort` or `status` it
  serialises to exactly the same single parameter, so rejecting it would break a
  call that has always worked. The one array-typed parameter that goes into a
  request *body*, `hcloud_server_rescue.ssh_keys`, normalises the scalar into a
  one-element array, so the value a caller sends is always used or refused, never
  silently dropped. Per-element messages for a bad array are capped at the first
  10 plus a count (`tests/validate-input.test.ts`), so a large input cannot be
  amplified into the result or the log.
- **Unknown top-level properties**, for the tools whose schema declares
  `additionalProperties: false` (all wrappers and all generated tools). The
  out-of-band keys `confirm`, `wait` and `auto_paginate` are always tolerated,
  so sending `confirm` while `HETZNER_CONFIRM_WRITES` is disabled, or `wait` /
  `auto_paginate` to a tool that does not declare them, is not an error; those
  keys are dropped before the request is built.
- **A path parameter must name exactly one path segment.** For the parameters
  the API declares as strings (`id_or_name`, `rr_name`) the value is rejected if
  it is empty, is `.` or `..`, contains `/` or `\`, or contains a
  percent-encoded separator or dot (`%2f`, `%5c`, `%2e` in any casing). Reason:
  percent-encoding keeps such a value inside one segment only as far as the
  local URL parser is concerned. The actor that resolves the path is the
  *origin*, which decodes encoded separators and resolves dot segments before
  routing, so without this check a crafted value could address a different
  resource than the tool's own. Legitimate values are untouched: IDN zone names
  (raw or punycode), a trailing dot, `@`, `*`, `*.sub`, `_dmarc` and the like all
  pass and are percent-encoded as before.
- **Path segments are percent-encoded** at every interpolation site, and the
  HTTP client refuses any path that URL normalisation would change. Rejected:
  `?` and `#` (which truncate the path into query/fragment), `\` (a path
  separator to the URL parser), characters outside RFC 3986 `pchar` such as
  control characters (which the parser strips, so they could otherwise form a
  dot segment), empty segments, and `.`/`..` segments in every spelling,
  including the percent-encoded ones. The assembled URL is then compared against
  the intended target: its origin must be the configured one and its path must
  equal the base path plus the requested path *exactly*, so any remaining
  normalisation aborts the request instead of redirecting it. This client-side
  check only sees what the local URL parser would rewrite, so it is the last
  line of defence, not the whole guarantee: the per-parameter rule above is
  what covers what the *origin* would rewrite.
- **Rejected input produces no HTTP request at all**, not a sanitised one.

What is deliberately *not* enforced: the contents of a request `body`. Those
trees are the Hetzner Cloud API's own contract: it validates them and its `400`
responses are surfaced to the caller unchanged. `format`, `pattern` and
`nullable` are not evaluated either.

Validation failures are logged with the offending property name and the *type*
of the offending value; the value itself is only quoted back to the caller, so a
malformed `body` carrying a private key or password does not end up in the log.

Note on `hcloud_raw_request`: it remains a deliberate escape hatch that accepts
any path by design, so it is not constrained to a resource whitelist. It is
pinned to the configured API base URL (origin and path prefix), but a caller
granted this tool can reach any endpoint of the Hetzner Cloud API. Like every
other tool it rejects a percent-encoded separator or dot (`%2F`, `%5C`, `%2E` in
any casing) in its `path`, because the origin, not the local URL parser, decides
what an encoded separator means. Grant `hcloud_raw_request` accordingly.

## Spec Updates

When Hetzner updates the OpenAPI:

```bash
npm run refresh-spec       # re-downloads specs/cloud.spec.json
# update the fetch date and the SHA-256 in specs/SOURCE.md
npm run generate           # rebuilds src/tools/generated/operations.ts
npm test                   # codegen and contract snapshots show the diff
npm run refresh-snapshot   # rewrite the snapshots deliberately (after review)
git add specs/cloud.spec.json specs/SOURCE.md src/tools/generated/operations.ts tests/snapshots/tool-registry.json tests/snapshots/tools-contract.json
git commit -m "chore(spec): refresh from Hetzner"
```

A refresh changes tool input schemas and can add tools, which MCP clients and gateways see as
a contract change. List it under "Behaviour changes" in `CHANGELOG.md`. If the new spec makes a
`body` field of an existing tool required, keep the old list in `PINNED_BODY_REQUIRED` in
`scripts/generate.ts`, so the tool contract does not tighten; the API still rejects a call that
lacks the field. A new tool changes the tool count and name hash of the gateway baseline,
which live in one file, `tests/gateway-baseline.json`, read by `tests/tools-contract.test.ts`
and by the CI and release smoke.

## Development

### Tool contract snapshot

`tests/tools-contract.test.ts` builds the registry exactly as the stdio server does
(`src/build-registry.ts`) and compares every tool against `tests/snapshots/tools-contract.json`:
name, `inputSchema.required`, a sha256 of the canonical (key-sorted) JSON of `inputSchema`
(with and without `HETZNER_CONFIRM_WRITES=true`), a sha256 of the description, and the
annotations. It also pins the tool count and the sha256 of the sorted tool names to the
gateway baseline; those two values live in `tests/gateway-baseline.json` and are not rewritten by
any script.

`npm run refresh-snapshot` regenerates both `tests/snapshots/tool-registry.json` and
`tests/snapshots/tools-contract.json`. Run it only for a deliberate contract change and review
the diff: a changed `required`, schema or description hash changes what MCP clients see.

### Stdio smoke test

`npm run smoke` spawns `dist/index.js` (run `npm run build` first), sends `initialize`,
`notifications/initialized` and `tools/list` over stdio, and prints the negotiated protocol
version, `serverInfo`, the tool count and the sha256 of the sorted tool names as JSON. It needs
no network:

```bash
HETZNER_API_TOKEN=dummy HETZNER_API_BASE=http://127.0.0.1:1 npm run smoke -- \
  --min-tools <n> --expect-names-sha256 <sha256>
# or with an env file, passed to node as --env-file:
npm run smoke -- --env-file ./smoke.env
```

Options: `--protocol-version <v>`, `--min-tools <n>`, `--expect-names-sha256 <hex>`,
`--baseline <file>` (sets both from a JSON file with `toolCount` and `namesSha256`),
`--server <path>` (default `dist/index.js`) and `--timeout-ms <ms>`; the defaults are at the top
of `scripts/smoke-stdio.mjs`. Exit code 0 means all checks passed, 1 a check failed, 2 the
server did not start or answer. CI runs it with `--baseline tests/gateway-baseline.json`, the file
`tests/tools-contract.test.ts` also reads.

## Manual Verification Recipe

Run before declaring a release ready:

1. `npm run inspector` opens the MCP Inspector with this server.
2. `tools/list`: verify the count equals `toolCount` in `tests/snapshots/tools-contract.json` and that every wrapper in the table above appears.
3. `hcloud_list_servers` (no args): verify against at least one known server in your account.
4. `hcloud_get_server` with `name: "<one of your server names>"`: should return id, type, ip.
5. `hcloud_create_ssh_key` with `{ name: "mcp-smoke", public_key: "<your test key>" }`: note the returned id.
6. `hcloud_delete_ssh_key` with that id: confirm clean removal.

Do **not** run power/rebuild/snapshot operations against production servers as part of a smoke test.

## Security

See [SECURITY.md](SECURITY.md) for supported versions, how to report a vulnerability privately
and the threat model (token authority, the confirm guard, grants by tool name).

## License

MIT, see [LICENSE](./LICENSE), except the vendored Hetzner Cloud API specification
(`specs/cloud.spec.json`), which is Hetzner's; see [NOTICE](NOTICE) and
[specs/SOURCE.md](specs/SOURCE.md).
