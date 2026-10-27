# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-10-27

Everything below is relative to 0.1.1.

### Security

- **Path injection in 0.1.x is fixed** (CWE-22, CWE-74; affected: 0.1.0 and 0.1.1). In 0.1.x
  some tools put caller-supplied path parameters into the request path without enough
  validation, so a caller granted one tool could make it reach a different Hetzner Cloud API
  endpoint, including endpoints whose response carries credentials. This was endpoint confusion
  inside the Hetzner Cloud API: the request host stayed pinned to the base URL and the token
  never went to a foreign host. See [SECURITY.md](SECURITY.md). The fix has these parts:
  - **Resource ids are validated.** `hcloud_server_backup`, `hcloud_server_power`,
    `hcloud_server_rescue`, `hcloud_server_snapshot`, `hcloud_server_change_type`,
    `hcloud_server_rebuild` and `hcloud_wait_action` cast their `id` argument to a number
    without checking it and interpolated it unencoded. `id` is now rejected unless it is a JSON
    integer >= 1, and no HTTP request is made for a rejected id. `hcloud_wait_action` matters
    on its own because it is read-only and therefore never covered by the
    `HETZNER_CONFIRM_WRITES` guard. `hcloud_get_server`, `hcloud_get_server_metrics` and
    `hcloud_apply_firewall_to_server` use the same `isResourceId` guard instead of a bare
    `typeof === "number"` check, so the wrappers do not depend on one validation layer.
  - **Path segments are percent-encoded at every interpolation site**
    (`encodeURIComponent`), as the generated tools already did. For a valid integer id this is
    a no-op, so request paths are unchanged.
  - **A string path parameter must name exactly one segment.** The parameters the API declares
    as strings (`id_or_name`, `rr_name`, used by the zone and RRSet tools) were only
    percent-encoded. That keeps a value inside one segment for the local URL parser, but the
    origin decodes encoded separators and resolves dot segments before routing. Such a value
    is now rejected before any request is built: empty, `.`, `..`, any `/` or `\`, and any
    percent-encoded separator or dot (`%2f`, `%5c`, `%2e`, case-insensitive). Legitimate zone
    names and record labels (IDN raw or punycode, trailing dot, `@`, `*`, `*.sub`, `_dmarc`)
    are encoded exactly as before.
  - **Tool arguments are validated against the declared `inputSchema`** before any handler
    runs. The low-level MCP SDK server validates only the shape of the `tools/call` request,
    so `inputSchema` was a declaration without runtime effect before.
  - **The HTTP client rejects any request path that URL normalisation would change**: `?`,
    `#`, `\`, characters outside RFC 3986 `pchar` (control characters are stripped by the URL
    parser and could otherwise form a dot segment), empty segments, and `.`/`..` segments in
    every spelling the parser recognises, the percent-encoded ones included. The assembled URL
    must keep the configured origin and its path must equal the base path plus the requested
    path exactly; an inexact match aborts the request.
  - **Redirects are never followed** (`redirect: "error"`). Before, a redirect from the API
    origin was followed with the `Authorization` header attached, which would also amplify a
    path confusion. The Hetzner Cloud API does not redirect on any legitimate call.
  - **Validation failures are logged without the offending value.** The caller still gets its
    own value quoted back, but the log line carries only the property name and the value's
    type, so a malformed `body` containing a private key, certificate or password is not
    written to stderr.
- **Dependencies refreshed.** The 0.1.x lockfiles resolve versions with published advisories,
  among them `@modelcontextprotocol/sdk` <= 1.31.0 and `zod` < 4.6.6 (GHSA-mrhx-c7xc-m3w5: a
  very large array in tool input could exhaust memory during schema validation). 0.2.0 replaces
  the SDK (see Changed) and ships a lockfile on which `npm audit` reports no advisory; CI fails
  on new high or critical advisories in runtime dependencies.

### Behaviour changes

