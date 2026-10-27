import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("AGENTS.md", () => {
  const text = readFileSync(resolve(ROOT, "AGENTS.md"), "utf8");

  it("names only npm scripts that exist", () => {
    const scripts = (JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    }).scripts;
    const named = [...text.matchAll(/npm run (?:-s )?([a-z:-]+)/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((s) => !(s in scripts))).toEqual([]);
  });

  it("names only repository paths that exist", () => {
    const paths = [...text.matchAll(/`((?:src|tests|scripts|docs|\.github)\/[^`*\s]+)`/g)].map((m) => m[1]!);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.filter((p) => !existsSync(resolve(ROOT, p)))).toEqual([]);
  });

  it("has no em or en dashes", () => {
    expect(text).not.toMatch(/[\u2013\u2014]/);
  });
});
