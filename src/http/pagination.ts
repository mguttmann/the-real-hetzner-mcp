import type { HttpMethod, HttpResponse } from "./client.js";
import { mapErrorResponse } from "./errors.js";

export type PaginationMeta = {
  page: number;
  per_page: number;
  previous_page: number | null;
  next_page: number | null;
  last_page: number;
  total_entries: number;
};

export type PageResponse<T> = {
  meta: { pagination: PaginationMeta };
} & Record<string, T[] | unknown>;

export type FetchAllOptions = {
  resourceKey: string;
  maxItems: number;
  maxPages: number;
  /**
   * Wall-clock budget for the whole list (PAGINATION_TIMEOUT_MS). Each page
   * request gets the remaining budget (the client cuts it further to
   * HTTP_TIMEOUT_MS). No budget when omitted.
   */
  timeoutMs?: number;
  now?: () => number;
  /** The caller's cancellation signal, passed to every page request. */
  signal?: AbortSignal;
};

export type FetchAllResult<T> = {
  items: T[];
  truncated: boolean;
  pagination?: { next_page: number | null; last_page: number };
  /** Set when the time budget ended the list; says why it is incomplete. */
  note?: string;
};

type RequestFn = <T = unknown>(
  method: HttpMethod,
  path: string,
  options?: { query?: Record<string, unknown>; timeoutMs?: number; signal?: AbortSignal },
) => Promise<HttpResponse<T>>;

function budgetNote(pages: number, timeoutMs: number): string {
  return (
    `Stopped after ${pages} page(s): the list took longer than PAGINATION_TIMEOUT_MS ` +
    `(${timeoutMs} ms). More items exist; narrow the request (for example label_selector) ` +
    `or read the rest with page and per_page.`
  );
}

export async function fetchAllPages<T>(
  request: RequestFn,
  method: HttpMethod,
  path: string,
  query: Record<string, unknown>,
  opts: FetchAllOptions,
): Promise<FetchAllResult<T>> {
  const explicitPage = typeof query.page === "number";
  const items: T[] = [];
  let page = explicitPage ? (query.page as number) : 1;
  let pageCount = 0;
  let truncated = false;
  let lastPagination: PaginationMeta | undefined;
  let note: string | undefined;
  const now = opts.now ?? Date.now;
  const deadline = opts.timeoutMs === undefined ? Infinity : now() + opts.timeoutMs;
  // The budget ended after at least one page: return what arrived, marked as
  // truncated with the reason, never as a list that looks complete. Without any
  // page the request error is thrown as before.
  const outOfTime = (): void => {
    truncated = true;
    note = budgetNote(pageCount, opts.timeoutMs!);
  };

  while (true) {
    const remaining = deadline - now();
    if (pageCount > 0 && remaining <= 0) {
      outOfTime();
      break;
    }
    let res: HttpResponse<PageResponse<T>>;
    try {
      res = await request<PageResponse<T>>(method, path, {
        query: { ...query, page },
        ...(Number.isFinite(remaining) ? { timeoutMs: Math.max(1, remaining) } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch (err) {
      if (pageCount > 0 && now() >= deadline && !opts.signal?.aborted) {
        outOfTime();
        break;
      }
      throw err;
    }
    pageCount++;
    // A failed page must never turn into an empty or partial list that looks
    // complete. Throw the mapped error; the server turns it into isError.
    const err = mapErrorResponse(res.status, res.body);
    if (err) throw err;
    const body = res.body ?? ({} as PageResponse<T>);
    const pageItems = (body[opts.resourceKey] as T[] | undefined) ?? [];
    const pagination = body.meta?.pagination;
    lastPagination = pagination ?? lastPagination;

    for (const item of pageItems) {
      if (items.length >= opts.maxItems) {
        truncated = true;
        break;
      }
      items.push(item);
    }

    if (truncated) break;
    // Caller asked for a specific page - return that page only, no forward-walk.
    if (explicitPage) break;
    if (pageCount >= opts.maxPages) {
      const hasMore = pagination?.next_page != null;
      if (hasMore) truncated = true;
      break;
    }
    if (!pagination || pagination.next_page == null) break;
    page = pagination.next_page;
  }

  const withNote = note === undefined ? {} : { note };
  if (truncated && lastPagination) {
    return {
      items,
      truncated,
      pagination: {
        next_page: lastPagination.next_page,
        last_page: lastPagination.last_page,
      },
      ...withNote,
    };
  }
  return { items, truncated, ...withNote };
}
