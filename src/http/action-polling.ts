import { sleepUnlessAborted, type HttpMethod, type HttpResponse } from "./client.js";
import { mapErrorResponse } from "./errors.js";

export type Action = {
  id: number;
  command: string;
  status: "running" | "success" | "error";
  progress: number;
  started: string;
  finished: string | null;
  resources: Array<{ id: number; type: string }>;
  error: { code: string; message: string } | null;
};

export type PollOptions = {
  /**
   * Wall-clock budget: poll requests, their retry delays and the sleeps in
   * between all count. Measured from startedAt when given (a write tool passes
   * the start of the call, so the write request counts too).
   */
  timeoutMs: number;
  intervalMs: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  startedAt?: number;
  /** The caller's cancellation signal: stops the poll request and the pause. */
  signal?: AbortSignal;
  /** Where a write tool reports a poll failure (see pollAfterWrite). */
  logger?: { warn: (obj: object, msg: string) => void };
};

export type PollResult = {
  action: Action;
  timedOut: boolean;
};

type RequestFn = <T = unknown>(
  method: HttpMethod,
  path: string,
  options?: { query?: Record<string, unknown>; timeoutMs?: number; signal?: AbortSignal },
) => Promise<HttpResponse<T>>;

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
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

export async function pollAction(
  request: RequestFn,
  actionId: number,
  opts: PollOptions,
  initial?: Action,
): Promise<PollResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const deadline = (opts.startedAt ?? now()) + opts.timeoutMs;
  let lastAction: Action | undefined = initial;
  const timedOut = (): PollResult => ({
    action: lastAction ?? ({
      id: actionId,
      command: "unknown",
      status: "running",
      progress: 0,
      started: "",
      finished: null,
      resources: [],
      error: null,
    } satisfies Action),
    timedOut: true,
  });

  while (true) {
    opts.signal?.throwIfAborted();
    const remaining = deadline - now();
    if (remaining <= 0) return timedOut();
    const res = await request<{ action: Action }>(
      "GET",
      `/actions/${encodeURIComponent(String(actionId))}`,
      { timeoutMs: remaining, ...(opts.signal ? { signal: opts.signal } : {}) },
    );
    // A failed poll (wrong id, auth, outage) ends polling with the mapped error
    // instead of looking like a still-running action until the timeout.
    const err = mapErrorResponse(res.status, res.body);
    if (err) throw err;
    const action = res.body?.action;
    if (action) {
      lastAction = action;
      if (action.status === "success" || action.status === "error") {
        return { action, timedOut: false };
      }
    }
    const left = deadline - now();
    if (left <= 0) return timedOut();
    await sleepUnlessAborted(sleep, Math.min(opts.intervalMs, left), opts.signal);
  }
}
