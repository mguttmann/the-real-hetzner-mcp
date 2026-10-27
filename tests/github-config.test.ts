import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(resolve(ROOT, file), "utf8");

/** The lines of one job in a workflow, from its key to the next job key. */
function job(workflow: string, name: string): string {
  const lines = read(workflow).split("\n");
  const start = lines.indexOf(`  ${name}:`);
  expect(start, `job ${name} in ${workflow}`).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((l, i) => i > start && /^ {2}[a-z][a-z0-9-]*:\s*$/.test(l));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

describe("release workflow switches (default off)", () => {
  it("creates a GitHub release only when GH_RELEASE_ENABLED is 'true'", () => {
    expect(job(".github/workflows/release.yml", "github-release")).toMatch(
      /^ {4}if: \$\{\{ vars\.GH_RELEASE_ENABLED == 'true' \}\}$/m,
    );
  });

  it("publishes to npm only when NPM_PUBLISH_ENABLED is 'true', and only after the GitHub release", () => {
    const publish = job(".github/workflows/release.yml", "npm-publish");
    expect(publish).toMatch(/^ {4}if: \$\{\{ vars\.NPM_PUBLISH_ENABLED == 'true' \}\}$/m);
    expect(publish).toMatch(/^ {4}needs: \[.*\bgithub-release\b.*\]$/m);
  });
});

describe("dependabot", () => {
  it("updates npm and github-actions weekly, grouped, against main", () => {
    const text = read(".github/dependabot.yml");
    const entries = text.split(/^ {2}- /m).slice(1);
    expect(entries.map((e) => /package-ecosystem: "([^"]+)"/.exec(e)?.[1]).sort()).toEqual([
      "github-actions",
      "npm",
    ]);
    for (const entry of entries) {
      expect(entry).toMatch(/^ {4}directory: "\/"$/m);
      expect(entry).toMatch(/^ {6}interval: "weekly"$/m);
      expect(entry).toMatch(/^ {4}target-branch: "main"$/m);
      expect(entry).toMatch(/^ {4}groups:$/m);
    }
  });
});