- **Node.js 22.12 or newer is required.** `engines.node` is now `>=22.12.0` (was `>=20.0.0`).
  Node 20 is end of life since 2026-04-30. Installing on Node 20 prints an engine warning (or
  fails with `engine-strict`).
- **Resource ids must be JSON integers.** String-encoded numbers such as `"42"` are rejected
  instead of being passed through. This was already a violation of the published
  `{"type": "integer", "minimum": 1}` schema; MCP clients that build arguments from the
  advertised schema are unaffected. Path parameters that are declared as strings (`id_or_name`,
  `rr_name`, `rr_type`) remain strings.
- **Arguments are checked against the top level of each tool's `inputSchema`.** Violations
  return an `isError` result naming the offending property; the handler is not invoked and no
  request is sent. Request `body` contents are deliberately not validated: the Hetzner Cloud
  API remains the authority there and its `400` responses are surfaced as before.
- **Unknown top-level properties are rejected** for tools whose schema declares
  `additionalProperties: false`. The out-of-band keys `confirm`, `wait` and `auto_paginate` are
  always tolerated and dropped before the request is built, as they always were.
- **Array-valued query parameters are sent as repeated parameters** instead of one
  comma-joined value: `{"status": ["available", "creating"]}` now goes out as
  `?status=available&status=creating`, matching the "May be used multiple times" parameters of
  the Hetzner Cloud API. Before, the API saw the single value `available,creating`. A bare
  scalar for such a parameter (`{"sort": "name:asc"}`) stays accepted and produces the
  identical single parameter.
- **`hcloud_raw_request` no longer accepts a query string inside `path`.** Pass query
  parameters via the separate `query` field. Paths that URL normalisation would rewrite are
  rejected as well, and so is a percent-encoded separator or dot (`%2F`, `%5C`, `%2E` in any
  casing), which the origin decodes before routing; such a call returns `isError` and sends
  nothing. The tool otherwise remains the unrestricted escape hatch it was.
- **`hcloud_server_rescue` no longer drops a scalar `ssh_keys`.** The value goes into the
  request body, where a scalar used to be silently ignored: rescue mode came up without the
  requested key while the call reported success. A scalar is now normalised into a
  one-element array, and an element that is not a usable id is refused instead of dropped.
- **Array elements are checked against `items.enum` and `items.minimum`/`maximum`.** Before,
  only the element type was checked, so `{"status": ["done"]}` or `{"id": [0]}` on a list
  tool was sent to the API. Such a value, in the array or the bare scalar form, now returns
  `isError` naming the element and the allowed values or bound, and no request is sent. The messages count toward the
  same cap of 10 per property.
- **Per-element validation messages are capped** at the first 10 plus a count
  (`tests/validate-input.test.ts`). One message per bad array element amplified the caller's
  input into both the tool result and the stderr log.
- **Auto-paginated list tools report upstream errors as `isError`.** Before, a non-2xx page
  (401, 403, 404, 429 or 5xx after retries) was read as "no items": `hcloud_list_servers`,
  `hcloud_list_*_raw` and every generated list and per-resource action list returned an empty
  or partial list with `truncated: false`. Now the first failing page ends the call with
  `isError: true` and the same `HetznerApiError[<status> <code>]: <message>` text as the other
  tools. No partial list is returned.
- **A cancelled tool call stops.** When the client cancels a `tools/call`
  (`notifications/cancelled`), the request in flight to the Hetzner Cloud API is aborted and no
  further request is sent: no next page, no next poll, no retry. Before, the call ran on until
  its time budget ended, and a write tool could still poll or a list could still page after the
  caller had given up. A write the API already accepted is not undone. The cancellation is
  logged at info (`tool call cancelled`).
