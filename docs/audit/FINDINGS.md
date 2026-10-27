# Audit findings 2026-10

Audit of the development line that became 0.2.0, in its state before the fixes below, and,
where noted, of public `main` (`44c4d7e`, 0.1.1) and the npm releases 0.1.0 and 0.1.1. Review dimensions: security of
inputs and outputs, destructive operations, robustness, API correctness, tests, docs,
dependencies and SDK, runtime and CI, releases and branches, history and secrets, and a critic
pass that merged duplicates and resolved severity conflicts.

How to read this file:

- Sorted by severity: blocker, major, minor, info. A finding reported by several dimensions is
  one entry here; its audit ids are listed so it can be traced.
- **Evidence** is `file:line` in that state before the fixes unless another ref is named. Lines
  have moved since.
- **Status** is one of: fixed in 0.2.0 (with the test that pins it), moved to
  [BACKLOG.md](BACKLOG.md) as `B-0xx`, owner decision (an outward-facing step such as
  publishing or changing repository settings), or no action. 0.2.0 is released as one commit
  on `main`, so the development commits of the fixes are not referenced here.
- Vulnerabilities are described by class and fix only. npm 0.1.0 and 0.1.1 are still the
  published versions, so this file contains no payloads or reproduction recipes.
- The caller contract 0.2.0 keeps (tool names, required parameters, defaults, tool count) is
  pinned by `tests/tools-contract.test.ts`, and every caller-visible change is listed under
  "Behaviour changes" in `CHANGELOG.md`.

## Blocker

### F-01 Published npm 0.1.x is vulnerable to path injection while the fix is public

- Audit ids: `fix-disclosed-npm-unpatched` (releases), `resolve-unpatched-npm-severity` (critic);
  merged duplicates `public-exploit-writeup-unpatched-npm` (history),
  `docs-exploit-details-public-before-release` and `docs-install-path-vulnerable-npm` (docs).
- Class: CWE-22 / CWE-74, endpoint confusion inside the Hetzner Cloud API. In 0.1.x some
  hand-written tools put caller-supplied ids into the request path without validation or
  encoding, so a caller granted one tool could reach other endpoints the token allows. The API
  host and the token never left the configured base URL.
- Evidence: npm 0.1.1 `dist/tools/wrappers/_server_action.js:4` (raw id in the path; source
  `44c4d7e:src/tools/wrappers/_server_action.ts`); the README before the fixes recommended
  `npm install -g` of the vulnerable release; `44c4d7e:SECURITY.md` listed 0.1.x as supported;
  the fix and its description are on public branches; no security advisory exists and private
  vulnerability reporting is disabled (repository settings).
- Status: **in-repo parts fixed; the release is an owner decision.**
  - SECURITY.md marks 0.1.x unsupported and affected and describes the class and the fix;
    release chain with SBOM, checksums and provenance.
  - README installs only with a version range that refuses 0.1.x or from a pinned commit;
    CHANGELOG describes the class and the fix without payloads.
  - Owner decision, recommended as soon as possible and in this order: publish 0.2.0 from this
    line with provenance, `npm deprecate` 0.1.0 and 0.1.1 with a pointer to the fix, publish a
    GitHub security advisory for `<0.2.0`, enable private vulnerability reporting.

## Major

### F-02 Auto-paginated list tools report HTTP errors as an empty, complete list

- Audit ids: `pagination-swallows-http-errors` (sec-outputs, tests),
  `paginate-ignores-http-errors` (robustness), `list-swallows-api-errors` (api-correctness),
  `one-class-http-errors-outside-astoolerror` (critic).
- Evidence: `src/http/pagination.ts:49-55` reads `body[resourceKey] ?? []` and never checks
  `res.status`; the auto-paginate branch of `src/tools/generated/tools.ts` and
  `src/tools/wrappers/server_list.ts:61-67` return the merge without `asToolError`. A 401 on
  the first page came back as an empty list with `truncated: false` and no `isError`.
