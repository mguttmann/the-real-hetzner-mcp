import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// B-021: .env is read from the package directory, not from the working
// directory, so whoever controls the cwd cannot point the token elsewhere.
// --env-file passed by the deployment keeps working from any cwd.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configUrl = pathToFileURL(join(repo, "src", "config.ts")).href;
// Resolved here, because --import resolves from the child's working directory.
const tsxLoader = import.meta.resolve("tsx");

function run(cwd: string, nodeArgs: string[], extraEnv: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env, ...extraEnv };
  for (const key of ["HETZNER_API_TOKEN", "HETZNER_API_BASE", "HZ_DOTENV_PROBE"]) {
    if (!(key in extraEnv)) delete env[key];
  }
  return spawnSync(
    process.execPath,
    [
      ...nodeArgs,
      "--import",
      tsxLoader,
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(configUrl)});` +
        `process.stderr.write(JSON.stringify({ probe: process.env.HZ_DOTENV_PROBE ?? null, file: m.PACKAGE_ENV_FILE, base: m.loadConfig().baseUrl }));`,
    ],
    { cwd, env, encoding: "utf8" },
  );
}

describe("dotenv location (B-021)", () => {
  it("ignores a .env in the working directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "hz-cwd-env-"));
    writeFileSync(join(dir, ".env"), "HZ_DOTENV_PROBE=from-cwd\nHETZNER_API_BASE=https://elsewhere.invalid/v1\n");
    const res = run(dir, [], { HETZNER_API_TOKEN: "dummy" });
    expect(res.status, res.stderr).toBe(0);
    const out = JSON.parse(res.stderr) as { probe: string | null; file: string; base: string };
    expect(out.probe).toBeNull();
    expect(out.base).toBe("https://api.hetzner.cloud/v1");
    expect(out.file).toBe(join(repo, ".env"));
    expect(res.stdout).toBe("");
  });

  it("node --env-file=<file> works from another working directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "hz-env-file-"));
    const file = join(dir, "deploy.env");
    writeFileSync(file, "HETZNER_API_TOKEN=dummy\nHETZNER_API_BASE=http://127.0.0.1:1/v1\nHZ_DOTENV_PROBE=from-env-file\n");
    const other = mkdtempSync(join(tmpdir(), "hz-other-cwd-"));
    const res = run(other, [`--env-file=${file}`]);
    expect(res.status, res.stderr).toBe(0);
    const out = JSON.parse(res.stderr) as { probe: string | null; base: string };
    expect(out.probe).toBe("from-env-file");
    expect(out.base).toBe("http://127.0.0.1:1/v1");
    expect(res.stdout).toBe("");
  });
});