- **Tool results are capped at `MAX_OUTPUT_BYTES`.** A result text larger than
  `MAX_OUTPUT_BYTES` (new, optional, default 8 MiB, counted as sent, that is JSON-escaped) is
  cut and ends with `[output truncated by MAX_OUTPUT_BYTES=<n>: <shown> of <total> bytes shown]`;
  the cut is logged at warn (`tool output truncated`). Before, a very large result (for example
  a huge `user_data` or a long list) could produce one stdio line over the 10 MiB limit of the
  reader, which then dropped the connection. Results below the cap are unchanged. Values above
  8 MiB are lowered to 8 MiB.
- **Auto-paginated lists have a total time budget.** `PAGINATION_TIMEOUT_MS` (new, optional,
  default 45000) bounds one auto-paginated list (`hcloud_list_servers`, `hcloud_list_*_raw`
  and the per-resource action lists); each page request gets the remaining budget. When it
  ends after at least one page, the result carries the pages read so far with
  `truncated: true`, `pagination.next_page` and a new `note` field that names the budget. If
  not even the first page arrives, the call fails as before. Lists that finish inside the
  budget are unchanged (no `note`). Before, ten slow pages could run far past a 60 s caller
  timeout.
- **Action polling stops on an upstream error.** `hcloud_wait_action` used to keep polling on a
  non-2xx answer and report a synthetic `running` action with `polling_timed_out: true` after
  the timeout. It now returns `isError: true` with the Hetzner error at once.
- **A failed poll after a successful write keeps the write result.** For write tools with
  `wait: true` (generated action tools, `hcloud_create_server`, the server action wrappers), a
  network error, request timeout or HTTP error while polling no longer turns the call into
  `isError` and drops the write response (new resource id, one-time `root_password`). The
  write body comes back with `polling_timed_out: true` and a new `polling_error` string. The
  failure is logged on stderr at warn (`action polling failed after a successful write`) with
  the tool name, the action id and the error text, never the write body.
- **`ACTION_POLL_TIMEOUT_MS` is a wall-clock budget and defaults to 45000 (was 60000).** It
  now counts from the start of a `wait: true` call and includes the write request, every poll
  request and their retry delays; each poll request is cut to the remaining budget, and never
  gets more than `HTTP_TIMEOUT_MS`. Before, a
  60 s poll window plus request time exceeded a 60 s client call timeout (common in MCP clients
  and gateways), so long actions ended as a client timeout and the write response was lost. Long
  actions now return `polling_timed_out: true` earlier; use `hcloud_wait_action` to keep
  waiting. A `.env` that sets `ACTION_POLL_TIMEOUT_MS=60000` (as the old `.env.example` did)
  keeps the old window and should be lowered.
- **`hcloud_wait_action` clamps `timeout_ms` and `interval_ms`.** The schema is unchanged, but
  the handler now caps `timeout_ms` at `ACTION_POLL_TIMEOUT_MS` (default 45000): it can shorten
  the wait, not extend it past the caller's call timeout. `interval_ms` below 1000 is raised to
  1000 (or to `ACTION_POLL_INTERVAL_MS` if that is lower), so a caller cannot poll in a tight
  loop. Raise `ACTION_POLL_TIMEOUT_MS` to allow longer waits.
- **No single request gets more than `HTTP_TIMEOUT_MS`.** A caller that passes a longer budget
  (action polling with a large remaining budget) is cut at `HTTP_TIMEOUT_MS`, so one hanging
  poll request no longer holds the whole wait.
- **429 handling is capped.** The client no longer sleeps until `RateLimit-Reset` (the time the
  bucket is full again, up to an hour away). It waits for `Retry-After`, or 1 s, 2 s, 4 s when
  that header is missing or not a number of seconds. A wait longer than
  `HTTP_MAX_RETRY_DELAY_MS` (default 10000) is not taken: the 429 is returned at once as
  `HetznerApiError[429 ...]`.
- **`HTTP_TIMEOUT_MS` covers retries.** It is now the budget for one request including all
  attempts and retry delays, not the timeout of each attempt, so a retry that would overrun it
  is not started and the last response is returned.