- Status: **fixed in 0.2.0**: `fetchAllPages` throws the mapped `HetznerApiError`, the
  server formats it as `isError`. Test: `tests/upstream-errors.test.ts` (401 on page 1, 503 on
  page 2, 404 on a per-resource action list). Behaviour change, listed in the CHANGELOG.

### F-03 `hcloud_get_pricing` fails with its default arguments

- Audit id: `get-pricing-default-broken` (robustness).
- Evidence: `src/tools/generated/tools.ts:129` classifies `GET /pricing` as a list endpoint;
  `/pricing` returns an object, so the loop at `src/http/pagination.ts:58` throws.
- Status: **fixed in 0.2.0**: no pagination for it; `auto_paginate` stays in the schema, so
  the fingerprint is unchanged. Test: `tests/upstream-errors.test.ts` ("hcloud_get_pricing").

### F-04 A 429 can block a call for up to an hour and then resend a write

- Audit ids: `ratelimit-reset-hour-sleep`; minors of the same retry logic merged here:
  `post-retried-on-5xx`, `retry-after-http-date-nan` (robustness).
- Evidence: `src/http/client.ts:179-186` waits until `RateLimit-Reset` (full bucket recovery)
  with no cap; `src/http/client.ts:188` retries every method on 5xx; `src/http/client.ts:182`
  turns an HTTP-date `Retry-After` into `NaN`.
- Status: **fixed in 0.2.0**: `Retry-After` or a short backoff; the 429 is returned at once
  when the wait would exceed `HTTP_MAX_RETRY_DELAY_MS` (new, optional, default 10000); POST is
  not resent on 5xx; a non-numeric `Retry-After` falls back to the backoff. Tests:
  `tests/http-client.test.ts`, `tests/call-budget.test.ts`.

### F-05 A failed poll after a successful write discards the write result

- Audit id: `poll-failure-loses-write-result` (robustness).
- Evidence: `src/http/action-polling.ts:45` polls without catching transport errors;
  `src/tools/generated/tools.ts:214` and `src/tools/wrappers/_server_action.ts:38` return the
  write body only after a successful poll, so a network error after a create dropped the new
  resource id and a one-time `root_password`.
