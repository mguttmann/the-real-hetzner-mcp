import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { buildRegistry } from "../src/build-registry.js";
import { loadConfig } from "../src/config.js";

export const TOOLS_CONTRACT_PATH = resolve(process.cwd(), "tests/snapshots/tools-contract.json");

export type ToolContractEntry = {
  name: string;
  required: string[];
  inputSchemaSha256: string;
  /** inputSchema hash with HETZNER_CONFIRM_WRITES=true (adds `confirm` to guarded tools). */
  inputSchemaSha256ConfirmWrites: string;
  descriptionSha256: string;
  annotations: unknown;
};

export type ToolsContract = {
  toolCount: number;
  /** sha256 of the sorted tool names joined by "\n", no trailing newline. */
  namesSha256: string;
  tools: ToolContractEntry[];
};

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** JSON with object keys sorted recursively, so key order never changes a hash. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function namesSha256(names: string[]): string {
  return sha256([...names].sort().join("\n"));
}

/** Builds the registry like src/index.ts does, offline, and reduces it to its caller contract. */
export function buildToolsContract(): ToolsContract {
  const base = { HETZNER_API_TOKEN: "dummy", HETZNER_API_BASE: "http://127.0.0.1:1" };
  const offlineFetch = (async () => {
    throw new Error("tools-contract: network access is not allowed");
  }) as typeof globalThis.fetch;
  const plain = buildRegistry(loadConfig(base), { fetch: offlineFetch }).getAll();
  const guarded = new Map(
    buildRegistry(loadConfig({ ...base, HETZNER_CONFIRM_WRITES: "true" }), { fetch: offlineFetch })
      .getAll()
      .map((t) => [t.name, t]),
  );
  const tools = plain.map((t) => {
    const g = guarded.get(t.name);
    if (!g) throw new Error(`tool ${t.name} missing with HETZNER_CONFIRM_WRITES=true`);
    const required = (t.inputSchema as { required?: unknown }).required;
    return {
      name: t.name,
      required: Array.isArray(required) ? [...(required as string[])] : [],
      inputSchemaSha256: sha256(canonicalJson(t.inputSchema)),
      inputSchemaSha256ConfirmWrites: sha256(canonicalJson(g.inputSchema)),
      descriptionSha256: sha256(t.description),
      annotations: t.annotations,
    };
  });
  return {
    toolCount: tools.length,
    namesSha256: namesSha256(tools.map((t) => t.name)),
    tools,
  };
}
