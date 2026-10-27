// Canonical hostile / invalid resource-id payloads, shared by every id-guard
// test so all sinks are proven against the exact same list (issue #54).
// Not a *.test.ts file, so vitest does not collect it as a suite.

/** Path-injection payloads reproduced against the real `new URL` semantics. */
export const PATH_INJECTION_IDS: unknown[] = [
  "42/actions/reset_password#",
  "42/actions/reset_password?",
  "../../ssh_keys#",
  "42/../../ssh_keys#",
  "1/../../floating_ips/9/actions/unassign?",
  "//evil.com/x",
  "\\evil.com",
];

/** Strings that look numeric but are not JSON integers. */
export const STRINGY_IDS: unknown[] = ["42", "42abc", "", " 42", "0x2a"];

/** Numbers outside the declared `{type:"integer", minimum:1, maximum:2^53-1}`. */
export const OUT_OF_RANGE_IDS: unknown[] = [
  0,
  -1,
  1.5,
  NaN,
  Infinity,
  9007199254740992,
];

/** Wrong JSON types entirely. */
export const WRONG_TYPE_IDS: unknown[] = [null, undefined, {}, [], true];

export const INVALID_IDS: unknown[] = [
  ...PATH_INJECTION_IDS,
  ...STRINGY_IDS,
  ...OUT_OF_RANGE_IDS,
  ...WRONG_TYPE_IDS,
];

/** Stable, unique test title for a payload (NaN and Infinity both JSON-ify to "null"). */
export function label(value: unknown, index: number): string {
  return `#${index} ${typeof value === "number" ? String(value) : JSON.stringify(value)}`;
}
