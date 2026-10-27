import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = resolve(ROOT, "scripts/sbom-root-name.mjs");
const PACKAGE_NAME = (JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as { name: string }).name;

type Bom = { metadata: { component: { name: string; "bom-ref": string; purl: string } }; components: unknown[] };

function fixUp(input: string) {
  const run = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, input, encoding: "utf8" });
  return { status: run.status, bom: JSON.parse(run.stdout) as Bom, stderr: run.stderr };
}

describe("scripts/sbom-root-name.mjs (release SBOM)", () => {
  // The real npm output for this repository; npm names the root component
  // after the checkout folder, which is not the package name.
  const npmBom = execFileSync("npm", ["sbom", "--sbom-format", "cyclonedx", "--omit=dev"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  it("writes the package name into the root component and changes nothing else", () => {
    const before = JSON.parse(npmBom) as Bom;
    const { status, bom, stderr } = fixUp(npmBom);
    expect(status).toBe(0);
    expect(bom.metadata.component.name).toBe(PACKAGE_NAME);
    expect({ ...bom, metadata: { ...bom.metadata, component: { ...bom.metadata.component, name: "x" } } }).toEqual({
      ...before,
      metadata: { ...before.metadata, component: { ...before.metadata.component, name: "x" } },
    });
    if (before.metadata.component.name !== PACKAGE_NAME) expect(stderr).toMatch(/root component/);
  });

  it("leaves a correctly named SBOM as it is and says the fix-up can go", () => {
    const named = JSON.parse(npmBom) as Bom;
    named.metadata.component.name = PACKAGE_NAME;
    const { status, bom, stderr } = fixUp(JSON.stringify(named));
    expect(status).toBe(0);
    expect(bom).toEqual(named);
    expect(stderr).toMatch(/can be dropped/);
  });
});
