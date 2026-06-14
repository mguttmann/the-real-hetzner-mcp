# @mguttmann/hetzner-cloud-mcp

> Local MCP server (stdio) that exposes the **entire Hetzner Cloud API as 201 typed tools — read and write** to Claude Desktop and Claude Code.

[![npm version](https://img.shields.io/npm/v/@mguttmann/hetzner-cloud-mcp.svg)](https://www.npmjs.com/package/@mguttmann/hetzner-cloud-mcp)
[![CI](https://github.com/mguttmann/the-real-hetzner-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/mguttmann/the-real-hetzner-mcp/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/node/v/@mguttmann/hetzner-cloud-mcp.svg)](./package.json)

A Model Context Protocol (MCP) server for Hetzner Cloud that turns Claude Desktop and Claude Code into a natural-language control plane for your infrastructure. Written in TypeScript, transported over stdio, and built around OpenAPI codegen so it tracks the upstream API as it evolves. Every Hetzner Cloud resource — servers, volumes, networks, load balancers, firewalls, SSH keys, images, certificates, zones — is reachable as a typed MCP tool. No shell, no `curl`, no clicking through the web console: just ask.

---

## Table of contents

- [Why this exists](#why-this-exists)
- [How it works](#how-it-works)
- [Installation](#installation)
- [Setup](#setup)
- [MCP connector setup (Claude Desktop / Claude Code)](#mcp-connector-setup-claude-desktop--claude-code)
- [Usage examples](#usage-examples)
- [Safety — the write-guard](#safety--the-write-guard)
- [Configuration reference](#configuration-reference)
- [Tools — overview](#tools--overview)
- [Spec updates](#spec-updates)
- [Manual verification recipe](#manual-verification-recipe)
- [Limitations / out of scope](#limitations--out-of-scope)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

---

## Why this exists

Managing Hetzner Cloud today means clicking through the web console, scripting against the REST API with `curl` and a Bearer token, or driving the official `hcloud` CLI. None of those compose well with how you actually think about your infra ("reboot `web-01`", "snapshot the database server before the upgrade"). This MCP server closes the gap by exposing every Hetzner Cloud operation as a tool Claude can call directly — a conversation in Claude Desktop or Claude Code becomes the interface to your cloud account.

What makes this different from a thin wrapper around a handful of endpoints is **full API coverage via codegen**. The official Hetzner Cloud OpenAPI spec is the source of truth: `scripts/generate.ts` walks `specs/cloud.spec.json` and emits one MCP tool per operation — 189 today. When Hetzner ships a new endpoint, a single `npm run refresh-spec && npm run generate` brings it in.

On top sits a thin layer of 12 hand-tuned wrappers for the operations a human actually wants in natural language. "Reboot server `web-01`" should be one tool call, not "look up server by name, POST the reboot action, poll the action until success". The wrappers handle that. For the long tail, `hcloud_raw_request` is a deliberate escape hatch.

Trust posture is conservative. The server runs locally over stdio — no third-party service in the request path. Destructive operations can be gated behind a write-guard (`HETZNER_CONFIRM_WRITES=true`) that returns a preview instead of executing, requiring `confirm: "YES"` in the args. Read operations always bypass it. Turn it on for production tokens, off for a sandbox. This is for anyone running Hetzner Cloud who already lives in Claude Desktop or Claude Code and would rather talk to their infra than click at it.

---

## How it works

Two tool tiers stacked over a shared infrastructure layer.

**Codegen-from-OpenAPI.** The spec lives in `specs/cloud.spec.json`, fetched fresh by `npm run refresh-spec`. `scripts/generate.ts` walks every operation and emits `src/tools/generated/operations.ts` — one MCP tool per operation, 189 in total. When Hetzner adds a new endpoint, one re-run picks it up; there is no hand-maintained list of endpoints to drift.

**Hand-tuned wrappers.** Under `src/tools/wrappers/` are 10 ergonomic wrappers for the operations a human actually wants in natural language. They accept friendly inputs (servers by `id` OR `name`, default metric window "last hour", `type=snapshot` filled in for `hcloud_server_snapshot`), call the underlying generated operation, and integrate action polling so one conversational turn returns a completed action. On name collision the generated tool gets a `_raw` suffix — `hcloud_list_servers` is the wrapper, `hcloud_list_servers_raw` the unfiltered generated tool.

**Raw escape hatch.** `hcloud_raw_request` reaches any endpoint via `method`, `path`, optional `body` — including endpoints the spec might miss. It still goes through auth, retry, and write-guard plumbing.

**Action polling.** Hetzner writes return an `action` object you poll until success or error. `hcloud_wait_action` does that — default 60 s timeout, 2 s interval, tunable via env. The wrappers integrate it automatically.

**Shared infrastructure.** Auth header injection (Bearer token from `HETZNER_API_TOKEN`), HTTP timeouts (default 30 s), 429 backoff with retry, automatic pagination with a soft-cap (default 500 items / 10 pages), action polling, the optional confirm-guard, and consistent error mapping into MCP tool errors.

Request flow:

```
Claude Desktop / Claude Code (MCP client)
        |  stdio (JSON-RPC)
        v
@mguttmann/hetzner-cloud-mcp (this server)
        |  HTTPS + Bearer token
        v
Hetzner Cloud API (https://api.hetzner.cloud/v1)
```

Tool tiers:

```
+------------------------------------------------+
| 12 hand-tuned tools     10 ergonomic wrappers  |
|                         + raw_request + wait_  |
|                         action (utility tools) |
+------------------------------------------------+
| 189 generated tools     1:1 with OpenAPI ops,  |
|                         full surface area,     |
|                         _raw suffix on         |
|                         collision              |
+------------------------------------------------+
                      201 total

       v  shared infra: auth . 429 backoff . pagination
              . action polling . confirm-guard . error mapping
```

---

## Installation

Two paths: install from npm for day-to-day use as an MCP server, or clone and build for local development.

### As an npm package (recommended for MCP-client use)

```bash
npm install -g @mguttmann/hetzner-cloud-mcp
```

Installs the `hetzner-cloud-mcp` binary on your `PATH`. In your MCP client config, the `command` is just `hetzner-cloud-mcp`.

### From source

```bash
git clone https://github.com/mguttmann/the-real-hetzner-mcp.git
cd the-real-hetzner-mcp
npm install
npm run build
```

The build emits an executable `dist/index.js` you can point your MCP client at directly.

---

## Setup

You need a Hetzner Cloud API token. Create one in the Cloud Console (Project → Security → API tokens) — "Read & Write" if you want the write-side tools to work; "Read" alone is fine for a sandbox.

```bash
cp .env.example .env
# Add HETZNER_API_TOKEN to .env (Read & Write token from the Hetzner Cloud Console)
npm run refresh-spec
npm run generate
npm run build
```

`refresh-spec` downloads the current OpenAPI spec, `generate` rebuilds `src/tools/generated/operations.ts`, `build` compiles TypeScript to `dist/`. Repeat `refresh-spec` and `generate` only when Hetzner ships a spec update.

Optional smoke test against the real API (four read-only calls):

```bash
npm run test:live
```

Runs `tests/live-smoke.test.ts` against your token and hits four list endpoints. Override the anchors via `HETZNER_LIVE_SMOKE_ANCHORS` to point the live smoke at different resources.

---

## MCP connector setup (Claude Desktop / Claude Code)

Append to your client's MCP config (`~/Library/Application Support/Claude/claude_desktop_config.json` for Claude Desktop, or the equivalent in Claude Code).

### Variant A — installed via npm

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

### Variant B — from source

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

Restart the client to pick up the change. `tools/list` should expose 201 tools whose names start with `hcloud_`.

---

## Usage examples

Each bullet is a natural-language prompt for Claude; the arrow notes which MCP tool gets invoked.

- **"List all my Hetzner servers."** → calls `hcloud_list_servers` (optional `name_contains` filter; default sort by name).
- **"Show me CPU and disk metrics for server `web-01` for the last hour."** → calls `hcloud_get_server_metrics`; default time window is the last hour.
- **"Create a snapshot of server `bitwarden` with description `pre-upgrade backup`."** → calls `hcloud_server_snapshot` with `type=snapshot` filled in, then polls the action via `hcloud_wait_action`.
- **"Reboot server `web-01`."** → calls `hcloud_server_power` with `op=reboot` (same wrapper handles poweron / poweroff / reboot / shutdown / reset).
- **"Show me all firewalls and which servers they apply to."** → calls `hcloud_list_firewalls`; the response includes `applied_to`.
- **"Apply firewall `web-fw` to server `web-01`."** → calls `hcloud_apply_firewall_to_server`, resolving both by name.
- **"List my SSH keys."** → calls `hcloud_list_ssh_keys` (generated tool, naming follows `hcloud_<verb>_<resource>`).
- **"What images do I have available?"** → calls `hcloud_list_images`.

Anything Claude can describe in plain language maps to either a wrapper (the dozen most common operations) or a generated tool. If neither fits, `hcloud_raw_request` handles the long tail.

---

## Safety — the write-guard

Destructive operations can be gated behind an opt-in confirm step controlled by `HETZNER_CONFIRM_WRITES`.

- **Default (`false`).** Write tools execute directly. Convenient for a sandbox or a trusted session.
- **Enabled (`true`).** Destructive tools no longer execute on first call. They return a preview describing what they *would* call — method, path, body — and refuse to execute unless `confirm: "YES"` is passed in the same call's args. This forces a deliberate second turn for every mutating action.

The guard wraps **every** write tool: the mutating wrappers (`hcloud_server_power`, `hcloud_server_rebuild`, `hcloud_server_snapshot`, `hcloud_server_backup`, `hcloud_server_rescue`, `hcloud_server_change_type`, `hcloud_apply_firewall_to_server`); generated mutating tools that map to `POST`, `PUT`, `PATCH`, or `DELETE` (`hcloud_create_ssh_key`, `hcloud_delete_ssh_key`, `hcloud_delete_server`, ...); and write calls through `hcloud_raw_request` — there is no bypass-by-default route. Read calls (`GET`) always bypass the guard; they don't change state.

When the guard refuses, the response looks like this:

```json
{
  "preview": true,
  "would_call": {
    "method": "POST",
    "path": "/servers/12345/actions/poweroff",
    "body": {}
  },
  "hint": "Re-run with `confirm: \"YES\"` to execute."
}
```

Recommendation: turn the guard **on** for production tokens, **off** for sandbox-only or read-only tokens where the friction outweighs the safety.

---

## Configuration reference

All configuration is via environment variables — typically the MCP client config's `env` block, or a `.env` file for local development.

| Name | Default | Description |
|---|---|---|
| `HETZNER_API_TOKEN` | **REQUIRED** (no default) | Bearer token for the Hetzner Cloud API. Create one in the Cloud Console. |
| `HETZNER_API_BASE` | `https://api.hetzner.cloud/v1` | Base URL for the API. Override for mocks or regional endpoints. |
| `HETZNER_CONFIRM_WRITES` | `false` | When `true`, destructive tools return a preview and require `confirm: "YES"`. |
| `LOG_LEVEL` | `warn` | Pino log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. |
| `HTTP_TIMEOUT_MS` | `30000` | Per-request HTTP timeout (ms). |
| `ACTION_POLL_TIMEOUT_MS` | `60000` | Total timeout for `hcloud_wait_action` (ms). |
| `ACTION_POLL_INTERVAL_MS` | `2000` | Poll interval between action-status checks (ms). |
| `PAGINATION_MAX_ITEMS` | `500` | Soft cap on items returned across paginated list calls. |
| `PAGINATION_MAX_PAGES` | `10` | Soft cap on pages walked during automatic pagination. |

Test-only: `HETZNER_LIVE_SMOKE_ANCHORS` targets specific resources for the live smoke — see `tests/live-smoke.test.ts`.

---

## Tools — overview

### Hand-tuned wrappers

| Tool | What it does |
|---|---|
| `hcloud_list_servers` | Server list with `name_contains` filter and default sort by `name`. |
| `hcloud_get_server` | Fetch a server by `id` OR `name`. |
| `hcloud_server_power` | poweron / poweroff / reboot / shutdown / reset in a single tool. |
| `hcloud_server_rebuild` | Rebuild a server, `image_id` OR `image_name`. |
| `hcloud_server_snapshot` | `create_image` with default `type=snapshot`. |
| `hcloud_server_backup` | Toggle automatic backups. |
| `hcloud_server_rescue` | Toggle rescue mode, default `type=linux64`. |
| `hcloud_server_change_type` | Change server type, default `upgrade_disk=false`. |
| `hcloud_get_server_metrics` | Server metrics, `id` OR `name`, default time window "last hour". |
| `hcloud_apply_firewall_to_server` | Apply a firewall to a server, by-id OR by-name. |
| `hcloud_raw_request` | Arbitrary request against the API. |
| `hcloud_wait_action` | Poll an action until success/error or timeout. |

### Generated tools

One tool per OpenAPI operation, naming scheme `hcloud_<verb>_<resource>` or `hcloud_<resource>_<action>_action`. On name collision with a wrapper the generated tool gets the suffix `_raw` (`hcloud_list_servers_raw`, `hcloud_get_server_raw`, `hcloud_get_server_metrics_raw`).

Run `tools/list` in the Inspector to see the full list.

---

## Spec updates

When Hetzner updates the OpenAPI:

```bash
npm run refresh-spec       # re-downloads specs/cloud.spec.json
npm run generate           # rebuilds src/tools/generated/operations.ts
npm test                   # codegen snapshot shows the diff
npm run refresh-snapshot   # rewrite the snapshot deliberately (after review)
git add specs/cloud.spec.json src/tools/generated/operations.ts tests/snapshots/tool-registry.json
git commit -m "chore(spec): refresh from Hetzner"
```

The test suite holds a snapshot of the generated tool registry, so a spec refresh that changes tool names, parameters, or descriptions shows up as a failing snapshot test. Review the diff (a renamed operation upstream is a breaking change for any conversation that referenced the old name), then refresh the snapshot deliberately with `npm run refresh-snapshot` and commit.

---

## Manual verification recipe

Run before declaring a release ready:

1. `npm run inspector` — opens the MCP Inspector with this server.
2. `tools/list` — verify count ≥ 200 and that all 12 wrapper names appear.
3. `hcloud_list_servers` (no args) — verify against at least one known server in your account.
4. `hcloud_get_server` with `name: "<one of your server names>"` — should return id, type, ip.
5. `hcloud_create_ssh_key` with `{ name: "mcp-smoke", public_key: "<your test key>" }` — note the returned id.
6. `hcloud_delete_ssh_key` with that id — confirm clean removal.

Do **not** run power/rebuild/snapshot operations against production servers as part of a smoke test.

---

## Limitations / out of scope

**Not covered:** Hetzner Robot (the dedicated-server API, a separate product), Hetzner DNS (the standalone DNS product, a separate API from Cloud DNS), and Hetzner Storage Boxes (yet another separate API). These are out of scope by design — they aren't part of the Cloud API and the codegen has no spec for them.

**Covered:** Cloud DNS zones via `/v1/zones` are Cloud-native — they live inside the Cloud API spec — so they **are** in scope through the generated tools.

**Codegen drift.** The codegen relies on the official OpenAPI spec. If Hetzner ships a new feature and forgets to update the spec, that feature is only reachable via `hcloud_raw_request` until the next `npm run refresh-spec` brings the spec up to date.

**Action polling timeout.** Long-running actions can exceed the default 60 s `ACTION_POLL_TIMEOUT_MS`. The action keeps running on Hetzner's side; the tool just stops waiting. Bump the timeout via env var for workloads where you expect long actions.

**Pagination soft-caps.** `PAGINATION_MAX_ITEMS=500` and `PAGINATION_MAX_PAGES=10` keep response payloads under MCP's practical size limits. Raise via env if you routinely list more — but very large responses can blow past the client's context window.

---

## Contributing

PRs welcome. For non-trivial changes please file an issue first so we can sanity-check the direction. Before opening a PR, run `npm test && npm run typecheck && npm run build` and keep the changes minimal — surgical fixes review much faster than sprawling refactors. Spec refresh PRs (`chore(spec): refresh from Hetzner`) are especially welcome; they keep this project honest.

---

## Security

Found a security issue? See [SECURITY.md](./SECURITY.md).

---

## License

MIT — see [LICENSE](./LICENSE).
