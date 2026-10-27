import { readFileSync } from "node:fs";

const PACKAGE_NAME = "@mguttmann/hetzner-cloud-mcp";

/**
 * The package version from package.json, the single place it is maintained.
 * Looked up next to the module first, then one directory up (`dist/` or
 * `src/` beside `package.json` in a checkout and in an npm install).
 */
export function readPackageVersion(baseUrl: string = import.meta.url): string {
  for (const rel of ["./package.json", "../package.json"]) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(rel, baseUrl), "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (pkg.name === PACKAGE_NAME && typeof pkg.version === "string") return pkg.version;
    } catch {
      // not there or not readable: try the next candidate
    }
  }
  return "0.0.0-unknown";
}

/** Server version reported in `initialize`. */
export const SERVER_VERSION = readPackageVersion();
