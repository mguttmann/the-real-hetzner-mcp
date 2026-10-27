import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import type { OperationDef, ParameterDef } from "../src/types.js";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;
type Method = (typeof HTTP_METHODS)[number];

const WRAPPER_COLLISIONS = new Set([
  "hcloud_list_servers",
  "hcloud_get_server",
  "hcloud_get_server_metrics",
]);

// MCP destructiveHint: false means "performs only additive updates". Every write
// is destructive unless it creates a resource (POST without an actions segment)
// or is one of these actions, which only add an association or a copy, or start
// a stopped server. Explicit tool names, so a new action is destructive until
// someone decides otherwise.
const ADDITIVE_ACTIONS = new Set([
  "hcloud_certificate_retry_action",
  "hcloud_load_balancer_add_service_action",
  "hcloud_load_balancer_add_target_action",
  "hcloud_load_balancer_attach_to_network_action",
  "hcloud_network_add_route_action",
  "hcloud_network_add_subnet_action",
  "hcloud_server_add_to_placement_group_action",
  "hcloud_server_attach_to_network_action",
  "hcloud_server_create_image_action",
  "hcloud_server_enable_backup_action",
  "hcloud_server_poweron_action",
  "hcloud_volume_attach_action",
  "hcloud_zone_rrset_add_records_action",
]);

const SINGLETON_PATHS = new Set(["pricing"]);

// Tool contract: a spec refresh must not make a field of an existing tool
// required. These keep the body `required` list the tool had before the
// refresh that tightened it; the API stays the authority and rejects a call
// that lacks the field (B-017, spec of 2026-10).
const PINNED_BODY_REQUIRED: Record<string, string[]> = {
  hcloud_floating_ip_change_dns_ptr_action: ["ip"],
  hcloud_load_balancer_change_dns_ptr_action: ["ip"],
  hcloud_primary_ip_change_dns_ptr_action: ["ip"],
  hcloud_server_change_dns_ptr_action: ["ip"],
};

function pinBodyRequired(
  toolName: string,
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const pinned = PINNED_BODY_REQUIRED[toolName];
  if (!schema || !pinned) return schema;
  return { ...schema, required: [...pinned] };
}

type SpecParam = {
  name: string;
  in: "path" | "query" | "header";
  required?: boolean;
  schema?: Record<string, unknown>;
  description?: string;
};

type SpecOperation = {
  summary?: string;
  description?: string;
  operationId?: string;
  parameters?: SpecParam[];
  requestBody?: {
    required?: boolean;
    content?: { "application/json"?: { schema?: Record<string, unknown> } };
  };
  responses?: Record<
    string,
    {
      content?: { "application/json"?: { schema?: Record<string, unknown> } };
    }
  >;
  tags?: string[];
};

type Spec = {
  paths: Record<string, Partial<Record<Method, SpecOperation>>>;
};

export type { OperationDef, ParameterDef };

function singularize(plural: string): string {
  if (plural.endsWith("ies")) return plural.slice(0, -3) + "y";
  if (plural.endsWith("s") && !plural.endsWith("ss")) return plural.slice(0, -1);
  return plural;
}

function isPathParam(seg: string): boolean {
  return seg.startsWith("{") && seg.endsWith("}");
}

function resourceChain(segs: string[], stopBefore?: number): string[] {
  // Singularized non-{param} segments, up to (but not including) `stopBefore`.
  const end = stopBefore ?? segs.length;
  const chain: string[] = [];
  for (let i = 0; i < end; i++) {
    const s = segs[i]!;
    if (!isPathParam(s)) chain.push(singularize(s));
  }
  return chain;
}

function deriveToolName(method: Method, path: string): string {
  const segs = path.split("/").filter(Boolean);

  if (segs.length === 1) {
    const r = segs[0]!;
    if (SINGLETON_PATHS.has(r)) return `hcloud_get_${r}`;
    if (method === "get") return `hcloud_list_${r}`;
    if (method === "post") return `hcloud_create_${singularize(r)}`;
  }

  if (segs.length === 2 && isPathParam(segs[1]!)) {
    const r = singularize(segs[0]!);
    if (method === "get") return `hcloud_get_${r}`;
    if (method === "put" || method === "patch") return `hcloud_update_${r}`;
    if (method === "delete") return `hcloud_delete_${r}`;
  }

  if (segs.length === 3 && isPathParam(segs[1]!)) {
    const r = singularize(segs[0]!);
    const sub = segs[2]!;
    if (sub === "actions" && method === "get") return `hcloud_list_${r}_actions`;
    if (sub === "metrics" && method === "get") return `hcloud_get_${r}_metrics`;
    return `hcloud_${method}_${r}_${sub}`;
  }

  if (
    segs.length === 4 &&
    isPathParam(segs[1]!) &&
    segs[2] === "actions"
  ) {
    const r = singularize(segs[0]!);
    const sub = segs[3]!;
    if (isPathParam(sub)) return `hcloud_get_${r}_action`;
    return `hcloud_${r}_${sub}_action`;
  }

  // Deep paths (5+ segments). Hetzner pattern:
  // <resA>/{idA}/<resB>/{idB}/<resC>[/actions/<name>]
  // Build a name from the singularized resource chain, with a special case for the
  // trailing /actions/<name> sub-path.
  if (segs.length >= 5) {
    const last = segs[segs.length - 1]!;
    const beforeLast = segs[segs.length - 2]!;
    // Trailing /actions/<action_name>: include the full chain up to "actions"
    // and emit hcloud_<chain>_<action>_action.
    if (beforeLast === "actions" && !isPathParam(last)) {
      const chain = resourceChain(segs, segs.length - 2);
      return `hcloud_${chain.join("_")}_${last}_action`;
    }
    // Trailing /actions/{id}: single action GET.
    if (beforeLast === "actions" && isPathParam(last) && method === "get") {
      const chain = resourceChain(segs, segs.length - 2);
      return `hcloud_get_${chain.join("_")}_action`;
    }
    // Otherwise, derive from the full resource chain (no action segment).
    const chain = resourceChain(segs);
    if (chain.length > 0) {
      if (method === "get") return `hcloud_get_${chain.join("_")}`;
      if (method === "delete") return `hcloud_delete_${chain.join("_")}`;
      if (method === "put" || method === "patch") return `hcloud_update_${chain.join("_")}`;
      if (method === "post") return `hcloud_create_${chain.join("_")}`;
    }
  }

  // Fallback: snake the whole path
  const slug = segs
    .map((s) => (isPathParam(s) ? s.slice(1, -1) : s))
    .join("_");
  return `hcloud_${method}_${slug}`;
}

