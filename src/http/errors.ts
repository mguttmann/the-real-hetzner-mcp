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
      ? body
      : `HTTP ${status}`;
  return new HetznerApiError(status, "upstream_error", fallbackMessage);
}
