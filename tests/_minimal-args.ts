import type { JSONSchema } from "../src/types.js";

/** A minimal argument object that passes the top-level schema check. */
export function minimalArgs(name: string, schema: JSONSchema): Record<string, unknown> {
  if (name === "hcloud_raw_request") return { method: "GET", path: "/servers" };
  const props = (schema.properties ?? {}) as Record<string, JSONSchema>;
  const args: Record<string, unknown> = {};
  for (const key of (schema.required as string[] | undefined) ?? []) {
    const p = props[key] ?? {};
    const type = Array.isArray(p.type) ? p.type[0] : p.type;
    if (Array.isArray(p.enum)) args[key] = p.enum[0];
    else if (type === "integer" || type === "number") args[key] = Math.max(1, Number(p.minimum ?? 1));
    else if (type === "boolean") args[key] = true;
    else if (type === "array") args[key] = [];
    else if (type === "object") args[key] = {};
    else args[key] = "x";
  }
  return args;
}