- **`POST` is no longer resent on 5xx.** A create may already have been processed and billed
  when a 5xx comes back. Other methods keep the 5xx retry; 429 is still retried for every
  method, because a 429 request was refused.
- **A non-JSON error body is quoted, marked and capped.** When the API (or a proxy in front of
  it) answers an error with a body that is not JSON, the message used to be that body verbatim
  and uncapped. It is now `upstream text (non-JSON body): "<body>"`, with at most the first 4096
  characters and a `[truncated, N more characters]` note; the status and the code
  `upstream_error` are unchanged.
- **Network failures name their cause.** A failed connection used to reach the caller as a bare
  `fetch failed` (also in `polling_error`). The cause code or a short cause message is now added,
  for example `fetch failed (ECONNREFUSED)`, `fetch failed (ENOTFOUND)` or
  `fetch failed (bad port)`.
- **Thrown `HetznerApiError`s use the `HetznerApiError[...]` text.** The server's catch-all now
  formats them like `asToolError` instead of returning only the bare message.
- **A stdio transport failure is logged and exits with code 1.** The SDK closes the stdio
  transport when one inbound message line exceeds 10 MiB or stdout fails. Before, the process
  then ended with exit code 0 and nothing on stderr. Now the error is logged as JSON on stderr
  (`mcp transport error`, then `mcp transport closed after an error, exiting`) and the process
  exits with code 1. A normal close (stdin ended) is logged at info level and still exits 0.
  Transport errors are logged as `error: { name, message }` with the message cut at 300
  characters and no stack, so a large invalid input line is not repeated on stderr.
- **A malformed `tools/call` envelope gets JSON-RPC error -32602.** With MCP SDK v2 a
  `tools/call` request that fails the SDK's envelope check (for example without `name`) is
  answered with -32602 (invalid params) instead of -32603 (internal error). Well-formed calls,
  unknown tool names and input validation errors answer exactly as before.
- **`HETZNER_API_BASE` is checked at startup.** It must be an absolute `https` URL; plain `http`
  is accepted only for `localhost`, `127.0.0.1` and `::1` (tests, a local fake upstream). Any
  other value (an `http` URL on another host, another scheme, no scheme) stops the server with
  exit code 1 and `fatal: HETZNER_API_BASE must use https ...`. Before, any value was used and
  the token was sent wherever it pointed.
- **`.env` is read from the package directory, not the working directory.** The server loads
  the `.env` next to its `package.json`; a `.env` in the directory it is started from is
  ignored. Variables already in the environment still win, so `node --env-file=<file>
  dist/index.js` and an MCP client's `env` block work from any working directory as before. A
  setup that relied on a `.env` in the working directory must pass it with `--env-file` or set
  the variables in the client configuration.
- **`hcloud_raw_request` describes what it really does.** Its description said bearer auth and
  retries were not applied. The configured token is always sent and the client retries a 429,
  and a 5xx on methods other than `POST`, as for every other tool; pagination and action
  polling are not applied, and an HTTP error comes back as `{ status, body }`. Only the
  description changed (gateway fingerprint of `hcloud_raw_request`), not the behaviour.
- **`hcloud_server_rescue` offers only `linux64` as `type`.** `linux32` and `freebsd64` are no
  longer accepted by the Hetzner Cloud API (its spec lists only `linux64`); before, they went to
  the API and came back as an API error. Now such a value returns `isError` from the input check
  and no request is sent. The default (`linux64`), the required fields and the other properties
  are unchanged; the input schema, and so the gateway fingerprint, of `hcloud_server_rescue`
  changes.
