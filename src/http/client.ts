export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type RequestOptions = {
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  timeoutMs?: number;
  maxRetries?: number;
};

export type HttpResponse<T = unknown> = {
  status: number;
  headers: Headers;
  body: T | undefined;
};

export type SleepFn = (ms: number) => Promise<void>;

export type ClientOptions = {
  baseUrl: string;
  token: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  sleep?: SleepFn;
  maxRetries?: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;

const defaultSleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

export class HetznerHttpClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly defaultTimeoutMs: number;
  private readonly sleep: SleepFn;
  private readonly defaultMaxRetries: number;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.defaultTimeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sleep = opts.sleep ?? defaultSleep;
    this.defaultMaxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  async request<T = unknown>(
    method: HttpMethod,
    path: string,
    options: RequestOptions = {},
  ): Promise<HttpResponse<T>> {
    const maxRetries = options.maxRetries ?? this.defaultMaxRetries;
    let attempt = 0;
    while (true) {
      const res = await this.doFetch<T>(method, path, options);
      const retryDelayMs = this.computeRetryDelay(res.status, res.headers, attempt);
      if (retryDelayMs === null || attempt >= maxRetries) {
        return res;
      }
      await this.sleep(retryDelayMs);
      attempt++;
    }
  }

  private async doFetch<T>(
    method: HttpMethod,
    path: string,
    options: RequestOptions,
  ): Promise<HttpResponse<T>> {
    const url = this.buildUrl(path, options.query);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("request timeout")),
      options.timeoutMs ?? this.defaultTimeoutMs,
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
        signal: controller.signal,
      });
      const body = await this.parseBody<T>(res);
      return { status: res.status, headers: res.headers, body };
    } finally {
      clearTimeout(timeout);
    }
  }

  private computeRetryDelay(
    status: number,
    headers: Headers,
    attempt: number,
  ): number | null {
    if (status === 429) {
      const retryAfter = headers.get("retry-after");
      const reset = headers.get("ratelimit-reset");
      const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : 0;
      const resetMs = reset
        ? Math.max(0, Number(reset) * 1000 - Date.now())
        : 0;
      return Math.max(retryAfterMs, resetMs, 0);
    }
    if (status >= 500 && status < 600) {
      return 1000 * 2 ** attempt;
    }
    return null;
  }

  private buildUrl(path: string, query: RequestOptions["query"]): string {
    const url = new URL(this.baseUrl + (path.startsWith("/") ? path : `/${path}`));
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
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
