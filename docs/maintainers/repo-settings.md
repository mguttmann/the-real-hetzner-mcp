# Repository settings (maintainers)

The workflows in `.github/workflows/` assume the GitHub settings below. A workflow cannot set
them itself; the repository owner applies them once, in the web UI or with the `gh api` calls
shown (run them from a checkout of this repository, `gh` fills in `{owner}` and `{repo}`).

`tests/release-chain.test.ts` fails when a job is added to `ci.yml` without being listed in the
required checks below, when a publish path or a release switch goes missing, and when a job
that checks out code is granted `id-token: write`.

## 1. Ruleset for `main`

Settings > Rules > Rulesets > New branch ruleset.

- Name `main`, enforcement **Active**, target **Default branch**, bypass actor **Repository
  admin** (the single maintainer pushes directly; outside contributions go through pull
  requests and the required checks).
- **Restrict deletions** and **Block force pushes**.
- **Require a pull request before merging** (required approvals 0 while there is a single
  maintainer; raise it with a second one).
- **Require status checks to pass**, with **Require branches to be up to date before
  merging**. Required checks (job names of `.github/workflows/ci.yml`, GitHub Actions as the
  source):
  - `test (22)`, `test (24)`, `test (26)`
  - `node-floor`
  - `audit`
  - `deploy-path`
  - `gitleaks`

The same set runs again on every release tag: `release.yml` calls `ci.yml` on the tag commit
and refuses a tag whose commit is not on `main`.

```bash
gh api -X POST repos/{owner}/{repo}/rulesets --input - <<'EOF'
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [ { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" } ],
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          { "context": "test (22)" }, { "context": "test (24)" }, { "context": "test (26)" },
          { "context": "node-floor" },
          { "context": "audit" },
          { "context": "deploy-path" },
          { "context": "gitleaks" }
        ] } }
  ]
}
EOF
```

## 2. Ruleset for release tags

Settings > Rules > Rulesets > New tag ruleset: name `release-tags`, enforcement **Active**,
target pattern `v*`, bypass actor **Repository admin**, rules **Restrict creations**,
**Restrict updates**, **Restrict deletions**. A published tag then cannot be moved to another
commit.

```bash
gh api -X POST repos/{owner}/{repo}/rulesets --input - <<'EOF'
{
  "name": "release-tags",
  "target": "tag",
  "enforcement": "active",
  "bypass_actors": [ { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" } ],
  "conditions": { "ref_name": { "include": ["refs/tags/v*"], "exclude": [] } },
  "rules": [ { "type": "creation" }, { "type": "update" }, { "type": "deletion" } ]
}
EOF
```

## 3. Actions

Settings > Actions > General:

- **Workflow permissions**: *Read repository contents and packages permissions*. Every
  workflow declares its own minimal `permissions`; only the `github-release`, `npm-publish`
  and `mcp-registry` jobs of `release.yml` and the job of `mcp-registry.yml` (also when
  started by hand) ask for more, and none of them checks out code.
- **Allow GitHub Actions to create and approve pull requests**: off.
- **Actions permissions**: allow actions created by GitHub (all actions in use are
  `actions/*`, pinned by commit SHA).
- **Fork pull request workflows**: require approval for all outside collaborators.

```bash
gh api -X PUT repos/{owner}/{repo}/actions/permissions/workflow \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false
```

## 4. Code security

Settings > Code security:

- **Private vulnerability reporting**: on (the confidential channel `SECURITY.md` points to).
- **Dependabot alerts** and **Dependabot security updates**: on. Version updates are
  configured in `.github/dependabot.yml` (target branch `main`).
- **Secret scanning** with **push protection**: on. The `gitleaks` job scans the full history
  in CI as well.
- **CodeQL**: default setup for JavaScript/TypeScript and GitHub Actions. After its first run,
  add its check to the `main` ruleset.

```bash
gh api -X PUT repos/{owner}/{repo}/private-vulnerability-reporting
gh api -X PUT repos/{owner}/{repo}/vulnerability-alerts
gh api -X PUT repos/{owner}/{repo}/automated-security-fixes
gh api -X PATCH repos/{owner}/{repo} \
  -f 'security_and_analysis[secret_scanning][status]=enabled' \
  -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled'
gh api -X PATCH repos/{owner}/{repo}/code-scanning/default-setup -f state=configured
```