- **`destructiveHint` is true for every write that is not purely additive.** MCP defines
  `destructiveHint: false` as "performs only additive updates", but only deletes and four server
  actions (`poweroff`, `reset`, `rebuild`, `request_console`) carried `true`. Every write tool
  that is not purely additive now annotates `destructiveHint: true`, among them every `hcloud_update_*`, every
  `*_change_protection_action`, `hcloud_server_disable_backup_action` (it deletes all backups),
  the rescue, assign/unassign, detach, remove and firewall actions, and the wrappers
  `hcloud_server_backup`, `hcloud_server_rescue` and `hcloud_apply_firewall_to_server`.
  `destructiveHint: false` stays only on creates (`hcloud_create_*`, `hcloud_post_zone_rrsets`),
  `hcloud_server_snapshot` and an explicit list of actions that only add an association or a
  copy or start a stopped server (`scripts/generate.ts`, pinned against the registry by
  `tests/destructive-hints.test.ts`). Only annotations change, which are not part of the gateway
  fingerprint; names, schemas and descriptions stay. The confirm guard and `HETZNER_READ_ONLY`
  cover exactly the same tools as before, because they already apply to every tool that is not
  read-only. A client that decides by `destructiveHint` (for example to ask before a call) now
  asks for these tools too.
- **No em or en dashes in tool text.** The confirm preview now starts with
  `PREVIEW: would execute <tool>` (was an em dash after `PREVIEW`), for the confirm guard and
  for `hcloud_raw_request`. The generator replaces em and en dashes from the Hetzner spec with
  `-` in summaries, descriptions and titles (enum values, patterns and examples are left as
  they are), which changes the descriptions of `hcloud_server_enable_rescue_action` and
  `hcloud_server_disable_rescue_action` (gateway fingerprint); their schemas stay.
  `tests/no-dashes.test.ts` checks `src`, `tests`, `scripts`, every tool and both previews.
- **The vendored Hetzner spec is refreshed (2026-10, OpenAPI 3.0.3 -> 3.1.2).** One tool is added
  and many existing tools change their input schema or description; no tool is removed, and no
  existing tool gains a top-level required parameter or changes a default. In detail:
  - **New tool `hcloud_get_network_members`** (read-only, `GET /networks/{id}/members`, filters
    `type`, `subnet`, `status`, `sort`, `page`, `per_page`). The tool count goes from 201 to 202.
  - **`page` and `per_page` are bounded** on the generated list tools that have them:
    `page` >= 1, `per_page` 1 to 50. Out-of-range values now return `isError` from the input
    check and send nothing; before, they went to the API.
  - **`hcloud_delete_load_balancer` waits for its action.** The API now returns an action for
    this delete, so the tool gets the optional `wait` (default `true`) like every other action
    tool and polls it within `ACTION_POLL_TIMEOUT_MS`; `wait: false` returns at once as before.
  - **`datacenter` is gone from the `body` of `hcloud_create_server` and
    `hcloud_create_primary_ip`.** Hetzner removed the field after 2026-10-01; use `location`.
    Bodies are not validated locally, so a call that still sends it reaches the API, which
    decides.
  - **`hcloud_create_primary_ip`**: `assignee_type` is no longer required in `body` and also
    accepts `unassigned`. **`hcloud_create_load_balancer`** gains the optional `body.public_net`,
    and the target objects of the load balancer tools gain `server.ip`.
  - **`dns_ptr` stays optional** in the `body` of `hcloud_server_change_dns_ptr_action`,
    `hcloud_floating_ip_change_dns_ptr_action`, `hcloud_primary_ip_change_dns_ptr_action` and
    `hcloud_load_balancer_change_dns_ptr_action`, although the new spec makes it required: the
    generator pins the old `required` list (`scripts/generate.ts`, `PINNED_BODY_REQUIRED`,
    `tests/spec-refresh-pins.test.ts`). The API rejects a call without it.
  - **Body schemas are stricter on paper**: `additionalProperties: false`, string lengths and
    integer bounds, and `type: [..., "null"]` instead of `nullable: true`. Bodies are still not
    validated locally, so this changes what clients see, not what the server sends.
  - **`hcloud_list_datacenters` and `hcloud_get_datacenter` stay registered.** Their
    descriptions now carry Hetzner's deprecation note (endpoint removed after 2026-10-01); the
    per-resource "get action" tools (`hcloud_get_<resource>_action`) already carry it. Use
    `hcloud_list_locations`, `hcloud_get_action` or `hcloud_wait_action` instead.
  - Descriptions also changed for `hcloud_create_load_balancer`, `hcloud_create_primary_ip`,
    `hcloud_create_server`, `hcloud_get_server_metrics_raw`, `hcloud_get_zone_rrsets` and
    `hcloud_load_balancer_add_target_action`. The per-tool list of changed hashes is the diff of
    `tests/snapshots/tools-contract.json` in this commit.
