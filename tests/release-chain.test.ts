import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Release and supply-chain rules that live in workflow files, server.json and
// the maintainer docs. Workflows are read as text (no YAML parser in the
// tree); jobs are the two-space-indented keys under `jobs:`.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(resolve(ROOT, file), "utf8");

/** `jobs:` of a workflow, keyed by job id, each with its raw text. */
function jobs(workflow: string): Map<string, string> {
  const start = workflow.indexOf("\njobs:\n");
  expect(start, "workflow has a jobs: block").toBeGreaterThanOrEqual(0);
  const body = workflow.slice(start + "\njobs:\n".length);
  const out = new Map<string, string>();
  const heads = [...body.matchAll(/^ {2}([a-z0-9-]+):\n/gm)];
  heads.forEach((m, i) => {
    out.set(m[1]!, body.slice(m.index, heads[i + 1]?.index ?? body.length));
  });
  return out;
}

/** The `run:` commands of a job, one entry per script line. */
function runLines(job: string): string[] {
  const lines: string[] = [];
  const all = job.split("\n");
  all.forEach((line, i) => {
    const single = /^\s*(?:- )?run: (?![|>])(.+)$/.exec(line);
    if (single) lines.push(single[1]!.replace(/^["']|["']$/g, ""));
    else if (/^\s*(?:- )?run: [|>]\s*$/.test(line)) {
      const indent = /^\s*/.exec(all[i + 1] ?? "")![0].length;
      for (let j = i + 1; j < all.length; j++) {
        const next = all[j]!;
        if (next.trim() && /^\s*/.exec(next)![0].length < indent) break;
        lines.push(next.trim());
      }
    }
  });
  return lines.filter(Boolean);
}

/** Workflow-level text before `jobs:`. */
const header = (workflow: string) => workflow.slice(0, workflow.indexOf("\njobs:\n"));

const WORKFLOW_DIR = ".github/workflows/";
const workflows = Object.fromEntries(
  readdirSync(resolve(ROOT, WORKFLOW_DIR))
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => [f, read(WORKFLOW_DIR + f)]),
) as Record<string, string>;
const ci = workflows["ci.yml"]!;
const release = workflows["release.yml"]!;
const registry = workflows["mcp-registry.yml"] ?? "";
const releaseJobs = jobs(release);

const pkg = JSON.parse(read("package.json")) as {
  name: string;
  version: string;
  mcpName?: string;
};

describe("release.yml", () => {
  it("runs on version tags only", () => {
    expect(release).toMatch(/^on:\n {2}push:\n {4}tags:\n {6}- "v\*\.\*\.\*"\n\n/m);
    expect(header(release)).not.toMatch(/branches|pull_request|workflow_dispatch|schedule/);
  });

  it("refuses a tag that does not match package.json or is not on main", () => {
    const verify = runLines(releaseJobs.get("verify") ?? "").join("\n");
    expect(verify).toContain("require('./package.json').version");
    expect(verify).toContain('"$TAG" != "v$version"');
    expect(verify).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/main');
  });

  it("runs the whole CI workflow on the tag commit before it builds", () => {
    expect(ci).toMatch(/^ {2}workflow_call:/m);
    expect(releaseJobs.get("ci")).toMatch(/^ {4}uses: \.\/\.github\/workflows\/ci\.yml$/m);
    expect(releaseJobs.get("build")).toMatch(/^ {4}needs: \[[^\n]*\bci\b[^\n]*\]$/m);
  });

  it("builds the tarball, an SBOM and SHA256SUMS, and attests them in a gated GitHub release", () => {
    const build = runLines(releaseJobs.get("build") ?? "").join("\n");
    expect(build).toContain("npm ci --ignore-scripts");
    expect(build).toContain("npm pack --pack-destination release");
    expect(build).toContain("npm sbom");
    expect(build).toContain("SHA256SUMS");
    const gh = releaseJobs.get("github-release") ?? "";
    expect(gh).toMatch(/^ {4}if: \$\{\{ vars\.GH_RELEASE_ENABLED == 'true' \}\}$/m);
    expect(gh).toMatch(/actions\/attest-build-provenance@[0-9a-f]{40} # v\d/);
    for (const asset of ["release/*.tgz", "release/*.cdx.json", "release/SHA256SUMS"]) {
      expect(gh, asset).toContain(asset);
    }
    expect(release).not.toContain("--clobber");
  });

  it("publishes to npm only behind NPM_PUBLISH_ENABLED, after the GitHub release, with OIDC", () => {
    const job = releaseJobs.get("npm-publish") ?? "";
    expect(job).toMatch(/^ {4}if: \$\{\{ vars\.NPM_PUBLISH_ENABLED == 'true' \}\}$/m);
    expect(job).toMatch(/^ {4}needs: \[[^\n]*\bgithub-release\b[^\n]*\]$/m);
    expect(job).toMatch(/^ {6}id-token: write$/m);
    expect(job).toContain("sha256sum --check");
    // Trusted publishing needs npm 11.5.1 or newer.
    expect(job).toContain("11.5.1");
  });

  it("publishes the built tarball by a ./ path, never a bare dir/file.tgz", () => {
    // npm reads "release/x.tgz" as the GitHub shorthand owner/repo, not a file.
    const publish = Object.values(workflows)
      .flatMap((w) => [...jobs(w).values()].flatMap(runLines))
      .filter((l) => /\bnpm publish\b/.test(l));
    expect(publish.length).toBeGreaterThan(0);
    for (const line of publish) {
      expect(line).toMatch(/^npm publish \.\/release\/\S+\.tgz /);
      expect(line).toContain("--provenance");
      expect(line).toContain("--access public");
    }
  });

  it("lists stable releases in the MCP Registry after a successful npm publish", () => {
    const job = releaseJobs.get("mcp-registry") ?? "";
    expect(job).toMatch(/^ {4}needs: \[[^\n]*\bnpm-publish\b[^\n]*\]$/m);
    expect(job).toContain("needs.npm-publish.result == 'success'");
    expect(job).toContain("needs.verify.outputs.prerelease != 'true'");
    expect(job).toMatch(/^ {4}uses: \.\/\.github\/workflows\/mcp-registry\.yml$/m);
    expect(job).toMatch(/^ {6}id-token: write$/m);
  });
});

describe("mcp-registry.yml", () => {
  const run = [...jobs(registry).values()].flatMap(runLines);
  const at = (needle: string, from = 0) => {
    const i = run.slice(from).findIndex((l) => l.includes(needle));
    return i < 0 ? -1 : from + i;
  };

  it("is reusable from release.yml and can be started by hand", () => {
    expect(registry).toMatch(/^ {2}workflow_call:/m);
    expect(registry).toMatch(/^ {2}workflow_dispatch:/m);
  });

  it("runs a mcp-publisher pinned by version and SHA-256, checked before it is unpacked", () => {
    expect(registry).toMatch(/MCP_PUBLISHER_VERSION: v\d+\.\d+\.\d+\n/);
    expect(registry).toMatch(/MCP_PUBLISHER_SHA256: [0-9a-f]{64}\n/);
    expect(run.join("\n")).not.toMatch(/releases\/latest|\|\s*(ba)?sh\b/);
    const check = run.findIndex((l) => l.includes("${MCP_PUBLISHER_SHA256}") && l.includes("sha256sum --check"));
    const extract = at("tar -xzf");
    expect(check).toBeGreaterThanOrEqual(0);
    expect(extract).toBeGreaterThan(check);
    expect(at("./mcp-publisher login github-oidc", extract)).toBeGreaterThan(extract);
    expect(at("./mcp-publisher publish", extract)).toBeGreaterThan(extract);
  });

  it("lists the npm package only, once npm serves the version with the right mcpName", () => {
    expect(registry).not.toMatch(/mcpb/i);
    const text = run.join("\n");
    expect(text).toContain("https://registry.npmjs.org/${ident}/${version}");
    expect(text).toContain(".mcpName // empty");
    expect(text).toContain("https://registry.modelcontextprotocol.io/v0.1/servers/");
  });
});

describe("workflow hygiene", () => {
  it("covers the expected workflow files", () => {
    expect(Object.keys(workflows).sort()).toEqual(["ci.yml", "mcp-registry.yml", "release.yml"]);
  });

  it("never grants id-token: write to a job that checks out code, nor workflow-wide", () => {
    const offenders: string[] = [];
    for (const [file, text] of Object.entries(workflows)) {
      const top = /^permissions:\n((?: {2}.*\n)*)/m.exec(header(text));
      expect(top, `${file} declares workflow-level permissions`).not.toBeNull();
      expect(top![1], file).not.toContain("id-token");
      for (const [id, job] of jobs(text)) {
        if (/id-token: write/.test(job) && /actions\/checkout@/.test(job)) offenders.push(`${file} ${id}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every job that runs steps has a timeout", () => {
    const missing: string[] = [];
    for (const [file, text] of Object.entries(workflows)) {
      for (const [id, job] of jobs(text)) {
        if (/^ {4}uses: /m.test(job)) continue; // a reusable-workflow call cannot set one
        if (!/^ {4}timeout-minutes: \d+$/m.test(job)) missing.push(`${file} ${id}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("every action is pinned to a full commit SHA", () => {
    const unpinned: string[] = [];
    for (const [file, text] of Object.entries(workflows)) {
      for (const m of text.matchAll(/^\s*(?:- )?uses: ([^\s#]+)/gm)) {
        const ref = m[1]!;
        if (ref.startsWith("./")) continue;
        if (!/@[0-9a-f]{40}$/.test(ref)) unpinned.push(`${file}: ${ref}`);
      }
    }
    expect(unpinned).toEqual([]);
  });
});

describe("server.json (MCP Registry)", () => {
  const server = JSON.parse(read("server.json")) as {
    $schema: string;
    name: string;
    title: string;
    version: string;
    repository: { url: string; source: string };
    packages: {
      registryType: string;
      identifier: string;
      version: string;
      transport: { type: string };
      environmentVariables: { name: string; isRequired?: boolean; isSecret?: boolean }[];
    }[];
  };
  // Every variable src/config.ts reads.
  const configNames = new Set([...read("src/config.ts").matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]!));

  it("has the registry schema, the package.json mcpName and the package.json version", () => {
    expect(server.$schema).toMatch(
      /^https:\/\/static\.modelcontextprotocol\.io\/schemas\/\d{4}-\d{2}-\d{2}\/server\.schema\.json$/,
    );
    expect(server.name).toBe("io.github.mguttmann/the-real-hetzner-mcp");
    expect(pkg.mcpName).toBe(server.name);
    expect(server.title).toBe("Hetzner Cloud (unofficial)");
    expect(server.version).toBe(pkg.version);
    expect(server.repository).toEqual({ url: "https://github.com/mguttmann/the-real-hetzner-mcp", source: "github" });
  });

  it("lists exactly the npm package, at the package.json version, over stdio", () => {
    expect(server.packages).toHaveLength(1);
    const [p] = server.packages;
    expect(p!.registryType).toBe("npm");
    expect(p!.identifier).toBe(pkg.name);
    expect(p!.version).toBe(pkg.version);
    expect(p!.transport.type).toBe("stdio");
  });

  it("names only environment variables src/config.ts reads, the token as the one required secret", () => {
    expect(configNames.has("HETZNER_API_TOKEN")).toBe(true);
    const env = server.packages[0]!.environmentVariables;
    expect(env.map((e) => e.name).filter((n) => !configNames.has(n))).toEqual([]);
    expect(new Set(env.map((e) => e.name)).size).toBe(env.length);
    expect(env.filter((e) => e.isSecret).map((e) => e.name)).toEqual(["HETZNER_API_TOKEN"]);
    expect(env.filter((e) => e.isRequired).map((e) => e.name)).toEqual(["HETZNER_API_TOKEN"]);
  });
});

describe("docs/maintainers/repo-settings.md", () => {
  const doc = read("docs/maintainers/repo-settings.md");

  it("names every ci.yml job as a required check", () => {
    const missing = [...jobs(ci).keys()].filter((id) => !doc.includes(`\`${id}`) || !doc.includes(`"context": "${id}`));
    expect(missing).toEqual([]);
  });

  it("names the trusted publisher fields and both release switches", () => {
    expect(doc).toContain("`release.yml`");
    expect(doc).toContain("`the-real-hetzner-mcp`");
    expect(doc).toContain("GH_RELEASE_ENABLED");
    expect(doc).toContain("NPM_PUBLISH_ENABLED");
  });
});

describe("glama.json", () => {
  it("is exactly Glama's schema with mguttmann as maintainer", () => {
    expect(JSON.parse(read("glama.json"))).toEqual({
      $schema: "https://glama.ai/mcp/schemas/server.json",
      maintainers: ["mguttmann"],
    });
  });
});
