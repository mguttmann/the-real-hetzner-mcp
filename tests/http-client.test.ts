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

  it("repeats an array-valued query parameter instead of comma-joining it", async () => {
    // The Hetzner spec declares `sort`/`status` as arrays without style/explode,
    // i.e. the OpenAPI default form/explode=true, and the docs say "May be used
    // multiple times" - ?sort=id:asc&sort=name, never ?sort=id:asc,name.
    let seen = "";
    const fetchImpl = fakeFetch(async (req) => {
      seen = new URL(req.url).search;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    const client = new HetznerHttpClient({
      baseUrl: "https://api.hetzner.cloud/v1",
      token: "t",
      fetch: fetchImpl,
    });
    await client.request("GET", "/servers", {
      query: { sort: ["id:asc", "name"], status: ["running"], page: 1 },
    });
    const params = new URLSearchParams(seen);
    expect(params.getAll("sort")).toEqual(["id:asc", "name"]);
    expect(params.getAll("status")).toEqual(["running"]);
    expect(params.get("page")).toBe("1");
    expect(seen).not.toContain("%2C"); // no comma-joined value anywhere
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

  it("never lets a per-request timeoutMs exceed the client timeout (HTTP_TIMEOUT_MS)", async () => {
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
    const started = Date.now();
    await expect(client.request("GET", "/slow", { timeoutMs: 60_000 })).rejects.toThrow(/aborted|timeout/i);
    expect(Date.now() - started).toBeLessThan(2_000);
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

  it("429 without Retry-After: short backoff, RateLimit-Reset (full bucket recovery) is ignored", async () => {
    // Hetzner defines RateLimit-Reset as the time the bucket is FULL again (up to
    // an hour away), while one request refills every second.
    const inAnHour = Math.ceil(Date.now() / 1000) + 3600;
    const fetchImpl = makeSequencedFetch([
      new Response("{}", {
        status: 429,
        headers: { "ratelimit-reset": String(inAnHour), "ratelimit-remaining": "0" },
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
    const res = await client.request("POST", "/servers", { body: {} });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([1000]);
  });

  it("429 whose Retry-After exceeds the cap is returned at once, not slept on", async () => {
    const fetchImpl = makeSequencedFetch([
      new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "slow down" } }), {
        status: 429,
        headers: { "retry-after": "3600", "content-type": "application/json" },
      }),
    ]);
    const sleeps: number[] = [];
    const client = new HetznerHttpClient({
      baseUrl: "https://api.hetzner.cloud/v1",
      token: "t",
      fetch: fetchImpl,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    const res = await client.request("POST", "/servers", { body: {} });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: { code: "rate_limit_exceeded", message: "slow down" } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it("maxRetryDelayMs sets the cap (default 10000)", async () => {
    const make = () => makeSequencedFetch([
      new Response("{}", { status: 429, headers: { "retry-after": "5" } }),
      new Response("{}", { status: 200 }),
    ]);
    const capped = make();
    const low = new HetznerHttpClient({
      baseUrl: "https://api.hetzner.cloud/v1", token: "t", fetch: capped,
      sleep: async () => {}, maxRetryDelayMs: 2_000,
    });
    expect((await low.request("GET", "/servers")).status).toBe(429);
    expect(capped).toHaveBeenCalledTimes(1);

    const sleeps: number[] = [];
    const uncapped = make();
    const dflt = new HetznerHttpClient({
      baseUrl: "https://api.hetzner.cloud/v1", token: "t", fetch: uncapped,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect((await dflt.request("GET", "/servers")).status).toBe(200);
    expect(sleeps).toEqual([5000]);
  });

  it("never sleeps past the request budget (timeoutMs covers attempts and retry delays)", async () => {
    const fetchImpl = makeSequencedFetch([
      new Response("oops", { status: 503 }),
      new Response("oops", { status: 503 }),
      new Response("{}", { status: 200 }),
    ]);
    const sleeps: number[] = [];
    const client = new HetznerHttpClient({
      baseUrl: "https://api.hetzner.cloud/v1",
      token: "t",
      fetch: fetchImpl,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    const res = await client.request("GET", "/servers", { timeoutMs: 1_500 });
    expect(res.status).toBe(503);
    expect(sleeps).toEqual([1000]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not resend a POST on 5xx (it may already have been processed)", async () => {
    const fetchImpl = makeSequencedFetch([
      new Response("bad gateway", { status: 502 }),
      new Response("{}", { status: 201 }),
    ]);
    const client = new HetznerHttpClient({
      baseUrl: "https://api.hetzner.cloud/v1",
      token: "t",
      fetch: fetchImpl,
      sleep: async () => {},
    });
    const res = await client.request("POST", "/servers", { body: {} });
    expect(res.status).toBe(502);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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

describe("HetznerHttpClient (path hardening, issue #54 layer c)", () => {
  function client(fetchImpl: ReturnType<typeof vi.fn>, baseUrl = "https://api.hetzner.cloud/v1") {
    return new HetznerHttpClient({ baseUrl, token: "t", fetch: fetchImpl as never, sleep: async () => {} });
  }

  const rejected: Array<[string, string, RegExp]> = [
    ["query string", "/servers/42?x=1", /`query` field/],
    ["fragment", "/servers/42#frag", /"#" is not allowed/],
    ["backslash", "/servers\\evil.com/x", /"\\" is not allowed/],
    ["dot-dot segment", "/servers/1/../../ssh_keys", /"\." and "\.\." segments are not allowed/],
    ["leading dot-dot", "/../ssh_keys", /"\." and "\.\." segments are not allowed/],
    // Segment REMOVAL, not addition: `new URL` drops a "." segment, so a single
    // dot in a path parameter shifts the request one level up the tree -
    // /zones/{id_or_name}/actions would become /zones/actions.
    ["single-dot segment", "/zones/./actions", /"\." and "\.\." segments are not allowed/],
    ["trailing single dot", "/zones/.", /"\." and "\.\." segments are not allowed/],
    // Percent-encoded dot segments: the URL parser decodes %2e before it
    // normalises, so these are dot segments too.
    ["encoded dot", "/zones/%2e/actions", /"\." and "\.\." segments are not allowed/],
    ["encoded dot-dot", "/%2e%2e/ssh_keys", /"\." and "\.\." segments are not allowed/],
    ["upper-case encoded dot-dot", "/%2E%2E/ssh_keys", /"\." and "\.\." segments are not allowed/],
    ["half-encoded dot-dot", "/servers/1/.%2e/.%2E/ssh_keys", /"\." and "\.\." segments are not allowed/],
    // Empty segments: /zones/ and /zones//actions address something other than
    // the intended resource and invite an origin-side redirect.
    ["empty segment", "/zones//actions", /empty path segments are not allowed/],
    ["trailing empty segment", "/zones/", /empty path segments are not allowed/],
    ["double leading slash", "//evil.com/x", /empty path segments are not allowed/],
    // The URL parser DELETES tab/LF/CR before normalising, which turns ".<TAB>."
    // into a real ".." segment.
    ["tab", "/servers/1/.\t./.\t./ssh_keys", /must be percent-encoded/],
    ["newline", "/servers/1/\n../\n../ssh_keys", /must be percent-encoded/],
    ["carriage return", "/servers/1/\r..\r/ssh_keys", /must be percent-encoded/],
    ["space", "/servers/a b", /must be percent-encoded/],
    ["non-ASCII", "/zones/münchen.de", /must be percent-encoded/],
    ["NUL", "/servers/1\u0000", /must be percent-encoded/],
  ];

  for (const [name, path, message] of rejected) {
    it(`rejects a path containing a ${name} before any fetch`, async () => {
      const fetchImpl = vi.fn();
      await expect(client(fetchImpl).request("GET", path)).rejects.toThrow(message);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  }

  it("rejects anything the URL parser would rewrite, whatever the spelling", async () => {
    // Belt to the character/segment braces: buildUrl compares the assembled
    // pathname against base + path and refuses any difference. Nothing here may
    // reach fetch, and none of it may be reported as a *successful* request.
    const fetchImpl = vi.fn();
    const c = client(fetchImpl);
    for (const path of [
      "/zones/./rrsets",
      "/zones/%2e/rrsets",
      "/servers/1/%2e%2e/%2e%2e/ssh_keys",
      "/servers/1/.\t./.\t./ssh_keys",
      "/servers/1/\t..\t/\t..\t/ssh_keys",
      "/zones//actions",
    ]) {
      await expect(c.request("GET", path), path).rejects.toThrow(/Invalid request path/);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps the host pinned for authority-confusion payloads", async () => {
    const seen: string[] = [];
    const fetchImpl = fakeFetch(async (req) => {
      seen.push(new URL(req.url).host);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    const c = client(fetchImpl as ReturnType<typeof vi.fn>);
    await c.request("GET", "/servers/@evil.com");
    await c.request("GET", "/servers/evil.com:8080");
    expect(seen).toEqual(["api.hetzner.cloud", "api.hetzner.cloud"]);
  });

  it("still accepts legitimate paths (no false rejections)", async () => {
    const urls: string[] = [];
    const fetchImpl = fakeFetch(async (req) => {
      urls.push(req.url);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    const c = client(fetchImpl as ReturnType<typeof vi.fn>);
    await c.request("GET", "/servers/42");
    await c.request("GET", "servers/42"); // no leading slash
    await c.request("GET", "/zones/example.com/rrsets/www/A");
    await c.request("GET", "/servers/42%2F..%2Fx"); // already-encoded segment stays literal
    await c.request("GET", "/servers", { query: { name: "a b&c" } });
    // Percent-encoded non-ASCII and every RFC 3986 sub-delim survive verbatim,
    // which is what the generated tools produce via encodeURIComponent.
    await c.request("GET", "/zones/m%C3%BCnchen.de/rrsets/_dmarc/TXT");
    await c.request("GET", "/servers/a!$&'()*+,;=:@~-_.x");
    expect(urls).toEqual([
      "https://api.hetzner.cloud/v1/servers/42",
      "https://api.hetzner.cloud/v1/servers/42",
      "https://api.hetzner.cloud/v1/zones/example.com/rrsets/www/A",
      "https://api.hetzner.cloud/v1/servers/42%2F..%2Fx",
      "https://api.hetzner.cloud/v1/servers?name=a+b%26c",
      "https://api.hetzner.cloud/v1/zones/m%C3%BCnchen.de/rrsets/_dmarc/TXT",
      "https://api.hetzner.cloud/v1/servers/a!$&'()*+,;=:@~-_.x",
    ]);
  });

  it("works for a base URL without a path component", async () => {
    const urls: string[] = [];
    const fetchImpl = fakeFetch(async (req) => {
      urls.push(req.url);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    const c = client(fetchImpl as ReturnType<typeof vi.fn>, "https://api.hetzner.cloud");
    await c.request("GET", "/servers/42");
    expect(urls).toEqual(["https://api.hetzner.cloud/servers/42"]);
  });

  it("works for a base URL with a trailing slash", async () => {
    const urls: string[] = [];
    const fetchImpl = fakeFetch(async (req) => {
      urls.push(req.url);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    const c = client(fetchImpl as ReturnType<typeof vi.fn>, "https://api.hetzner.cloud/v1/");
    await c.request("GET", "/servers/42");
    expect(urls).toEqual(["https://api.hetzner.cloud/v1/servers/42"]);
  });
});

describe("redirect pinning (refs #54 QA)", () => {
  it("passes redirect:'error' to fetch so the exact-target guarantee survives the first hop", async () => {
    const seen: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      seen.push(init);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    const client = new HetznerHttpClient({
      baseUrl: "https://api.hetzner.cloud/v1",
      token: "T",
      fetch: fetchImpl as never,
    });
    await client.request("GET", "/servers/42");
    // Without this the origin could re-target the request one hop later and the
    // Authorization header would go with it (reproduced: 301 -> /v1/ssh_keys).
    expect(seen[0]!.redirect).toBe("error");
  });
});