- **`serverInfo.version` reports the package version.** 0.1.1 still reported `0.1.0` in
  `initialize`; the version is now read from `package.json`.
- **The npm package ships only what runs.** Its files are `dist/`, `README.md`, `LICENSE`,
  `NOTICE` and `CHANGELOG.md` (`tests/package-files.test.ts`). `specs/cloud.spec.json`,
  `scripts/generate.ts`, `scripts/refresh-spec.ts`, `scripts/refresh-snapshot.ts` and
  `.env.example` are no longer in the package: nothing reads them at runtime, the scripts need
  development dependencies, and `refresh-snapshot.ts` imported files that were never shipped.
  They stay in the repository. With the npm package, set the variables in the MCP client's
  `env` block.
- **A version tag no longer creates a GitHub release on its own.** The release workflow creates it
  only when the repository variable `GH_RELEASE_ENABLED` is `true` (see "Added").

### Fixed

- **`hcloud_get_pricing` failed with its default arguments** ("pageItems is not iterable"),
  because `GET /pricing` was paginated although it returns an object. It now returns the
  pricing object. `auto_paginate` stays in its input schema, so the tool contract is unchanged.

### Added

- **`HETZNER_READ_ONLY` (optional, default `false`) and `HETZNER_DENY_TOOLS` (optional, default
  empty).** Operator switches enforced at call time. With `HETZNER_READ_ONLY=true` every tool
  that is not annotated read-only, and `hcloud_raw_request` with any method other than `GET`,
  returns `isError` (`... is not read-only and HETZNER_READ_ONLY=true; no request was sent.`).
  `HETZNER_DENY_TOOLS` is a comma-separated list of tool name globs (`*` and `?`, whole name,
  case-sensitive); a matching tool returns `isError` (`... is disabled by HETZNER_DENY_TOOLS;
  no request was sent.`), read-only tools included. Both are checked before the confirm guard,
  so a blocked tool shows no preview, and `confirm: "YES"` does not get past them. The tool list
  and every input schema stay the same, so gateway grants and fingerprints are unaffected. An
  unknown `HETZNER_READ_ONLY` value (anything but `true`, `1`, `yes`, `false`, `0`, `no` or
  empty) stops the server at startup, and so does a deny pattern that matches no tool
  (`HETZNER_DENY_TOOLS pattern "..." matches no tool`; patterns use the server's own `hcloud_*`
  names, not gateway-prefixed ones). `HETZNER_DENY_TOOLS` matches tool names only: deny
  `hcloud_raw_request` as well, otherwise every denied endpoint stays reachable through it. With
  both unset nothing changes.
- **`MCP_SERVE_MODERN_PROTOCOL` (optional, default `false`).** With `true` the server also
  serves the MCP 2026-07-28 revision over stdio to a client that opens with `server/discover`
  (SDK `serveStdio`), with the same tools. A client that opens with `initialize` gets the same
  2025-era session as before. With the default nothing changes: `server.connect` serves the
  2025-era revisions only. See `docs/adr/0001-mcp-sdk-v2.md`.
