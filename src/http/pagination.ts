import type { HttpMethod, HttpResponse } from "./client.js";

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
};

export type FetchAllResult<T> = {
  items: T[];
  truncated: boolean;
  pagination?: { next_page: number | null; last_page: number };
};

type RequestFn = <T = unknown>(
  method: HttpMethod,
  path: string,
  options?: { query?: Record<string, unknown> },
) => Promise<HttpResponse<T>>;

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

  while (true) {
    const res = await request<PageResponse<T>>(method, path, {
      query: { ...query, page },
    });
    pageCount++;
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
    // Caller asked for a specific page — return that page only, no forward-walk.
    if (explicitPage) break;
    if (pageCount >= opts.maxPages) {
      const hasMore = pagination?.next_page != null;
      if (hasMore) truncated = true;
      break;
    }
    if (!pagination || pagination.next_page == null) break;
    page = pagination.next_page;
  }

  if (truncated && lastPagination) {
    return {
      items,
      truncated,
      pagination: {
        next_page: lastPagination.next_page,
        last_page: lastPagination.last_page,
      },
    };
  }
  return { items, truncated };
}
