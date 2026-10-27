#!/usr/bin/env node
// Reads a CycloneDX SBOM from `npm sbom` on stdin and writes it to stdout with
// the root component named after package.json.
//
// npm (checked with 11.17.0) names the root component after the folder the
// project is checked out in, not after the package; bom-ref and purl are
// already right. The name is only rewritten when it differs, and both cases
// are reported on stderr, so the release log shows when npm has fixed this
// and the step can be dropped from .github/workflows/release.yml.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8"),
);
const bom = JSON.parse(readFileSync(0, "utf8"));
const component = bom.metadata.component;

if (component.name === pkg.name) {
  process.stderr.write(
    `::notice::npm sbom already names the root component ${pkg.name}; this fix-up can be dropped\n`,
  );
} else {
  process.stderr.write(
    `::notice::npm sbom named the root component ${JSON.stringify(component.name)}; writing ${pkg.name}\n`,
  );
  component.name = pkg.name;
}
process.stdout.write(JSON.stringify(bom, null, 2) + "\n");
