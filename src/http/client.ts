export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type QueryValue = string | number | boolean;

export type RequestOptions = {
  query?: Record<string, QueryValue | QueryValue[] | undefined | null>;
  body?: unknown;
  /**
   * Wall-clock budget for the whole request: every attempt and every retry
   * delay together. Defaults to the client's timeoutMs (HTTP_TIMEOUT_MS) and is
   * never longer than it: a caller passes its remaining call budget here (an
   * action poll, a paginated list), and one hanging request must still be cut
   * at HTTP_TIMEOUT_MS.
   */
  timeoutMs?: number;
  maxRetries?: number;
  /**
   * The caller's cancellation signal. Aborts the attempt in flight and the
   * retry delay; once aborted, no further attempt is sent.
   */
  signal?: AbortSignal;
};

export type HttpResponse<T = unknown> = {
  status: number;
  headers: Headers;
  body: T | undefined;
};

export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

export type ClientOptions = {
  baseUrl: string;
  token: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  sleep?: SleepFn;
  maxRetries?: number;
  /** Longest single retry delay; a 429 that asks for more is returned at once. */
  maxRetryDelayMs?: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_RETRY_DELAY_MS = 10_000;

const defaultSleep: SleepFn = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * Sleeps unless the signal aborts first; rejects with the abort reason then.
 * Works for an injected sleep that ignores the signal, too.
 */
export function sleepUnlessAborted(sleep: SleepFn, ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    sleep(ms, signal).then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/** RFC 3986 `pchar` plus "/" - every other byte has to arrive percent-encoded. */
const SAFE_PATH_CHARS = /^[A-Za-z0-9\-._~%!$&'()*+,;=:@/]*$/;

/**
 * True for a segment the WHATWG URL parser treats as a dot segment and removes
 * during normalisation. It decodes `%2e` (case-insensitively) *before* deciding,
 * so `%2e`, `.%2E` and `%2e%2e` are dot segments just like `.` and `..`.
 */
function isDotSegment(segment: string): boolean {
  const decoded = segment.replace(/%2e/gi, ".");
  return decoded === "." || decoded === "..";
}

function withLeadingSlash(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

/**
 * Last line of defence against path injection: a caller-supplied value must not
 * be able to reshape the request target - neither by *adding* a segment nor by
 * *removing* one.
 *
 * Rejected outright:
 * - `?`/`#`, which truncate the rest of the path into query/fragment;
 * - `\`, which `new URL` turns into a path separator;
 * - anything outside RFC 3986 `pchar`, because `new URL` would rewrite it
 *   (percent-encoding spaces/non-ASCII, silently *deleting* tab/LF/CR - which is
 *   how `.<TAB>.` becomes a `..` segment);
 * - empty segments, which collapse `/zones/{id}/actions` into `/zones//actions`
 *   and let the origin normalise the target away;
 * - dot segments in every spelling `new URL` recognises, `%2e` included.
 *
 * `buildUrl` then verifies the assembled URL against the intended path exactly,
 * so this stays a set of *early, precise* diagnostics rather than the whole
 * guarantee.
 */
function assertSafePath(path: string): void {
  const shown = JSON.stringify(path);
  if (path.includes("?")) {
    throw new Error(
      `Invalid request path ${shown}: query strings must be passed via the \`query\` field, not inside \`path\`.`,
    );
  }
  if (path.includes("#")) {
    throw new Error(`Invalid request path ${shown}: "#" is not allowed.`);
  }
  if (path.includes("\\")) {
    throw new Error(`Invalid request path ${shown}: "\\" is not allowed.`);
  }
  if (!SAFE_PATH_CHARS.test(path)) {
    throw new Error(
      `Invalid request path ${shown}: contains characters that must be percent-encoded.`,
    );
  }
  for (const segment of withLeadingSlash(path).split("/").slice(1)) {
    if (segment === "") {
      throw new Error(`Invalid request path ${shown}: empty path segments are not allowed.`);
    }
    if (isDotSegment(segment)) {
      throw new Error(
        `Invalid request path ${shown}: "." and ".." segments are not allowed.`,
      );
    }
  }
}

export class HetznerHttpClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly defaultTimeoutMs: number;
  private readonly sleep: SleepFn;
  private readonly defaultMaxRetries: number;
  private readonly maxRetryDelayMs: number;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.defaultTimeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sleep = opts.sleep ?? defaultSleep;
    this.defaultMaxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.maxRetryDelayMs = opts.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  }

  async request<T = unknown>(
    method: HttpMethod,
    path: string,
    options: RequestOptions = {},
  ): Promise<HttpResponse<T>> {
    const maxRetries = options.maxRetries ?? this.defaultMaxRetries;
    const budgetMs = Math.min(options.timeoutMs ?? this.defaultTimeoutMs, this.defaultTimeoutMs);
    const deadline = Date.now() + budgetMs;
    let attempt = 0;
    while (true) {
      options.signal?.throwIfAborted();
      const res = await this.doFetch<T>(method, path, options, Math.max(1, deadline - Date.now()));
      const retryDelayMs = this.computeRetryDelay(method, res.status, res.headers, attempt);
      // Give the response back instead of waiting when no retry applies, the
      // wait is longer than the cap (an hour-long 429 must not hold the call
      // and then fire a late write nobody sees) or it would overrun the budget.
      if (
        retryDelayMs === null ||
        attempt >= maxRetries ||
        retryDelayMs > this.maxRetryDelayMs ||
        Date.now() + retryDelayMs >= deadline
      ) {
        return res;
      }
      await sleepUnlessAborted(this.sleep, retryDelayMs, options.signal);
      attempt++;
    }
  }

  private async doFetch<T>(
    method: HttpMethod,
    path: string,
    options: RequestOptions,
    attemptTimeoutMs: number,
  ): Promise<HttpResponse<T>> {
    const url = this.buildUrl(path, options.query);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("request timeout")),
      attemptTimeoutMs,
    );
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal
          ? AbortSignal.any([controller.signal, options.signal])
          : controller.signal,
        // Redirects are NEVER followed. buildUrl asserts that the outgoing target
        // is exactly baseUrl + the requested path; without this the origin could
        // undo that one hop later, and the Authorization header above would go
        // with it. Reproduced before the fix: a 301 on `POST /v1/servers/42`
        // pointing at `/v1/ssh_keys` was followed as a GET with the bearer
        // attached - a target the caller never named. It also matters as the
        // amplifier for path confusion: a router that decodes `%2F` typically
        // answers an unclean path with a 301 to the cleaned one.
        // The Hetzner Cloud API does not redirect on any legitimate call.
        redirect: "error",
      });
      const body = await this.parseBody<T>(res);
      return { status: res.status, headers: res.headers, body };
    } finally {
      clearTimeout(timeout);
    }
  }

  private computeRetryDelay(
    method: HttpMethod,
    status: number,
    headers: Headers,
    attempt: number,
  ): number | null {
    if (status === 429) {
      // Prefer Retry-After. RateLimit-Reset is NOT a retry hint: Hetzner defines
      // it as the time the bucket is full again (up to an hour away), while one
      // request refills every second, so a short backoff is enough.
      const retryAfter = Number(headers.get("retry-after") ?? Number.NaN);
      if (Number.isFinite(retryAfter) && retryAfter >= 0) return retryAfter * 1000;
      return 1000 * 2 ** attempt;
    }
    if (status >= 500 && status < 600) {
      // A POST may already have been processed (a create is billed), so it is
      // not resent on 5xx. A 429 is safe to resend: the request was refused.
      if (method === "POST") return null;
      return 1000 * 2 ** attempt;
    }
    return null;
  }

  private buildUrl(path: string, query: RequestOptions["query"]): string {
    assertSafePath(path);
    const requestPath = withLeadingSlash(path);
    const url = new URL(this.baseUrl + requestPath);
    const base = new URL(this.baseUrl);
    const basePath = base.pathname === "/" ? "" : base.pathname;
    if (url.origin !== base.origin) {
      throw new Error(
        `Invalid request path ${JSON.stringify(path)}: escapes the configured API base URL.`,
      );
    }
    // Structural check instead of substring matching: whatever the URL parser
    // made of the input has to be *exactly* the base path plus the requested
    // path. Any normalisation - a removed dot segment, a stripped control
    // character, an added percent-escape - means the request would go somewhere
    // other than where the caller's path says, so it never goes out at all.
    if (url.pathname !== basePath + requestPath) {
      throw new Error(
        `Invalid request path ${JSON.stringify(path)}: URL normalisation would send it to ` +
          `${JSON.stringify(url.pathname)} instead.`,
      );
    }
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        // Array-valued parameters are style=form/explode=true in the Hetzner
        // spec ("May be used multiple times"), i.e. one parameter per element -
        // not one comma-joined value.
        if (Array.isArray(v)) {
          for (const item of v) {
            if (item === undefined || item === null) continue;
            url.searchParams.append(k, String(item));
          }
          continue;
        }
        url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  private async parseBody<T>(res: Response): Promise<T | undefined> {
    if (res.status === 204) return undefined;
    const text = await res.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }
}
