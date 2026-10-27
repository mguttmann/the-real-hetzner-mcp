import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(resolve(ROOT, file), "utf8");

describe("NOTICE and the provenance of the vendored spec", () => {
  it("NOTICE says unofficial, excludes the Hetzner spec from MIT and points at its provenance", () => {
    const notice = read("NOTICE").replace(/\s+/g, " ");
    expect(notice).toContain("not affiliated with, endorsed by, sponsored by or supported by Hetzner Online GmbH");
    expect(notice).toContain("specs/cloud.spec.json");
    expect(notice).toContain("NOT licensed under the MIT License");
    expect(notice).toContain("specs/SOURCE.md");
    expect(notice).toContain("src/tools/generated/operations.ts");
    expect(notice).toMatch(/trademark/i);
  });

  it("specs/SOURCE.md records the URL, the fetch date and the sha256 of the committed spec", () => {
    const source = read("specs/SOURCE.md");
    const sha = createHash("sha256").update(readFileSync(resolve(ROOT, "specs/cloud.spec.json"))).digest("hex");
    expect(source).toContain(sha);
    expect(source).toContain("https://docs.hetzner.cloud/cloud.spec.json");
    expect(read("scripts/refresh-spec.ts")).toContain('"https://docs.hetzner.cloud/cloud.spec.json"');
    expect(source).toMatch(/Fetched: \d{4}-\d{2}-\d{2}/);
  });
});
