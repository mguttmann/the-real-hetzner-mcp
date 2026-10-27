// Shared caller-input guards for the hand-written wrappers. Not registered as an MCP tool.
import type { ToolResult } from "../types.js";

/**
 * True only for values that are usable as a Hetzner resource id in a URL path.
 *
 * `Number.isSafeInteger` rejects strings, NaN, Infinity, floats and anything
 * above 9007199254740991 - which is exactly the `maximum` the generated
 * schemas declare, so this is no stricter than the published inputSchema.
 */
export function isResourceId(v: unknown): v is number {
  return Number.isSafeInteger(v) && (v as number) >= 1;
}

function preview(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 120 ? `${text.slice(0, 120)}...` : text;
}

/** Caller-facing rejection for a bad resource id. No HTTP request is made. */
export function invalidIdResult(key: string, value: unknown): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: `Invalid \`${key}\`: must be an integer >= 1, got ${preview(value)}.`,
      },
    ],
    isError: true,
  };
}

/**
 * Percent-encoded spellings of a path separator or of a dot segment. A caller can
 * only produce these by pre-encoding them: `encodeURIComponent` escapes "%" itself,
 * so no legitimate zone name or record label ever contains one.
 */
const ENCODED_SEPARATOR = /%2f|%5c|%2e/i;

/**
 * Why a caller-supplied value cannot be used as ONE path segment, or null when it
 * can. Applies to the string-typed path parameters (`id_or_name`, `rr_name`) as
 * well as to numeric ids, and complements - not replaces - `encodeURIComponent`
 * at the interpolation site.
 *
 * Encoding alone is not enough: `encodeURIComponent` turns a caller's raw "/" into
 * "%2F", and the actor that resolves the path is the *origin*, not `new URL`. The
 * Hetzner API decodes "%2f" and collapses a ".." dot segment before routing, so
 * `id_or_name: "../servers/42"` leaves this process as
 * `DELETE /v1/zones/..%2Fservers%2F42` - which the API resolves to
 * `DELETE /v1/servers/42`. A value that names a single segment therefore must not
 * carry a separator in any spelling, and must not *be* a dot segment or empty
 * (which would delete a segment instead of adding one).
 *
 * `hcloud_raw_request` is exempt by design: its `path` is arbitrary by contract.
 */
export function pathSegmentIssue(value: string): string | null {
  if (value === "") return "must not be empty";
  if (value === "." || value === "..") return 'must not be "." or ".."';
  if (value.includes("/") || value.includes("\\")) {
    return 'must not contain "/" or "\\"';
  }
  if (ENCODED_SEPARATOR.test(value)) {
    return "must not contain a percent-encoded separator (%2f, %5c, %2e)";
  }
  return null;
}

/** Caller-facing rejection for a path parameter. No HTTP request is made. */
export function invalidPathValueResult(
  key: string,
  value: unknown,
  issue: string,
): ToolResult {
  return {
    content: [
      {
        type: "text",
        text:
          `Invalid \`${key}\`: it names a single path segment and ${issue}, ` +
          `got ${preview(value)}.`,
      },
    ],
    isError: true,
  };
}
