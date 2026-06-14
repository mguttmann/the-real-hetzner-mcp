import type { HttpResponse } from "../http/client.js";
import { mapErrorResponse } from "../http/errors.js";
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
 * Keep the helper inert when the response is 2xx/3xx — the happy-path code
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
