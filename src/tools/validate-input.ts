// Minimal JSON-Schema check for tools/call arguments. The low-level MCP Server
// class validates only the shape of the CallToolRequest, never the declared
// inputSchema - without this, `inputSchema` is pure declaration.
//
// Scope is deliberately TOP-LEVEL PROPERTIES ONLY. Every complex construct in
// this repo's schemas (allOf, oneOf, nullable, pattern, nested properties) sits
// inside `body`, which is the Hetzner API's own contract: it validates and
// answers 400, surfaced via asToolError. Recursing there would only produce
// false rejections.
//
// Fail-closed for the keywords below, ignore-and-pass for everything else, so
// this can only ever reject *more* than today (which is: nothing), never less.
import type { JSONSchema } from "../types.js";

const TYPE_NAMES = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

const SCALAR_TYPE_NAMES = new Set(["string", "number", "integer", "boolean", "null"]);

/**
 * Out-of-band control keys, tolerated under `additionalProperties: false` even
 * where the tool does not declare them, because the runtime has always discarded
 * them and a client that sends one habitually must not be rejected for it:
 *
 * - `confirm` is only added to a schema when HETZNER_CONFIRM_WRITES=true
 *   (confirm.ts), and hcloud_raw_request handles it itself;
 * - `wait` is declared only for action-returning operations and `auto_paginate`
 *   only for list endpoints, but splitInput (generated/tools.ts) skips both keys
 *   unconditionally for every generated tool.
 *
 * `body` is deliberately NOT here: it is payload, not a control key, and silently
 * dropping one a caller believes it sent is worse than saying so.
 */