function applyCollisionSuffix(toolName: string): string {
  return WRAPPER_COLLISIONS.has(toolName) ? `${toolName}_raw` : toolName;
}

function detectReturnsAction(op: SpecOperation): boolean {
  if (!op.responses) return false;
  for (const status of ["200", "201", "202"]) {
    const schema = op.responses[status]?.content?.["application/json"]?.schema;
    if (!schema) continue;
    const props = (schema as { properties?: Record<string, unknown> }).properties;
    if (props && "action" in props) return true;
  }
  return false;
}

function detectIsDestructive(
  method: Method,
  path: string,
  toolName: string,
): boolean {
  if (method === "get") return false;
  const isCreate = method === "post" && !path.split("/").includes("actions");
  if (isCreate) return false;
  return !ADDITIVE_ACTIONS.has(toolName);
}

const PROSE_KEYS = new Set(["summary", "description", "title"]);

/**
 * Replaces em and en dashes with "-" in prose (summary, description, title at
 * any depth). Values such as enum, pattern or example are left as they are.
 */
function plainDashes<T>(value: T, key?: string): T {
  if (typeof value === "string") {
    return (key !== undefined && PROSE_KEYS.has(key)
      ? value.replace(/[\u2014\u2013]/g, "-")
      : value) as T;
  }
  if (Array.isArray(value)) return value.map((v) => plainDashes(v)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, plainDashes(v, k)]),
    ) as T;
  }
  return value;
}

export function buildOperations(spec: Spec): OperationDef[] {
  const ops: OperationDef[] = [];
  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const m of HTTP_METHODS) {
      const op = methods?.[m];
      if (!op) continue;
      const baseName = deriveToolName(m, path);
      const toolName = applyCollisionSuffix(baseName);
      const parameters: ParameterDef[] = (op.parameters ?? []).map((p) => ({
        name: p.name,
        in: p.in,
        required: !!p.required,
        schema: p.schema ?? {},
        ...(p.description ? { description: p.description } : {}),
      }));
      const requestBodySchema = pinBodyRequired(
        toolName,
        op.requestBody?.content?.["application/json"]?.schema,
      );
      const requestBodyRequired = !!op.requestBody?.required;
      const okResponse = ["200", "201", "202", "204"]
        .map((s) => op.responses?.[s]?.content?.["application/json"]?.schema)
        .find(Boolean);
      ops.push({
        operationId: op.operationId ?? `${m}_${path}`.replace(/\W+/g, "_"),
        toolName,
        method: m.toUpperCase() as OperationDef["method"],
        path,
        summary: op.summary ?? "",
        description: op.description ?? "",
        tags: op.tags ?? [],
        parameters,
        ...(requestBodySchema ? { requestBodySchema } : {}),
        ...(requestBodySchema ? { requestBodyRequired } : {}),
        ...(okResponse ? { responseSchema: okResponse } : {}),
        returnsAction: detectReturnsAction(op),
        isDestructive: detectIsDestructive(m, path, toolName),
      });
    }
  }
  ops.sort((a, b) => a.toolName.localeCompare(b.toolName));
  return ops.map((op) => plainDashes(op));
}

function emitTypeScript(operations: OperationDef[]): string {
  const header =
    "// AUTO-GENERATED by scripts/generate.ts. Do not edit by hand.\n" +
    "// Run `npm run generate` after refreshing specs/cloud.spec.json.\n\n" +
    'import type { OperationDef } from "../../types.js";\n\n' +
    "export const OPERATIONS: OperationDef[] = " +
    JSON.stringify(operations, null, 2) +
    " as const;\n";
  return header;
}

async function main(): Promise<void> {
  const specPath = resolve(process.cwd(), "specs/cloud.spec.json");
  const outPath = resolve(process.cwd(), "src/tools/generated/operations.ts");
  const spec = JSON.parse(await readFile(specPath, "utf8")) as Spec;
  const operations = buildOperations(spec);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, emitTypeScript(operations), "utf8");
  process.stderr.write(
    `Wrote ${outPath} with ${operations.length} operations.\n`,
  );
}

const isDirectInvocation = process.argv[1]?.endsWith("generate.ts") ||
  process.argv[1]?.endsWith("generate.js");
if (isDirectInvocation) {
  main().catch((err) => {
    process.stderr.write(`generate failed: ${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  });
}
