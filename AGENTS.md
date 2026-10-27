# AGENTS.md

Notes for coding agents and contributors. User documentation is in `README.md`, the threat
model in `SECURITY.md`.

## Commands

- `npm ci`: install from the lockfile. `allowScripts` in `package.json` denies the esbuild and
  fsevents install scripts on purpose; nothing needs them.
- `npm run typecheck`: `src` with `tsconfig.json`, then `src`, `tests` and `scripts` with
  `tsconfig.test.json`.
- `npm test`: the full vitest suite, offline. `npm run test:live` calls the real Hetzner API
  with a real token; never run it unless the owner asks for it.
- `npm run build`: compiles to `dist/`.
- `HETZNER_API_TOKEN=dummy HETZNER_API_BASE=http://127.0.0.1:1 npm run -s smoke -- --baseline tests/gateway-baseline.json`:
  starts `dist/index.js` over stdio, offline, and checks the gateway baseline, as CI does.
- `npm run generate` rebuilds `src/tools/generated/operations.ts` from `specs/cloud.spec.json`;
  `npm run refresh-spec` downloads a new spec; update the date and SHA-256 in `specs/SOURCE.md`
  in the same commit (`tests/notice.test.ts` checks the hash). Both change the tool contract
  (see below).

## Tool contract

MCP clients and gateways grant tools by name and fingerprint each tool by name, description and
input schema. Keep it stable:

- Never rename or remove a tool, never make an optional parameter required, never change a
  default. New tools and new optional parameters are allowed and listed in `CHANGELOG.md`.
- `tests/tools-contract.test.ts` compares every tool with `tests/snapshots/tools-contract.json`
  (required fields, schema hash, description hash, annotations). Refresh it with
  `npm run refresh-snapshot` only for an intended change, and list each changed tool in the
  CHANGELOG under "Behaviour changes".
- The gateway baseline (tool count must not fall, sorted names hash) is
  `tests/gateway-baseline.json`, the one source for the contract test and the CI and release
  smoke. No script rewrites it; change it only for a deliberate contract change.
- New environment variables are optional, with a default that keeps the current behaviour. Add
  each to `src/config.ts`, the README configuration table, `.env.example` and
  `tests/config.test.ts`.

## Tests and rules

- Tests never reach the real Hetzner API: use a spy or fake `fetch`, or a fake upstream on
  `127.0.0.1`.
- Reproduce a bug with a failing test first, then fix it.
- English in the repository, no em or en dashes (`tests/no-dashes.test.ts` checks `src`,
  `tests` and `scripts`).
- Minor findings go to `docs/audit/BACKLOG.md` (ids are never reused); audit findings are in
  `docs/audit/FINDINGS.md`.
- Workflows in `.github/workflows` pin every action by commit SHA; lint them with
  `docker run --rm -v "$PWD:/repo" --workdir /repo rhysd/actionlint:latest`.
  `tests/release-chain.test.ts` holds the release rules (tag gate, `./` publish path, release
  switches, `id-token: write` only in jobs without a checkout, `server.json` in step with
  `package.json`); a new `ci.yml` job must also be added to the required checks in
  `docs/maintainers/repo-settings.md`.
- The npm package ships only `dist/`, `README.md`, `LICENSE`, `NOTICE` and `CHANGELOG.md`
  (`tests/package-files.test.ts`); bump `version` in `package.json` and `server.json` together.
