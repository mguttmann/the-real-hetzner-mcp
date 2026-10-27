export type HetznerErrorEnvelope = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

function isErrorEnvelope(body: unknown): body is HetznerErrorEnvelope {
  return (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof (body as { error: unknown }).error === "object" &&
    (body as { error: { code?: unknown; message?: unknown } }).error !== null &&
    typeof (body as { error: { code: unknown } }).error.code === "string" &&
    typeof (body as { error: { message: unknown } }).error.message === "string"
  );
}

export class HetznerApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "HetznerApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  override toString(): string {
    return `HetznerApiError[${this.status} ${this.code}]: ${this.message}`;
  }
}

export function mapErrorResponse(
  status: number,
  body: unknown,
): HetznerApiError | null {
  if (status >= 200 && status < 400) return null;
  if (isErrorEnvelope(body)) {
    return new HetznerApiError(
      status,
      body.error.code,
      body.error.message,
      body.error.details,
    );
  }
  const fallbackMessage =
    typeof body === "string" && body.length > 0
      ? upstreamText(body)
      : `HTTP ${status}`;
  return new HetznerApiError(status, "upstream_error", fallbackMessage);
}

/** Longest part of a non-JSON error body that goes into the error message. */
export const UPSTREAM_TEXT_MAX_CHARS = 4096;

/**
 * A non-JSON error body (an HTML page from a proxy, a plain-text 502) is not a
 * Hetzner error message: it is quoted and marked as upstream text so a reader
 * does not mistake it for this server's own words, and capped so a large page
 * does not flood the tool result and the log.
 */
function upstreamText(body: string): string {
  const cut = body.length - UPSTREAM_TEXT_MAX_CHARS;
  const shown = cut > 0 ? body.slice(0, UPSTREAM_TEXT_MAX_CHARS) : body;
  const suffix = cut > 0 ? ` [truncated, ${cut} more characters]` : "";
  return `upstream text (non-JSON body): ${JSON.stringify(shown)}${suffix}`;
}
