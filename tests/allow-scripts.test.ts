import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type Lockfile = { packages: Record<string, { name?: string; hasInstallScript?: boolean }> };

const manifest = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
  allowScripts?: Record<string, boolean>;
};
const lockfile = JSON.parse(readFileSync(resolve(ROOT, "package-lock.json"), "utf8")) as Lockfile;

/**
 * Packages the lockfile marks with an install script, on every platform (the
 * lockfile also lists optional platform packages such as fsevents).
 */
function packagesWithInstallScripts(): string[] {
  const names = new Set<string>();
  for (const [path, entry] of Object.entries(lockfile.packages)) {
    if (!entry.hasInstallScript || path === "") continue;
    names.add(entry.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length));
  }
  return [...names].sort();
}

describe("npm install script policy (package.json allowScripts)", () => {
  it("decides every install script in the lockfile, so npm 11 has nothing to warn about", () => {
    const policy = manifest.allowScripts ?? {};
    expect(packagesWithInstallScripts().filter((name) => !(name in policy))).toEqual([]);
  });

  it("allows no install script: build and tests need none", () => {
    const policy = manifest.allowScripts ?? {};
    expect(Object.entries(policy).filter(([, allowed]) => allowed !== false)).toEqual([]);
  });
});
