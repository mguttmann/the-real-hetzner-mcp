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
      client.request,
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
      client.request,
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
      client.request,
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
      client.request,
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
      client.request,
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
