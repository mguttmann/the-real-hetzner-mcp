import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as Record<string, unknown>;

/** The file list `npm pack` would put into the tarball (no tarball is written). */
function packedFiles(): string[] {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const [entry] = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>;
  return entry!.files.map((f) => f.path);
}

describe("npm package contents", () => {
  it("lists only the build output and the legal and user docs", () => {
    expect(pkg.files).toEqual(["dist/", "README.md", "LICENSE", "NOTICE", "CHANGELOG.md"]);
  });

  it("packs exactly those files: no spec, no scripts, no .env example", () => {
    // The server reads nothing from specs/ or scripts/ at runtime.
    const files = packedFiles();
    expect(files.filter((f) => !f.startsWith("dist/")).sort()).toEqual(
      ["CHANGELOG.md", "LICENSE", "NOTICE", "README.md", "package.json"].sort(),
    );
    expect(files).toContain("dist/index.js");
  });
});

describe("package.json metadata", () => {
  it("points at the public repository and names the maintainer", () => {
    expect(pkg.repository).toEqual({
      type: "git",
      url: "git+https://github.com/mguttmann/the-real-hetzner-mcp.git",
    });
    expect(pkg.homepage).toBe("https://github.com/mguttmann/the-real-hetzner-mcp#readme");
    expect(pkg.bugs).toEqual({ url: "https://github.com/mguttmann/the-real-hetzner-mcp/issues" });
    expect(pkg.author).toBe("mguttmann (https://github.com/mguttmann)");
  });

  it("is published publicly with provenance under the registry name", () => {
    expect(pkg.name).toBe("@mguttmann/hetzner-cloud-mcp");
    expect(pkg.mcpName).toBe("io.github.mguttmann/the-real-hetzner-mcp");
    expect(pkg.publishConfig).toEqual({ access: "public", provenance: true });
    expect(pkg.engines).toEqual({ node: ">=22.12.0" });
    expect(pkg.bin).toEqual({ "hetzner-cloud-mcp": "dist/index.js" });
  });

  it("says it is unofficial and not affiliated with Hetzner", () => {
    expect(pkg.description).toMatch(/^Unofficial /);
    expect(pkg.description).toMatch(/Not affiliated with Hetzner/);
  });
});
