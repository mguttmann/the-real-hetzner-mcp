import { describe, it, expect, vi } from "vitest";
import { HetznerHttpClient } from "../src/http/client.js";

function fakeFetch(handler: (input: Request) => Promise<Response>) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const req = new Request(url instanceof Request ? url : url.toString(), init);
    return handler(req);
  });
}

describe("HetznerHttpClient (basics)", () => {
  it("sends Authorization: Bearer <token>", async () => {
    const fetchImpl = fakeFetch(async (req) => {
      expect(req.headers.get("authorization")).toBe("Bearer secret");
      expect(req.headers.get("content-type")).toBe("application/json");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const client = new HetznerHttpClient({
      baseUrl: "https://api.hetzner.cloud/v1",
      token: "secret",
      fetch: fetchImpl,
    });

    const res = await client.request("GET", "/servers");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("composes base URL + path correctly", async () => {
    const fetchImpl = fakeFetch(async (req) => {
      expect(req.url).toBe("https://api.hetzner.cloud/v1/servers/42");
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    const client = new HetznerHttpClient({
      baseUrl: "https://api.hetzner.cloud/v1",
      token: "t",
      fetch: fetchImpl,
    });
    await client.request("GET", "/servers/42");
  });

  it("encodes query parameters", async () => {
    const fetchImpl = fakeFetch(async (req) => {
      const u = new URL(req.url);
      expect(u.searchParams.get("page")).toBe("2");
      expect(u.searchParams.get("per_page")).toBe("50");
      expect(u.searchParams.get("label_selector")).toBe("env=prod");
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    const client = new HetznerHttpClient({
      baseUrl: "https://api.hetzner.cloud/v1",
      token: "t",
      fetch: fetchImpl,
    });
    await client.request("GET", "/servers", {
      query: { page: 2, per_page: 50, label_selector: "env=prod" },
    });
  });

  it("serialises body as JSON on POST", async () => {
    const fetchImpl = fakeFetch(async (req) => {
      expect(req.method).toBe("POST");
      expect(await req.json()).toEqual({ name: "test", server_type: "cpx11" });
      return new Response("{}", { status: 201, headers: { "content-type": "application/json" } });
    });
    const client = new HetznerHttpClient({
      baseUrl: "https://api.hetzner.cloud/v1",
      token: "t",
      fetch: fetchImpl,
    });
    await client.request("POST", "/servers", {
      body: { name: "test", server_type: "cpx11" },
    });
  });

  it("returns undefined body on 204", async () => {
    const fetchImpl = fakeFetch(async () => new Response(null, { status: 204 }));
    const client = new HetznerHttpClient({
      baseUrl: "https://api.hetzner.cloud/v1",
      token: "t",
      fetch: fetchImpl,
    });
    const res = await client.request("DELETE", "/servers/42");
    expect(res.status).toBe(204);
    expect(res.body).toBeUndefined();
  });

  it("aborts when timeoutMs elapses", async () => {
    const fetchImpl = vi.fn(async (_u: any, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    const client = new HetznerHttpClient({
      baseUrl: "https://api.hetzner.cloud/v1",
      token: "t",
      fetch: fetchImpl,
      timeoutMs: 50,
    });
    await expect(client.request("GET", "/slow")).rejects.toThrow(/aborted|timeout/i);
  });
});

describe("HetznerHttpClient (retries)", () => {
  function makeSequencedFetch(responses: Response[]) {
    const queue = [...responses];
    return vi.fn(async () => {
      const next = queue.shift();
      if (!next) throw new Error("fetch sequence exhausted");
      return next;
    });
  }

  it("retries on 429 honouring Retry-After (seconds)", async () => {
    const fetchImpl = makeSequencedFetch([
      new Response("{}", {
        status: 429,
        headers: { "retry-after": "1", "content-type": "application/json" },
      }),
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ]);
    const sleeps: number[] = [];
    const client = new HetznerHttpClient({
      baseUrl: "https://api.hetzner.cloud/v1",
      token: "t",
      fetch: fetchImpl,
      sleep: async (ms) => { sleeps.push(ms); },
    });

    const res = await client.request("GET", "/servers");
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([1000]);
  });

  it("retries on 429 honouring RateLimit-Reset (unix seconds)", async () => {
    const future = Math.ceil(Date.now() / 1000) + 2; // ~2 s in the future
    const fetchImpl = makeSequencedFetch([
      new Response("{}", {
        status: 429,
        headers: { "ratelimit-reset": String(future), "content-type": "application/json" },
      }),
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    ]);
    const sleeps: number[] = [];
    const client = new HetznerHttpClient({
      baseUrl: "https://api.hetzner.cloud/v1",
      token: "t",
      fetch: fetchImpl,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    await client.request("GET", "/servers");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(1000);
    expect(sleeps[0]).toBeLessThanOrEqual(3000);
  });

  it("gives up after 3 consecutive 429s", async () => {
    const fetchImpl = makeSequencedFetch([
      new Response("{}", { status: 429, headers: { "retry-after": "0" } }),
      new Response("{}", { status: 429, headers: { "retry-after": "0" } }),
      new Response("{}", { status: 429, headers: { "retry-after": "0" } }),
      new Response("{}", { status: 429, headers: { "retry-after": "0" } }),
    ]);
    const client = new HetznerHttpClient({
      baseUrl: "https://api.hetzner.cloud/v1",
      token: "t",
      fetch: fetchImpl,
      sleep: async () => {},
    });
    const res = await client.request("GET", "/servers");
    expect(res.status).toBe(429);
    expect(fetchImpl).toHaveBeenCalledTimes(4); // initial + 3 retries
  });

  it("retries on 5xx with exponential backoff", async () => {
    const fetchImpl = makeSequencedFetch([
      new Response("oops", { status: 500 }),
      new Response("oops", { status: 503 }),
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    ]);
    const sleeps: number[] = [];
    const client = new HetznerHttpClient({
      baseUrl: "https://api.hetzner.cloud/v1",
      token: "t",
      fetch: fetchImpl,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    const res = await client.request("GET", "/servers");
    expect(res.status).toBe(200);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("does NOT retry on 400/401/403/404", async () => {
    for (const status of [400, 401, 403, 404]) {
      const fetchImpl = makeSequencedFetch([
        new Response("{}", { status }),
      ]);
      const client = new HetznerHttpClient({
        baseUrl: "https://api.hetzner.cloud/v1",
        token: "t",
        fetch: fetchImpl,
        sleep: async () => {},
      });
      const res = await client.request("GET", "/x");
      expect(res.status).toBe(status);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });
});
