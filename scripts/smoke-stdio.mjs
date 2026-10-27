#!/usr/bin/env node
// Stdio smoke test for the built server: initialize, notifications/initialized,
// tools/list. Plain node, no dependencies beyond node builtins and dist/.
//
// Usage:
//   node scripts/smoke-stdio.mjs [--env-file <file>] [--server <path>]
//     [--protocol-version <v>] [--min-tools <n>] [--expect-names-sha256 <hex>]
//     [--baseline <file>] [--timeout-ms <ms>]
//
// --baseline reads { "toolCount", "namesSha256" } from a JSON file (the
// gateway baseline is tests/gateway-baseline.json) and sets --min-tools and
// --expect-names-sha256 from it.
//
// Without --env-file the server inherits the current environment. Offline run:
//   HETZNER_API_TOKEN=dummy HETZNER_API_BASE=http://127.0.0.1:1 npm run smoke
//
// Prints one JSON object on stdout. Exit codes: 0 ok, 1 a check failed,
// 2 the server could not be started or did not answer.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PROTOCOL_VERSION = "2025-11-25";

function parseArgs(argv) {
  const opts = {
    envFile: undefined,
    server: resolve(dirname(fileURLToPath(import.meta.url)), "../dist/index.js"),
    protocolVersion: DEFAULT_PROTOCOL_VERSION,
    minTools: undefined,
    expectNamesSha256: undefined,
    timeoutMs: 15_000,
  };
  const flags = {
    "--env-file": (v) => (opts.envFile = resolve(v)),
    "--server": (v) => (opts.server = resolve(v)),
    "--protocol-version": (v) => (opts.protocolVersion = v),
    "--min-tools": (v) => (opts.minTools = toInt("--min-tools", v)),
    "--expect-names-sha256": (v) => (opts.expectNamesSha256 = v.toLowerCase()),
    "--baseline": (v) => {
      const baseline = readBaseline(v);
      opts.minTools = baseline.toolCount;
      opts.expectNamesSha256 = baseline.namesSha256;
    },
    "--timeout-ms": (v) => (opts.timeoutMs = toInt("--timeout-ms", v)),
  };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2);
    const set = flags[flag];
    if (!set) fail(2, `unknown argument: ${argv[i]}`);
    const value = inline ?? argv[++i];
    if (value === undefined) fail(2, `missing value for ${flag}`);
    set(value);
  }
  return opts;
}

function readBaseline(file) {
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(resolve(file), "utf8"));
  } catch (err) {
    fail(2, `--baseline ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Number.isInteger(baseline?.toolCount) || !/^[0-9a-f]{64}$/.test(baseline?.namesSha256 ?? "")) {
    fail(2, `--baseline ${file} needs an integer toolCount and a lowercase hex namesSha256`);
  }
  return baseline;
}

function toInt(flag, v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) fail(2, `${flag} needs a non-negative integer, got ${v}`);
  return n;
}

function fail(code, message, extra = {}) {
  process.stdout.write(JSON.stringify({ ok: false, error: message, ...extra }, null, 2) + "\n");
  process.exit(code);
}

function namesSha256(names) {
  return createHash("sha256").update([...names].sort().join("\n")).digest("hex");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const nodeArgs = opts.envFile ? [`--env-file=${opts.envFile}`, opts.server] : [opts.server];
  const child = spawn(process.execPath, nodeArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr = (stderr + d.toString("utf8")).slice(-4000);
  });

  const pending = new Map();
  let buffer = "";
  let exited = false;
  child.stdout.on("data", (d) => {
    buffer += d.toString("utf8");
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = msg.id !== undefined ? pending.get(msg.id) : undefined;
      if (waiter) {
        pending.delete(msg.id);
        waiter(msg);
      }
    }
  });
  child.on("error", (err) => fail(2, `spawn failed: ${err.message}`));
  child.on("exit", (code, signal) => {
    exited = true;
    if (pending.size > 0) {
      fail(2, `server exited early (code ${code}, signal ${signal})`, { stderr: stderr.trim() });
    }
  });

  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    fail(2, `no answer within ${opts.timeoutMs} ms`, { stderr: stderr.trim() });
  }, opts.timeoutMs);

  let nextId = 1;
  const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
  const request = (method, params) =>
    new Promise((resolveReq) => {
      const id = nextId++;
      pending.set(id, (msg) => {
        if (msg.error) fail(2, `${method} failed: ${JSON.stringify(msg.error)}`);
        resolveReq(msg.result);
      });
      send({ jsonrpc: "2.0", id, method, params });
    });

  const init = await request("initialize", {
    protocolVersion: opts.protocolVersion,
    capabilities: {},
    clientInfo: { name: "smoke-stdio", version: "1.0.0" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const names = [];
  let cursor;
  do {
    const page = await request("tools/list", cursor ? { cursor } : {});
    for (const t of page.tools ?? []) names.push(t.name);
    cursor = page.nextCursor;
  } while (cursor);

  clearTimeout(timer);
  child.stdin.end();
  if (!exited) child.kill("SIGTERM");

  const report = {
    ok: true,
    requestedProtocolVersion: opts.protocolVersion,
    protocolVersion: init.protocolVersion,
    serverInfo: init.serverInfo,
    toolCount: names.length,
    namesSha256: namesSha256(names),
  };
  const failures = [];
  if (opts.minTools !== undefined && report.toolCount < opts.minTools) {
    failures.push(`tool count ${report.toolCount} is below --min-tools ${opts.minTools}`);
  }
  if (opts.expectNamesSha256 !== undefined && report.namesSha256 !== opts.expectNamesSha256) {
    failures.push(`names sha256 ${report.namesSha256} differs from --expect-names-sha256`);
  }
  if (failures.length > 0) {
    report.ok = false;
    report.failures = failures;
  }
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((err) => fail(2, err instanceof Error ? err.message : String(err)));
