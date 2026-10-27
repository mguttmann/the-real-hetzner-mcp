import type { HttpResponse } from "../http/client.js";
import { HetznerApiError, mapErrorResponse } from "../http/errors.js";
import type { ToolResult } from "../types.js";

/**
 * If the HTTP response is a Hetzner error (non-2xx with the standard
 * `{ error: { code, message, details } }` envelope, or any other non-2xx),
 * convert it into a `ToolResult` with `isError: true` carrying the typed
 * `HetznerApiError.toString()` payload.
 *
 * Returns `null` for successful responses, so call sites can simply do:
 *
 *   const errResult = asToolError(res);
 *   if (errResult) return errResult;
 *
 * Keep the helper inert when the response is 2xx/3xx - the happy-path code
 * stays untouched.
 */
export function asToolError<T>(res: HttpResponse<T>): ToolResult | null {
  const err = mapErrorResponse(res.status, res.body);
  if (!err) return null;
  return {
    content: [{ type: "text", text: err.toString() }],
    isError: true,
  };
}

/**
 * Text for a thrown error: a HetznerApiError keeps the same
 * `HetznerApiError[status code]: message` form asToolError produces, anything
 * else gives its message. A network failure from fetch is only "fetch failed";
 * the reason (ECONNREFUSED, a refused redirect) is in `cause`, so its code, or
 * a short cause message without a code, is added in parentheses.
 */
export function describeError(err: unknown): string {
  if (err instanceof HetznerApiError) return err.toString();
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause;
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return `${err.message} (${code})`;
    if (cause.message) return `${err.message} (${cause.message.slice(0, CAUSE_MAX_CHARS)})`;
  }
  return err.message;
}

const CAUSE_MAX_CHARS = 200;