const TOLERATED_KEYS = new Set(["confirm", "wait", "auto_paginate"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isPrimitive(v: unknown): boolean {
  return v === null || (typeof v !== "object" && typeof v !== "function");
}

/** How an offending value is named in an error message. */
type Describe = (value: unknown) => string;

/** For the caller: their own value, quoted and length-capped. */
const preview: Describe = (value) => {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 120 ? `${text.slice(0, 120)}...` : text;
};

function constructorName(value: object): string {
  const proto = Object.getPrototypeOf(value) as { constructor?: { name?: unknown } } | null;
  const name = proto?.constructor?.name;
  return typeof name === "string" && name.length > 0 ? name : "Object";
}

/**
 * For the log: the shape of the value, never the value. Request bodies can carry
 * private keys, certificates and passwords, and stderr is not the place for them.
 */
const typeOnly: Describe = (value) => {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length} items)`;
  if (typeof value === "string") return `string(${value.length} chars)`;
  if (typeof value === "object") return `object(${constructorName(value)})`;
  return typeof value;
};

/**
 * Normalise a `type` keyword to a list of supported type names.
 * Returns null when the keyword is absent, malformed, or names a type we do not
 * implement - in which case the check is skipped rather than guessed at.
 */
function typeNames(type: unknown): string[] | null {
  let names: string[];
  if (typeof type === "string") {
    names = [type];
  } else if (Array.isArray(type) && type.every((t) => typeof t === "string")) {
    names = type as string[];
  } else {
    return null;
  }
  if (names.length === 0) return null;
  if (!names.every((n) => TYPE_NAMES.has(n))) return null;
  return names;
}

function matchesType(value: unknown, name: string): boolean {
  switch (name) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isSafeInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}

/** The declared element types of an array property, if they are all scalars. */
function scalarItemTypeNames(schema: Record<string, unknown>): string[] | null {
  if (!isPlainObject(schema.items)) return null;
  const names = typeNames(schema.items.type);
  if (!names || !names.every((n) => SCALAR_TYPE_NAMES.has(n))) return null;
  return names;
}

/**
 * What is wrong with one element of an array of scalars (or with a bare scalar
 * standing in for that array), checked against `items`: type, then `enum`, then
 * `minimum`/`maximum`. Null when the element is fine. `typeText` names the
 * accepted type in the type error.
 */
function elementProblem(
  items: Record<string, unknown>,
  itemNames: string[],
  value: unknown,
  typeText: string,
  show: Describe,
): string | null {
  if (!itemNames.some((n) => matchesType(value, n))) {
    return `must be ${typeText}, got ${show(value)}.`;
  }
  if (Array.isArray(items.enum) && items.enum.every(isPrimitive) && !items.enum.includes(value)) {
    return `must be one of ${items.enum.map((v) => JSON.stringify(v)).join(", ")}, got ${show(value)}.`;
  }
  if (typeof value === "number") {
    if (typeof items.minimum === "number" && value < items.minimum) {
      return `must be >= ${items.minimum}, got ${show(value)}.`;
    }
    if (typeof items.maximum === "number" && value > items.maximum) {
      return `must be <= ${items.maximum}, got ${show(value)}.`;
    }
  }
  return null;
}

/**
 * Upper bound on per-element messages for one array property. Keeps a caller's
 * input from being amplified into the tool result and the log (refs #54 QA).
 */
const MAX_ELEMENT_ERRORS = 10;

function checkProperty(
  key: string,
  schema: Record<string, unknown>,
  value: unknown,
  errors: string[],
  show: Describe,
): void {
  const names = typeNames(schema.type);
  const itemNames = scalarItemTypeNames(schema);
  // A bare scalar where an array of scalars is declared: `sort: "name:asc"`
  // instead of `sort: ["name:asc"]`. Accepted because for a repeatable QUERY
  // parameter the HTTP client serialises a scalar to exactly the same single,
  // percent-encoded parameter - rejecting it would break a call that has always
  // worked.
  //
  // Correction (refs #54 QA): this is NOT true of every array-typed parameter in
  // the repo. `hcloud_server_rescue.ssh_keys` is array-typed and goes into the
  // BODY, where a scalar has no equivalent serialisation - it was silently
  // dropped while the call reported success. Leniency here is therefore only
  // safe as long as every consumer NORMALISES the scalar instead of testing
  // `Array.isArray` and ignoring the value; server_rescue.ts now does. Any new
  // array-typed body parameter must do the same, or reject.
  const scalarForArray =
    names !== null &&
    names.length === 1 &&
    names[0] === "array" &&
    !Array.isArray(value) &&
    itemNames !== null;

  if (scalarForArray) {
    const problem = elementProblem(
      schema.items as Record<string, unknown>,
      itemNames,
      value,
      `${itemNames.join(" or ")} or an array of them`,
      show,
    );
    if (problem) errors.push(`\`${key}\` ${problem}`);
    return;
  }

  if (names && !names.some((n) => matchesType(value, n))) {
    errors.push(
      `\`${key}\` must be ${names.join(" or ")}, got ${show(value)}.`,
    );
    return; // wrong type - the remaining keyword checks would only add noise
  }

  if (Array.isArray(schema.enum) && schema.enum.every(isPrimitive)) {
    if (!schema.enum.includes(value)) {
      errors.push(
        `\`${key}\` must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}, got ${show(value)}.`,
      );
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`\`${key}\` must be >= ${schema.minimum}, got ${show(value)}.`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`\`${key}\` must be <= ${schema.maximum}, got ${show(value)}.`);
    }
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`\`${key}\` must be at least ${schema.minLength} characters long.`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push(`\`${key}\` must be at most ${schema.maxLength} characters long.`);
    }
  }

  // Flat element check only (type, enum, minimum, maximum); nested object and
  // array item schemas are skipped.
  //
  // Capped on purpose (refs #54 QA): one message per bad element amplified the
  // caller's input into both the tool result AND the stderr log - measured 400 KB
  // of input becoming 7.5 MB of result and 8.9 MB into the logger (~19x). The log
  // is a shared resource on the host. A caller learns nothing from the
  // 500th identical type error that the first N plus a count does not tell it.
  if (Array.isArray(value) && itemNames) {
    let reported = 0;
    let offending = 0;
    const items = schema.items as Record<string, unknown>;
    for (const [i, item] of value.entries()) {
      const problem = elementProblem(items, itemNames, item, itemNames.join(" or "), show);
      if (problem === null) continue;
      offending++;
      if (reported < MAX_ELEMENT_ERRORS) {
        reported++;
        errors.push(`\`${key}[${i}]\` ${problem}`);
      }
    }
    if (offending > reported) {
      errors.push(
        `\`${key}\`: ${offending - reported} further element(s) have the same problem ` +
          `(only the first ${MAX_ELEMENT_ERRORS} are listed).`,
      );
    }
  }
}

export type ValidateOptions = {
  /**
   * Describe offending values by type instead of quoting them. Use for anything
   * that gets logged - arguments may contain private keys or passwords.
   */
  redactValues?: boolean;
};

/**
 * Validate `input` against the top level of `schema`.
 * Returns the collected error messages; an empty array means valid.
 *
 * Schemas without an object `properties` map are passed through unchecked, so
 * an untypical tool schema can never block all of its calls.
 */
export function validateToolInput(
  schema: JSONSchema,
  input: Record<string, unknown>,
  options: ValidateOptions = {},
): string[] {
  const show: Describe = options.redactValues ? typeOnly : preview;
  if (!isPlainObject(schema)) return [];
  const properties = schema.properties;
  if (!isPlainObject(properties)) return [];

  const errors: string[] = [];

  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (typeof key !== "string") continue;
      if (input[key] === undefined) {
        errors.push(`missing required property \`${key}\`.`);
      }
    }
  }

  for (const [key, propSchema] of Object.entries(properties)) {
    if (!isPlainObject(propSchema)) continue;
    const value = input[key];
    if (value === undefined) continue; // absent - only `required` covers that
    checkProperty(key, propSchema, value, errors, show);
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(input)) {
      if (TOLERATED_KEYS.has(key)) continue;
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        errors.push(`unknown property \`${key}\`.`);
      }
    }
  }

  return errors;
}