- **`MAX_OUTPUT_BYTES` (optional, default and ceiling 8388608).** Size cap of one tool result;
  see "Behaviour changes".
- **`PAGINATION_TIMEOUT_MS` (optional, default 45000).** Wall-clock budget of one
  auto-paginated list; see "Behaviour changes".
- **`HTTP_MAX_RETRY_DELAY_MS` (optional, default 10000).** Longest single retry delay of the
  HTTP client; see "Configuration" and "Timeouts and retries" in the README.
- **CI, release chain and security policy (repository only, nothing in the npm package
  changes).** `.github/workflows/ci.yml` runs on every branch push, pull requests and weekly:
  typecheck, build, tests and the offline stdio smoke (tool count and name hash of the gateway
  baseline) on the Node lines of its matrix plus a Node 22.12 floor job; `npm audit --omit=dev
  --audit-level=high` and `npm audit signatures`; the documented install from source
  (`npm ci --no-audit --no-fund && npm run build`) on Node 24 followed by the smoke; and a gitleaks scan of the full history (pinned version and checksum,
  `.gitleaks.toml` allowlists the example values of the vendored Hetzner spec). All actions
  are pinned by commit SHA and the workflows only get `contents: read` unless a job needs
  more. `.github/workflows/release.yml` runs on a `v*.*.*` tag: the tag must equal the
  `package.json` version and its commit must be on `main`; it then runs the CI workflow,
  packs the npm tarball, writes a CycloneDX SBOM and `SHA256SUMS`, and, only when the
  repository variable `GH_RELEASE_ENABLED` is `true`, attests build provenance and creates a
  GitHub release (an existing one is never overwritten); without it a tag builds and checks
  the assets but publishes nothing. npm publishing through trusted publishing (OIDC) with
  `--provenance` runs after the GitHub release and stays off until the repository variable
  `NPM_PUBLISH_ENABLED` is `true` as well. `package.json` `publishConfig` sets `provenance: true`, so
  a manual `npm publish` outside CI fails. `SECURITY.md` lists 0.2.x as supported, 0.1.x as
  unsupported and affected, the private reporting channel and a threat model of the current
  code.
- **Tool contract snapshot and stdio smoke test (development only).** The registry construction
  moved from `src/index.ts` into `src/build-registry.ts` without any change to the tools it
  builds (the full `tools/list` result is byte-identical to the previous build).
  `tests/tools-contract.test.ts` pins name, required fields, schema, description and
  annotations of every tool against `tests/snapshots/tools-contract.json`, and the tool count
  plus the sorted-name hash against the gateway baseline. `npm run smoke` runs `initialize`
  and `tools/list` over stdio against `dist/index.js`, offline.
- **MCP Registry listing and release metadata (repository only).** `server.json` describes the
  server for the official MCP Registry as `io.github.mguttmann/the-real-hetzner-mcp`, with the
  npm package as its only package; `package.json` carries the same name as `mcpName`. The new
  `mcp-registry` job of `release.yml` runs `.github/workflows/mcp-registry.yml` for stable tags
  after a successful npm publish: `mcp-publisher` pinned by version and SHA-256, GitHub OIDC
  login, a wait until npm serves the version with the right `mcpName`, and no publish when the
  registry already lists the version. It can also be started by hand for an existing tag.
  The release workflow now runs on `v*.*.*` tags only and publishes the tarball by a `./`
  path (`npm publish ./release/<file>.tgz`, npm would read `release/<file>.tgz` as a GitHub
  shorthand). No job that checks out code gets `id-token: write`.
  `tests/release-chain.test.ts` holds these rules, `server.json` against `package.json` and
  `src/config.ts`, and every CI job in the required checks of
  `docs/maintainers/repo-settings.md`, which lists the repository settings, the release
  variables, the npm trusted publisher, the MCP Registry and the Glama claim (`glama.json`).