## 5. Release switches and npm publishing

Two repository variables (Settings > Secrets and variables > Actions > Variables) switch the
outward-facing release jobs on. Both are off (unset) by default, so a tag alone only builds and
checks the assets and keeps them as a workflow artifact:

- `GH_RELEASE_ENABLED` = `true`: the `github-release` job attests build provenance and creates
  the GitHub release with the tarball, the SBOM and `SHA256SUMS`.
- `NPM_PUBLISH_ENABLED` = `true`: the `npm-publish` job publishes the tarball the `build` job
  packed (the same bytes as the release asset) with provenance. It needs the GitHub release,
  so it also needs `GH_RELEASE_ENABLED`.

```bash
gh variable set GH_RELEASE_ENABLED --body true
gh variable set NPM_PUBLISH_ENABLED --body true
gh variable list
```

npm trusted publisher (the `npm-publish` job needs no `NPM_TOKEN`): on npmjs.com, package
`@mguttmann/hetzner-cloud-mcp` > Settings > Trusted publishing > GitHub Actions, with exactly
these fields:

- Organization or user: `mguttmann`
- Repository: `the-real-hetzner-mcp`
- Workflow filename: `release.yml`
- Environment name: empty (the `npm-publish` job declares none)

The package exists on npm already (0.1.0 and 0.1.1, published by hand without provenance), so
the trusted publisher can be added before the first workflow publish. The trusted publisher is
validated only by that first publish: check that the `npm-publish` job succeeds and that the
version shows a provenance statement (`npm view @mguttmann/hetzner-cloud-mcp@<version>
dist.attestations`). Trusted publishing needs npm 11.5.1 or newer; the job checks its npm
version. Provenance needs a public repository. Afterwards, optionally disallow token-based
publishing in the package settings, so only the workflow can publish.

## 6. MCP Registry

`server.json` describes the server for the official MCP Registry
(`registry.modelcontextprotocol.io`) as `io.github.mguttmann/the-real-hetzner-mcp`, with the
npm package as its only package. The `mcp-registry` job of `release.yml` (stable tags only,
after a successful `npm-publish`) runs `.github/workflows/mcp-registry.yml`, which can also be
started by hand for an existing tag (Actions > MCP Registry > Run workflow, inputs `tag` and
`npm-published`). No repository setting and no secret is needed:

- Authentication is GitHub OIDC (`id-token: write`); the registry grants the namespace
  `io.github.<repository owner>/*`.
- The registry accepts the npm package only when npm serves that version with `mcpName`
  `io.github.mguttmann/the-real-hetzner-mcp` (from `package.json`). The workflow checks that
  first and waits for a fresh publish. Versions before 0.2.0 carry no `mcpName` and cannot be
  listed.
- `server.json` is read from the tag; its version must equal the tag
  (`tests/release-chain.test.ts` holds it equal to `package.json`). A version the registry
  already lists is skipped, because registry versions are permanent.
- `mcp-publisher` is pinned by version and SHA-256 in the workflow (`MCP_PUBLISHER_VERSION`,
  `MCP_PUBLISHER_SHA256`, value from the registry release's
  `registry_<version>_checksums.txt`).

A listed version can be marked deprecated or deleted with `mcp-publisher status` after a
`mcp-publisher login github`; it cannot be replaced.

## 7. Glama

Glama lists public MCP repositories on its own. The `glama.json` in the repository root names
the GitHub users who may maintain that listing (`maintainers`); Glama reads it only during its
"Claim" flow, so after a change to the file the maintainer runs the claim again. Signed in on
glama.ai with GitHub as a listed maintainer, claim the listing on its page.

Glama's tool inspection runs the server in a container configured in the listing's admin area
(Node.js version, build steps, start command, environment). The server answers `tools/list`
without calling the Hetzner API, so a placeholder `HETZNER_API_TOKEN` is enough; never enter a
real API token there.

## Check the result

```bash
gh api repos/{owner}/{repo}/rulesets
gh api repos/{owner}/{repo}/actions/permissions/workflow
gh api repos/{owner}/{repo}/private-vulnerability-reporting
gh api repos/{owner}/{repo}/vulnerability-alerts   # 204 when on
gh api repos/{owner}/{repo} --jq .security_and_analysis
gh variable list
```
