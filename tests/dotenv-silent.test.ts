import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// stdout is the MCP stdio channel: anything dotenv prints there corrupts the
// protocol. src/config.ts calls `config({ path, quiet: true })`, which must stay
// silent on stdout and stderr even when it injects variables.
describe("dotenv config({ quiet: true })", () => {
  it("loads .env without writing to stdout", () => {
    const dir = mkdtempSync(join(tmpdir(), "hz-dotenv-"));
    writeFileSync(join(dir, ".env"), "HZ_DOTENV_PROBE=loaded\n");
    const entry = pathToFileURL(createRequire(import.meta.url).resolve("dotenv")).href;
    const env = { ...process.env };
    delete env.DOTENV_CONFIG_QUIET;
    delete env.DOTENV_QUIET;
    delete env.DOTENV_CONFIG_DEBUG;
    delete env.DOTENV_DEBUG;
    const res = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { config } = await import(${JSON.stringify(entry)});` +
          `config({ path: ${JSON.stringify(join(dir, ".env"))}, quiet: true });` +
          `process.stderr.write(String(process.env.HZ_DOTENV_PROBE));`,
      ],
      { cwd: dir, env, encoding: "utf8" },
    );
    expect(res.status).toBe(0);
    expect(res.stderr).toBe("loaded");
    expect(res.stdout).toBe("");
  });
});
