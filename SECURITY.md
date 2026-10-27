# Security Policy

`@mguttmann/hetzner-cloud-mcp` gives an MCP client the authority of a Hetzner Cloud API
token. With a Read & Write token that includes creating, rebuilding and deleting servers,
volumes, networks, firewalls and DNS records, and resetting root passwords. Treat access to
this server like access to the token itself.

## Supported versions

| Version | Security fixes |
| ------- | -------------- |
| 0.2.x   | yes            |
| 0.1.x   | no, upgrade    |

Only the latest minor line receives fixes.

**0.1.x is affected by a path-injection vulnerability** that is fixed in 0.2.0. In 0.1.x some
hand-written tools put their arguments into the request path without validating or encoding
them, so a caller that was granted one tool could make it reach a different Hetzner Cloud API
endpoint (endpoint confusion inside the Hetzner API; the API host and the token never left the
configured base URL). 0.2.0 validates every resource id as an integer, rejects path parameters
that do not name exactly one path segment in any spelling, percent-encodes every path segment,
checks the assembled URL against the configured base and never follows redirects. Details of
the fix are in the 0.2.0 section of `CHANGELOG.md` and in "Input Validation" in `README.md`.

If the npm registry does not offer a 0.2.x release yet, install from source (see `README.md`)
instead of `npm install`.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub private vulnerability reporting:
<https://github.com/mguttmann/the-real-hetzner-mcp/security/advisories/new>. Do not open a
public issue with details. If that page is not available to you, open an issue that only asks
for a private contact, without any details.

Please include:

- the affected version (`npm ls -g @mguttmann/hetzner-cloud-mcp`, or the commit for a source
  install),
- the smallest reproduction you have, ideally against a fake upstream rather than a real
  Hetzner project,
- the impact you expect,
- optionally, a proposed fix.

This is a one-maintainer project. Reports are handled on a best-effort basis and take priority
over other work on it, but there is no guaranteed response or fix time. You will be credited in
the release notes unless you prefer not to be.

In scope: this package, its build and release pipeline, and how it handles the Hetzner API
token and tool input. Out of scope: vulnerabilities in the Hetzner Cloud API itself (report
those to Hetzner: <https://www.hetzner.com/legal/security/>) and advisories of dependencies that
are already public (open a regular issue or pull request).

## Threat model

The server runs locally and speaks MCP over stdio only. It opens no network port. Whoever can
start it or write to its stdin is a client.

### What holds the authority

- **The Hetzner API token is the only boundary inside Hetzner.** `HETZNER_API_TOKEN` is sent as
  a bearer token on every request. The server can do exactly what the token's project and
  permission (Read or Read & Write) allow, and nothing narrows that further. If a client only
  needs to read, give the server a Read token.
- **Optional read-only and deny switches narrow the server, not the token.** With
  `HETZNER_READ_ONLY=true` every tool that is not annotated read-only, and `hcloud_raw_request`
  with any method other than `GET`, returns an error without sending a request.
  `HETZNER_DENY_TOOLS` blocks tools by name glob the same way, read-only ones included; it
  matches tool names only, so deny `hcloud_raw_request` as well, otherwise every denied endpoint
  stays reachable through it. A deny pattern that matches no tool stops the server at startup.
  Both are off by default, are set by whoever controls the server environment (a caller cannot
  lift them, `confirm: "YES"` included) and leave the tool list and schemas unchanged, so a
  client still sees blocked tools. A Read token remains the stronger boundary, because it holds even if
  the server is misconfigured.
- **`hcloud_raw_request` covers the whole API.** It accepts any method and any path under the
  configured base URL, so granting this one tool grants every call the token allows.

### Confirm guard (`HETZNER_CONFIRM_WRITES`)

- Off by default. Without it, every write tool runs on the first call.
- With `HETZNER_CONFIRM_WRITES=true`, every tool that is not annotated read-only (and every
  destructive one) returns a preview of the tool name and input unless the call carries
  `confirm: "YES"`. `hcloud_raw_request` applies the same rule to every method except `GET`.
  Turning it on adds an optional `confirm` property to the input schema of those tools.
- `confirm: "YES"` is supplied by the caller. A model can send it on the first call, so the
  guard is friction against mistakes, not a security boundary. It has no nonce, expiry or
  binding to a preview.
- `hcloud_wait_action` and the other read-only tools are never guarded.

### Gateways and shared deployments

When the server runs behind an MCP gateway that serves several users, the gateway decides who
may call which tool, by tool name. The server cannot tell callers apart and does not check
roles. Grants should therefore be specific: a pattern that matches `hcloud_raw_request` (or
every tool of this server) hands out every write the token allows. Tool names and their input
schemas are kept stable between releases so that name-based grants keep meaning the same
thing; a change is listed under "Behaviour changes" in `CHANGELOG.md`.

### Requests the server sends

- Requests go only to `HETZNER_API_BASE` (default `https://api.hetzner.cloud/v1`). It must use
  `https`, or plain `http` on `localhost`, `127.0.0.1` or `::1`; any other value stops the server
  at startup. The host is not restricted: whoever controls the server environment controls where
  the token is sent.
- Redirects are never followed, so the token and request bodies only reach the configured
  origin.
- Tool arguments are validated against the declared input schema before any request is built,
  and path parameters must name a single segment (see "Input Validation" in `README.md`).
  Request bodies are passed to the API, which validates them.

### Data in results and logs

- Tool results return what the Hetzner API returns, including one-time secrets such as a new
  `root_password`. They reach the MCP client and, from there, its LLM provider.
- Logs go to stderr as JSON (stdout carries the MCP protocol). The server does not log the
  token or request headers; as a safety net the logger drops `authorization` and
  `HETZNER_API_TOKEN` keys nested one level deep (pino `redact`). Validation failures log the
  property name and the value's type, not the value. A handler error is logged with its error
  object, which can contain text from the Hetzner API.
- `dotenv` loads the `.env` file in the package directory at startup, never one from the
  working directory, so a `.env` in whatever directory the server is started from has no effect.
  Never commit `.env` (it is in `.gitignore`).

### Supply chain

Few runtime dependencies (`@modelcontextprotocol/server`, `pino`, `dotenv`) and a committed
lockfile. CI fails on high or critical advisories in runtime dependencies, checks registry
signatures and scans the full git history with gitleaks. Releases are built in GitHub Actions
from a tag on `main` and ship the npm tarball with a CycloneDX SBOM, `SHA256SUMS` and a build
provenance attestation. The release workflow creates a GitHub release only when the repository
variable `GH_RELEASE_ENABLED` is `true`, and publishes to npm (trusted publishing with
provenance, after the GitHub release) only when `NPM_PUBLISH_ENABLED` is `true` as well; both
are off until the maintainer enables them. The repository settings these workflows rely on
(rulesets, required checks, the npm trusted publisher) are in
[`docs/maintainers/repo-settings.md`](docs/maintainers/repo-settings.md).

Install only the npm package `@mguttmann/hetzner-cloud-mcp` (MCP Registry name
`io.github.mguttmann/the-real-hetzner-mcp`), this repository or its GitHub releases; packages
with similar names are not from this project.

Verify a downloaded release asset:

```bash
sha256sum --check SHA256SUMS
gh attestation verify mguttmann-hetzner-cloud-mcp-<version>.tgz --repo mguttmann/the-real-hetzner-mcp
```