- Status: **fixed in 0.2.0**: the shared `pollAfterWrite` returns the write body with
  `polling_timed_out` and `polling_error`. Test: `tests/upstream-errors.test.ts` ("a poll failure
  after a successful write keeps the write result"). Behaviour change, listed in the CHANGELOG.

### F-06 The default poll window equals a 60 s client call timeout

- Audit id: `gateway-timeout-equals-poll-timeout` (critic).
- Evidence: `src/config.ts:22` `actionPollTimeoutMs: 60_000`, counted only after the write
  request; `wait` defaults to true on the action tools, so a long action ran past a 60 s caller
  timeout and the caller lost the write response.
- Status: **fixed in 0.2.0**: `ACTION_POLL_TIMEOUT_MS` is a wall-clock budget from the start
  of the call and defaults to 45000; `HTTP_TIMEOUT_MS` bounds one request including retries.
  Test: `tests/call-budget.test.ts`. Behaviour change, listed in the CHANGELOG.

## Minor

| Id | Finding (audit ids) | Evidence | Status |
| -- | ------------------- | -------- | ------ |
| F-07 | Action polling ignores HTTP errors and fabricates a `running` action (`polling-swallows-http-errors`, `polling-swallows-api-errors`) | `src/http/action-polling.ts:45`, `:61` | fixed in 0.2.0, `tests/upstream-errors.test.ts` |
| F-08 | No test runs the built server over stdio (`no-dist-stdio-test`) | `src/index.ts:83` (wiring untested) | fixed in 0.2.0 (`src/build-registry.ts`, `npm run smoke`), run in CI |
| F-09 | Contract snapshot covered generated metadata only, not every exposed tool (`contract-pin-incomplete`) | `tests/codegen.test.ts:16-31` | fixed in 0.2.0, `tests/tools-contract.test.ts` |
| F-10 | No CI on the development line, outdated Node matrix on `main` (`no-ci-on-production-branch`, `ci-workflow-missing-on-production`, `no-ci-on-production-line`, `no-ci-on-production`) | no `.github/` before the fixes; `44c4d7e:.github/workflows/ci.yml` | fixed in 0.2.0 (Node 22, 24, 26, a 22.12 floor job, the documented source install, SHA-pinned actions) |
| F-11 | No provenance, SBOM or checksums on releases (`no-provenance-sbom-checksums`) | `package.json` `publishConfig`; release v0.1.1 has no assets | fixed in 0.2.0 (release chain, nothing published) |
| F-12 | stdio transport closes on a message over 10 MiB and the process exits 0 with no log (`stdio-10mib-silent-exit`, `docs-changelog-missing-stdio-10mib-limit`) | `src/index.ts:83` (no onerror or onclose) | fixed in 0.2.0 (logged, exit 1), `tests/transport-lifecycle.test.ts`; documented 0.2.0 |
| F-13 | Server version hard-coded, already drifted in npm 0.1.1 (`server-version-hardcoded-drift`) | `src/server.ts:15` | fixed in 0.2.0, `tests/version.test.ts` |
| F-14 | `engines` allows end-of-life Node 20 and is below the toolchain floor (`engines-field-stale`, `engines-vs-vite8`, `docs-node-version-undocumented`) | `package.json:71` | fixed in 0.2.0 (`>=22.12.0`, README); behaviour change |
| F-15 | CHANGELOG showed 0.2.0 as released, broken links, no 0.1.1 entry (`docs-changelog-release-state-wrong`) | `CHANGELOG.md` 0.2.0 heading and footer | fixed in 0.2.0 |
| F-16 | README Setup runs `refresh-spec` and `generate`, which change the tool surface (`docs-setup-refresh-spec-changes-surface`) | `README.md:43` | fixed in 0.2.0 |
| F-17 | README says the write guard covers destructive tools; it covers every tool that is not read-only (`docs-confirm-guard-scope-wording`) | `README.md:13` | fixed in 0.2.0 |
| F-18 | README lists Hetzner DNS as out of scope although Cloud DNS tools exist (`docs-out-of-scope-dns-contradiction`) | `README.md:17` | fixed in 0.2.0 |
| F-19 | Fixed tool counts in the docs are held by no test (`docs-fixed-numbers-untested`) | `README.md`, `package.json` description | fixed in 0.2.0 (docs point at the contract test) |
| F-20 | `LOG_LEVEL` values documented that the code ignores (`docs-main-log-level-values`) | `44c4d7e:README.md:238` | fixed in 0.2.0 (configuration table pinned by `tests/config.test.ts`) |
| F-21 | Development line lacks SECURITY.md and CI (`docs-production-lacks-security-ci`) | no `SECURITY.md` before the fixes | fixed in 0.2.0; AGENTS.md added (B-026) |
| F-22 | Confirm guard is caller-supplied and off by default (`confirm-is-caller-supplied-and-off-by-default`) | `src/config.ts:19`, `src/tools/confirm.ts:42-46` | documented as friction, not a boundary, in SECURITY.md 0.2.0; behaviour kept |
| F-23 | Public `main` lockfile resolves dependencies with advisories (`public-main-lockfile-advisories`) | `44c4d7e:package-lock.json` | fixed in 0.2.0 (`npm audit` clean, CI audit gate); reaches users with the release in F-01 |
| F-24 | SDK v1 ends at protocol 2025-11-25 and is in maintenance (`sdk-v1-no-2026-07-28`) | `@modelcontextprotocol/sdk` 1.32.2 | migrated to SDK v2 in 0.2.0 (`docs/adr/0001-mcp-sdk-v2.md`); serving 2026-07-28 is opt-in (B-023, `MCP_SERVE_MODERN_PROTOCOL`) |
| F-25 | Upstream error text passed through verbatim and uncapped (`upstream-text-unmarked`, `unbounded-error-and-response-size`) | `src/http/errors.ts:52-56` | fixed in 0.2.0 (B-011: marked as upstream text, capped at 4096 characters), `tests/errors.test.ts` |
| F-26 | No byte cap on tool output (`no-output-size-cap`) | `src/http/client.ts:237` | fixed in 0.2.0 (B-012: `MAX_OUTPUT_BYTES`, default 8 MiB), `tests/output-cap.test.ts`; the response read itself is not capped |
| F-27 | Network errors reach the caller as a bare "fetch failed" (`opaque-network-error-text`, `no-process-handlers-and-lost-error-cause`) | `src/server.ts:61-71` | transport logging and the cause in the result fixed in 0.2.0 (B-013), `tests/errors.test.ts` |
| F-28 | `hcloud_raw_request` description says auth and retries are not applied (`raw-request-description-wrong`) | `src/tools/raw_request.ts:15` | fixed in 0.2.0 (B-002: description corrected, behaviour unchanged), `tests/raw_request.test.ts` |
| F-29 | Test files are not typechecked (`tests-not-typechecked`) | `tsconfig.json` `include` | fixed in 0.2.0 (B-014: `tsconfig.test.json` in `npm run typecheck`) |
| F-30 | Non-additive writes carry `destructiveHint: false` (`destructive-hint-false-on-non-additive-writes`) | `scripts/generate.ts:14-19`, `:162-171`; `src/tools/wrappers/server_backup.ts:20` | fixed in 0.2.0 (B-015: every non-additive write is `destructiveHint: true`; guard scope unchanged), `tests/destructive-hints.test.ts` |
| F-31 | No read-only or deny switch (`no-read-only-or-deny-switch`) | `src/config.ts:59-81` | fixed in 0.2.0 (B-016: optional `HETZNER_READ_ONLY` and `HETZNER_DENY_TOOLS`, enforced at call time, schemas unchanged), `tests/call-policy.test.ts` |
| F-32 | `hcloud_wait_action` accepts an unbounded `timeout_ms` and a 1 ms interval (`wait-action-unbounded-overrides`, `wait-action-unbounded-polling`) | `src/tools/wait_action.ts:20-21` | fixed in 0.2.0 (B-004: clamped in the handler, schema unchanged), `tests/wait_action.test.ts` |
| F-33 | Vendored spec predates the `/datacenters` deprecation and the removed `datacenter` body field (`datacenters-endpoint-past-removal`, `stale-spec-datacenter-fields`, `regen-diff-summary`) | `specs/cloud.spec.json` | fixed in 0.2.0 (B-017: spec refreshed, `hcloud_get_network_members` added, no tool removed, `dns_ptr` pinned optional), `tests/spec-refresh-pins.test.ts`, `tests/tools-contract.test.ts` |
| F-34 | Rescue `type` enum offers values the API no longer accepts (`rescue-enum-retired-types`) | `src/tools/wrappers/server_rescue.ts:15` | fixed in 0.2.0 (B-018: only `linux64`), `tests/tools/server_rescue.test.ts` |
| F-35 | Validator ignores `items.enum` and item bounds (`validator-ignores-items-enum-and-bounds`) | `src/tools/validate-input.ts:118-124`, `:161-167` | fixed in 0.2.0 (B-019), `tests/validate-input.test.ts` |
| F-36 | `hcloud_raw_request` forwards percent-encoded separators inside a segment (`raw-request-leaves-v1-via-encoded-separators`) | `src/http/client.ts:70-98` | fixed in 0.2.0 (B-020: `%2F`, `%5C`, `%2E` rejected in the raw path), `tests/raw_request.test.ts`, `tests/origin-view-invariant.test.ts` |
| F-37 | `HETZNER_API_BASE` unvalidated, `.env` read from the working directory (`api-base-unvalidated-and-cwd-dotenv`) | `src/config.ts:1`, `:61` | fixed in 0.2.0 (B-021: https required, http only on loopback; `.env` read from the package directory), `tests/config.test.ts`, `tests/dotenv-package-dir.test.ts`; the host is not restricted |
| F-38 | Em and en dashes in code, tests and user-visible strings (`docs-dashes`) | `src/tools/confirm.ts` preview text and others | docs, code, tests and tool text fixed in 0.2.0 (B-005), `tests/no-dashes.test.ts` |
| F-39 | Commits on public non-main branches carry author identities other than the noreply identity (`agent-anthropic-attribution`, `non-noreply-identities-public`) | author lines of commits on two public non-main branches | owner decision (delete those branches); `main` and the 0.2.0 release commit use the noreply identity |
| F-40 | Private vulnerability reporting, secret scanning and Dependabot alerts are disabled (`pvr-disabled-security-md-link`) | repository settings | owner decision: enable them and read the settings back |
| F-41 | Commit messages on public non-main branches describe the vulnerability and a deployment in detail (`gateway-architecture-in-commit-messages`) | commit messages on two public non-main branches | owner decision (delete those branches together with the release); the 0.2.0 release commit and the test comments use generic wording |
| F-42 | `npm install` warns about skipped esbuild install scripts (`npm-install-scripts-warning`) | `package.json` | fixed in 0.2.0 (B-022: `allowScripts` denies both, no script enabled) |

## Info

| Id | Finding (audit ids) | Status |
| -- | ------------------- | ------ |
| F-43 | Plan to reconcile public `main` with the development line (`reconcile-design`, `resolve-reconcile-design-severity`; one dimension rated it major, the critic pass info because no wrong behaviour was reproduced) | owner decision, part of the release in F-01 |
| F-44 | Tool results return one-time secrets such as `root_password` (`secrets-in-tool-results`) | documented in SECURITY.md 0.2.0 ("Data in results and logs") |
| F-45 | gitleaks hits are upstream spec examples (`gitleaks-upstream-examples`) | `.gitleaks.toml` allowlist and gitleaks in CI, 0.2.0 |
| F-46 | `dotenv` 17 and later write to stdout through `config()`, not through `import "dotenv/config"` (`resolve-dotenv17-stdout`) | `tests/dotenv-silent.test.ts`; in 0.2.0 `src/config.ts` calls `config({ quiet: true })` and the test checks that call |
| F-47 | pino 9 installed, 10 available (`pino-9`) | done in 0.2.0; the redact paths are pinned by `tests/logger-redact.test.ts` (B-006) |
| F-48 | Server negotiates 2025-11-25 when 2026-07-28 is requested (`protocol-2026-07-28-not-supported`) | pinned by a test; opt-in 2026-07-28 via `MCP_SERVE_MODERN_PROTOCOL` in 0.2.0 (B-023), default unchanged |
| F-49 | Change-protection tools are neither annotated destructive nor gated separately (`protection-removable-by-same-caller`) | fixed with B-015 in 0.2.0: change-protection tools are `destructiveHint: true`; they are still not gated separately |
| F-50 | An unknown tool name answers JSON-RPC -32603 (`unknown-tool-protocol-error`) | no action |
| F-51 | Published npm tarballs and the GitHub release contain no secrets (`published-artifacts-clean`) | no action |
| F-52 | An orphaned pre-squash commit is reachable through a CI run and is clean (`orphan-pre-squash-commit-clean`) | no action |
| F-53 | `hcloud_server_rebuild` sends the image id as a number (`rebuild-image-id-number`) | no action (the official Go client does the same) |
| F-54 | Adversarial re-review of the path-injection fix holds (`path-injection-fix-rereview-holds`) | no action |
| F-55 | `dotenv` is redundant when the server is started with `--env-file` (`dotenv-redundant-with-env-file`) | no action, kept for the source setup |

Not listed: `stale-local-gateway-evidence`, `gateway-fingerprint-and-gate-scope` and
`coverage-gaps-unverified` are notes about the audit's own evidence, not about this repository.
The coverage notes led to the 22.12.x floor job and the x86_64 Ubuntu runners in CI; memory use
was not measured.