- **NOTICE and spec provenance.** `NOTICE` states that the project is unofficial and not
  affiliated with Hetzner, that the vendored `specs/cloud.spec.json` is Hetzner's
  specification and not covered by the MIT License, and that the generated tool text derives
  from it. `specs/SOURCE.md` records its URL, fetch date and SHA-256 (`tests/notice.test.ts`).
  `package.json` gets an unofficial description, `author`, and `NOTICE` in `files`.
- **README:** an unofficial-project notice, a "Maintenance status" section, install paths for
  npm (with a range that refuses 0.1.x), npx, the MCP Registry and a pinned git commit, a
  configuration table matching `src/config.ts`, the protocol revisions served and the 10 MiB
  stdio message limit.

### Changed

- **MCP TypeScript SDK v2.** `@modelcontextprotocol/server` `^2.4.0` replaces
  `@modelcontextprotocol/sdk` `^1.0.0` (v1 speaks protocols up to 2025-11-25 and gets fixes only
  until about 2027-01-27). The server keeps the low-level `Server` with raw JSON schemas and
  `server.connect` over stdio, so it negotiates the same 2025-era revisions as before; the
  2026-07-28 revision is served only with `MCP_SERVE_MODERN_PROTOCOL=true` (see "Added"). The `tools/list` and `initialize` answers are
  byte-identical to the build before the migration. See `docs/adr/0001-mcp-sdk-v2.md`.
- **Dependencies.** Runtime: `pino` `^9` -> `^10.4.0`, `dotenv` `^16` -> `^18.0.9` (loaded
  with `config({ quiet: true })` from the package directory, see "Behaviour changes";
  `tests/dotenv-silent.test.ts` checks that it writes nothing to stdout, the MCP channel). Development: `@types/node` `^22.20.5`, `typescript`
  `~6.0.3`, `vitest` `^5.0.5`, `tsx` `^4.23.15`.
- **Server version comes from `package.json`.** `src/version.ts` reads the version from the
  package's own `package.json`; `tests/version.test.ts` holds both in step.
- **Development tooling (repository only).** `npm run typecheck` also checks `tests`, `scripts`
  and `vitest.config.ts` through `tsconfig.test.json`. The gateway baseline (tool count, names
  hash) lives in `tests/gateway-baseline.json`, read by the contract test and by the CI and
  release smoke (`npm run smoke -- --baseline <file>`). `package.json` `allowScripts` denies
  the esbuild and fsevents install scripts, which nothing needs, so npm 11 no longer warns on
  install. The release SBOM fix-up (npm names the root component after the checkout folder)
  moved to `scripts/sbom-root-name.mjs` and only rewrites a wrong name. `.github/dependabot.yml`
  adds weekly grouped updates for npm and GitHub Actions against `main`.
  `AGENTS.md` lists the commands and the tool contract rules.
- **Docs.** The setup no longer runs `refresh-spec` and `generate` (they change the tool
  surface), the write guard is described as covering every tool that is not read-only, Cloud
  DNS zones are listed as in scope, and tool counts in the docs point at the contract test
  instead of fixed numbers.

## [0.1.1] - 2026-06-14

### Added

- `SECURITY.md`, a CI workflow and a longer README (configuration reference, security section).

### Changed

- Lockfile refresh and `vitest` `^4.0.0` (development only). `initialize` still reported
  version `0.1.0`.

## [0.1.0] - 2026-05-26

### Added

- Initial public release: Hetzner Cloud MCP server (stdio) with one generated tool per Hetzner
  Cloud API operation plus hand-tuned wrappers, 429 backoff, automatic pagination, action
  polling, and the optional `HETZNER_CONFIRM_WRITES` write guard.

[0.2.0]: https://github.com/mguttmann/the-real-hetzner-mcp/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/mguttmann/the-real-hetzner-mcp/releases/tag/v0.1.1
[0.1.0]: https://www.npmjs.com/package/@mguttmann/hetzner-cloud-mcp/v/0.1.0
