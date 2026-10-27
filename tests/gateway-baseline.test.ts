import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { namesSha256 } from "../scripts/tools-contract.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_FILE = "tests/gateway-baseline.json";
const WORKFLOWS = [".github/workflows/ci.yml", ".github/workflows/release.yml"];

describe("gateway baseline has one source", () => {
  const baseline = JSON.parse(readFileSync(resolve(ROOT, BASELINE_FILE), "utf8")) as {
    toolCount: number;
    namesSha256: string;
  };

  it.each(WORKFLOWS)("%s reads the baseline from the file and writes no copy of it", (workflow) => {
    const text = readFileSync(resolve(ROOT, workflow), "utf8");
    const smokeRuns = text.split("\n").filter((l) => /npm run -s smoke/.test(l));
    expect(smokeRuns.length).toBeGreaterThan(0);
    for (const line of smokeRuns) expect(line).toContain(`--baseline ${BASELINE_FILE}`);
    expect(text).not.toContain(baseline.namesSha256);
    expect(text).not.toMatch(/--min-tools|--expect-names-sha256|MIN_TOOLS|TOOL_NAMES_SHA256/);
  });
});

describe("smoke-stdio --baseline", () => {
  const dir = mkdtempSync(join(tmpdir(), "smoke-baseline-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // A stand-in server: answers initialize and tools/list with two tools.
  const names = ["tool_a", "tool_b"];
  const server = join(dir, "server.mjs");
  writeFileSync(
    server,
    `import { createInterface } from "node:readline";
const tools = ${JSON.stringify(names)}.map((name) => ({ name, inputSchema: { type: "object" } }));
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  const result = msg.method === "initialize"
    ? { protocolVersion: msg.params.protocolVersion, capabilities: {}, serverInfo: { name: "fake", version: "0" } }
    : { tools };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
});
`,
  );

  function smoke(baseline: object) {
    const file = join(dir, `baseline-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(file, JSON.stringify(baseline));
    const run = spawnSync(
      process.execPath,
      [resolve(ROOT, "scripts/smoke-stdio.mjs"), "--server", server, "--baseline", file],
      { encoding: "utf8", timeout: 10_000 },
    );
    return { status: run.status, report: JSON.parse(run.stdout) as { ok: boolean; failures?: string[] } };
  }

  it("passes when count and name hash match the file", () => {
    const { status, report } = smoke({ toolCount: 2, namesSha256: namesSha256(names) });
    expect(report.ok).toBe(true);
    expect(status).toBe(0);
  });

  it("fails when the count falls below or the name hash differs", () => {
    const { status, report } = smoke({ toolCount: 3, namesSha256: "0".repeat(64) });
    expect(status).toBe(1);
    expect(report.failures).toHaveLength(2);
  });
});
