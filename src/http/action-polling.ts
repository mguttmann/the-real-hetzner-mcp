import type { HttpMethod, HttpResponse } from "./client.js";

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
  timeoutMs: number;
  intervalMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type PollResult = {
  action: Action;
  timedOut: boolean;
};

type RequestFn = <T = unknown>(
  method: HttpMethod,
  path: string,
  options?: { query?: Record<string, unknown> },
) => Promise<HttpResponse<T>>;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function pollAction(
  request: RequestFn,
  actionId: number,
  opts: PollOptions,
): Promise<PollResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const start = now();
  let lastAction: Action | undefined;

  while (true) {
    const res = await request<{ action: Action }>("GET", `/actions/${actionId}`);
    const action = res.body?.action;
    if (action) {
      lastAction = action;
      if (action.status === "success" || action.status === "error") {
        return { action, timedOut: false };
      }
    }
    if (now() - start >= opts.timeoutMs) {
      return {
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
      };
    }
    await sleep(opts.intervalMs);
  }
}
