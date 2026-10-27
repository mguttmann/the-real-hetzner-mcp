import type { ToolContent, ToolResult } from "../types.js";

/**
 * Default and ceiling of MAX_OUTPUT_BYTES. A tool result goes out as one stdio
 * line, and the MCP SDK's stdio reader drops a line longer than 10 MiB; 8 MiB
 * of text plus the JSON-RPC envelope stays below that.
 */
export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Size of a text as it goes on the wire: UTF-8 bytes of its JSON string form. */
function wireBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text));
}

function marker(maxBytes: number, shown: number, total: number): string {
  return `\n\n[output truncated by MAX_OUTPUT_BYTES=${maxBytes}: ${shown} of ${total} bytes shown]`;
}

/** Longest prefix of `text` whose wire size is at most `budget`, never splitting a surrogate pair. */
function prefixWithin(text: string, budget: number): string {
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (wireBytes(text.slice(0, mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  const code = text.charCodeAt(lo - 1);
  if (lo > 0 && code >= 0xd800 && code <= 0xdbff) lo--;
  return text.slice(0, lo);
}

/**
 * Bounds the text of a tool result to `maxBytes`, counted as it is sent
 * (JSON-escaped). A result within the bound is returned as the same object;
 * a longer one is cut and ends with a marker that names the limit, so the
 * caller never mistakes it for a complete answer. A cut JSON text is no longer
 * valid JSON, which is intended: the marker is the signal.
 */
export function capToolResult(
  result: ToolResult,
  maxBytes: number,
): { result: ToolResult; truncated: boolean; totalBytes: number } {
  const sizes = result.content.map((c) => (c.type === "text" ? wireBytes(c.text) : 0));
  const totalBytes = sizes.reduce((a, b) => a + b, 0);
  if (totalBytes <= maxBytes) return { result, truncated: false, totalBytes };

  let remaining = maxBytes;
  let shown = 0;
  const content: ToolContent[] = [];
  for (const [i, c] of result.content.entries()) {
    if (c.type !== "text") {
      content.push(c);
      continue;
    }
    if (sizes[i]! <= remaining) {
      content.push(c);
      remaining -= sizes[i]!;
      shown += sizes[i]!;
      continue;
    }
    // Reserve room for the marker; its numbers are at most as long as maxBytes.
    const reserve = wireBytes(marker(maxBytes, maxBytes, totalBytes)) - 2;
    const prefix = prefixWithin(c.text, Math.max(2, remaining - reserve));
    shown += wireBytes(prefix);
    content.push({ type: "text", text: prefix + marker(maxBytes, shown, totalBytes) });
    break;
  }
  return { result: { ...result, content }, truncated: true, totalBytes };
}
