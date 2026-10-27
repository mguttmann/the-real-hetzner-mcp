import { describe, it, expect, vi } from "vitest";
import { fetchAllPages } from "../src/http/pagination.js";

type FakeClient = { request: ReturnType<typeof vi.fn> };

function makeClient(pages: Array<Record<string, unknown>>): FakeClient {
  let i = 0;
  return {
    request: vi.fn(async () => {
      const body = pages[i++];
      return { status: 200, headers: new Headers(), body };
    }),
  };
}

describe("fetchAllPages", () => {
  it("merges items across pages until last_page reached", async () => {
    const client = makeClient([
      {
        servers: [{ id: 1 }, { id: 2 }],
        meta: { pagination: { page: 1, per_page: 2, next_page: 2, last_page: 2, total_entries: 4 } },
      },
      {
        servers: [{ id: 3 }, { id: 4 }],
        meta: { pagination: { page: 2, per_page: 2, next_page: null, last_page: 2, total_entries: 4 } },
      },
    ]);
    const result = await fetchAllPages<{ id: number }>(
      client.request as never,
      "GET",
      "/servers",
      {},
      { resourceKey: "servers", maxItems: 1000, maxPages: 50 },
    );
    expect(result.items).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
    expect(result.truncated).toBe(false);
    expect(client.request).toHaveBeenCalledTimes(2);
  });

  it("truncates when maxItems reached", async () => {
    const client = makeClient([
      {
        servers: [{ id: 1 }, { id: 2 }, { id: 3 }],
        meta: { pagination: { page: 1, per_page: 3, next_page: 2, last_page: 5 } },
      },
    ]);
    const result = await fetchAllPages<{ id: number }>(
      client.request as never,
      "GET",
      "/servers",
      {},
      { resourceKey: "servers", maxItems: 2, maxPages: 50 },
    );
    expect(result.items).toEqual([{ id: 1 }, { id: 2 }]);
    expect(result.truncated).toBe(true);
    expect(result.pagination).toEqual({ next_page: 2, last_page: 5 });
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  it("truncates when maxPages reached", async () => {
    const client = makeClient([
      {
        servers: [{ id: 1 }],
        meta: { pagination: { page: 1, per_page: 1, next_page: 2, last_page: 99 } },
      },
      {
        servers: [{ id: 2 }],
        meta: { pagination: { page: 2, per_page: 1, next_page: 3, last_page: 99 } },
      },
    ]);
    const result = await fetchAllPages<{ id: number }>(
      client.request as never,
      "GET",
      "/servers",
      {},
      { resourceKey: "servers", maxItems: 1000, maxPages: 2 },
    );
    expect(result.items).toEqual([{ id: 1 }, { id: 2 }]);
    expect(result.truncated).toBe(true);
    expect(client.request).toHaveBeenCalledTimes(2);
  });

  it("returns a single page when caller passes an explicit page", async () => {
    const client = makeClient([
      {
        servers: [{ id: 3 }, { id: 4 }],
        meta: { pagination: { page: 2, per_page: 2, next_page: 3, last_page: 5, total_entries: 10 } },
      },
    ]);
    const result = await fetchAllPages<{ id: number }>(
      client.request as never,
      "GET",
      "/servers",
      { page: 2 },
      { resourceKey: "servers", maxItems: 1000, maxPages: 50 },
    );
    expect(result.items).toEqual([{ id: 3 }, { id: 4 }]);
    expect(result.truncated).toBe(false);
    expect(result.pagination).toBeUndefined();
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(client.request).toHaveBeenCalledWith(
      "GET",
      "/servers",
      { query: { page: 2 } },
    );
  });

  it("respects caller-provided per_page", async () => {
    const client = makeClient([
      {
        servers: [],
        meta: { pagination: { page: 1, per_page: 5, next_page: null, last_page: 1 } },
      },
    ]);
    await fetchAllPages(
      client.request as never,
      "GET",
      "/servers",
      { per_page: 5, name_contains: "prod" },
      { resourceKey: "servers", maxItems: 1000, maxPages: 50 },
    );
    expect(client.request).toHaveBeenCalledWith(
      "GET",
      "/servers",
      { query: { per_page: 5, name_contains: "prod", page: 1 } },
    );
  });
});

describe("fetchAllPages total time budget", () => {
  const page = (n: number) => ({
    servers: [{ id: n }],
    meta: { pagination: { page: n, per_page: 1, next_page: n + 1, last_page: 10, total_entries: 10 } },
  });

  /** Each page takes `pageMs` of fake time; a request whose budget is shorter times out. */
  function slowClient(pageMs: number) {
    let t = 0;
    const budgets: number[] = [];
    const request = vi.fn(async (_m: string, _p: string, o?: { query?: { page?: number }; timeoutMs?: number }) => {
      const budget = o?.timeoutMs ?? Infinity;
      budgets.push(budget);
      if (budget < pageMs) {
        t += budget;
        throw new Error("request timeout");
      }
      t += pageMs;
      return { status: 200, headers: new Headers(), body: page(o?.query?.page ?? 1) };
    });
    return { request, now: () => t, budgets };
  }

  it("stops when the budget ends and reports truncated with a note, never a complete-looking list", async () => {
    const c = slowClient(20_000);
    const result = await fetchAllPages<{ id: number }>(c.request as never, "GET", "/servers", {}, {
      resourceKey: "servers", maxItems: 500, maxPages: 10, timeoutMs: 45_000, now: c.now,
    });
    expect(result.items).toEqual([{ id: 1 }, { id: 2 }]);
    expect(result.truncated).toBe(true);
    expect(result.pagination).toEqual({ next_page: 3, last_page: 10 });
    expect(result.note).toMatch(/PAGINATION_TIMEOUT_MS/);
    expect(c.now()).toBeLessThanOrEqual(45_000);
    expect(c.budgets).toEqual([45_000, 25_000, 5_000]);
  });

  it("stops before the next page when the budget is already spent", async () => {
    const c = slowClient(45_000);
    const result = await fetchAllPages<{ id: number }>(c.request as never, "GET", "/servers", {}, {
      resourceKey: "servers", maxItems: 500, maxPages: 10, timeoutMs: 45_000, now: c.now,
    });
    expect(result.items).toEqual([{ id: 1 }]);
    expect(result.truncated).toBe(true);
    expect(result.note).toMatch(/PAGINATION_TIMEOUT_MS/);
    expect(c.request).toHaveBeenCalledTimes(1);
  });

  it("throws when not even the first page arrives within the budget", async () => {
    const c = slowClient(60_000);
    await expect(fetchAllPages(c.request as never, "GET", "/servers", {}, {
      resourceKey: "servers", maxItems: 500, maxPages: 10, timeoutMs: 45_000, now: c.now,
    })).rejects.toThrow(/request timeout/);
  });

  it("has no note when the list completes inside the budget", async () => {
    const c = slowClient(1_000);
    const result = await fetchAllPages<{ id: number }>(c.request as never, "GET", "/servers", {}, {
      resourceKey: "servers", maxItems: 500, maxPages: 3, timeoutMs: 45_000, now: c.now,
    });
    expect(result.items).toHaveLength(3);
    expect(result.note).toBeUndefined();
  });
});
