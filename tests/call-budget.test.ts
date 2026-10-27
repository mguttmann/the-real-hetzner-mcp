import { describe, it, expect, vi, afterEach } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildRegistry } from "../src/build-registry.js";

// MCP clients and gateways commonly give a tool call 60 s. With default settings
// every tool call must answer before that, so the caller gets the server's own
// result (including a write body with polling_timed_out) instead of a client
// timeout. Fake timers drive the real registry, client, retry sleeps and polling.

const GATEWAY_CALL_TIMEOUT_MS = 60_000;

type Upstream = (method: string, url: URL, signal: AbortSignal) => Promise<Response>;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Never answers; rejects when the client aborts the attempt. */
function hang(signal: AbortSignal): Promise<Response> {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function after(ms: number, res: () => Response, signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(res()), ms);
    signal.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });
}

const running = { id: 99, command: "create_server", status: "running", progress: 0,
  started: "2026-10-27T10:00:00Z", finished: null, resources: [], error: null };
const created = { server: { id: 4711 }, root_password: "S3cret", action: running };
const createArgs = { body: { name: "web-1", server_type: "cx22", image: "ubuntu-24.04" } };

async function timeCall(upstream: Upstream, tool: string, args: Record<string, unknown>) {
  const config = loadConfig({ HETZNER_API_TOKEN: "dummy", HETZNER_API_BASE: "http://127.0.0.1:1/v1" });
  const registry = buildRegistry(config, {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return upstream(init?.method ?? "GET", url, init!.signal!);
    }) as typeof globalThis.fetch,
  });
  const start = Date.now();
  let settledAt: number | undefined;
  let outcome: unknown;
  registry.getByName(tool)!.handler(args).then(
    (r) => { settledAt = Date.now(); outcome = r; },
    (e) => { settledAt = Date.now(); outcome = e; },
  );
  // Step through fake time until the call settles or clearly overruns.
  for (let i = 0; i < 200 && settledAt === undefined; i++) {
    await vi.advanceTimersByTimeAsync(1_000);
  }
  return { elapsed: settledAt === undefined ? Infinity : settledAt - start, outcome };
}

function parsed(outcome: unknown): Record<string, unknown> {
  return JSON.parse((outcome as { content: Array<{ text: string }> }).content[0]!.text);
}

describe("default time budget of one tool call", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("create_server whose action never finishes returns the write body before 60 s", async () => {
    vi.useFakeTimers();
    const { elapsed, outcome } = await timeCall(
      async (method, _url, signal) => (method === "POST" ? json(201, created) : after(300, () => json(200, { action: running }), signal)),
      "hcloud_create_server",
      createArgs,
    );
    expect(elapsed).toBeLessThan(GATEWAY_CALL_TIMEOUT_MS);
    const body = parsed(outcome);
    expect(body.root_password).toBe("S3cret");
    expect(body.polling_timed_out).toBe(true);
  });

  it("a slow write plus hanging poll requests still returns the write body before 60 s", async () => {
    vi.useFakeTimers();
    const { elapsed, outcome } = await timeCall(
      async (method, _url, signal) => (method === "POST" ? after(25_000, () => json(201, created), signal) : hang(signal)),
      "hcloud_create_server",
      createArgs,
    );
    expect(elapsed).toBeLessThan(GATEWAY_CALL_TIMEOUT_MS);
    const body = parsed(outcome);
    expect(body.root_password).toBe("S3cret");
    expect(body.polling_timed_out).toBe(true);
  });

  it("polls that hit 429 with a long Retry-After do not wait it out", async () => {
    vi.useFakeTimers();
    const { elapsed, outcome } = await timeCall(
      async (method) => (method === "POST"
        ? json(201, created)
        : json(429, { error: { code: "rate_limit_exceeded", message: "limit" } }, { "retry-after": "3600" })),
      "hcloud_create_server",
      createArgs,
    );
    expect(elapsed).toBeLessThan(GATEWAY_CALL_TIMEOUT_MS);
    expect(parsed(outcome).polling_error).toBe("HetznerApiError[429 rate_limit_exceeded]: limit");
  });

  it("slow 5xx answers on a GET are not retried past the budget", async () => {
    vi.useFakeTimers();
    const { elapsed } = await timeCall(
      async (_m, _u, signal) => after(20_000, () => json(503, { error: { code: "unavailable", message: "x" } }), signal),
      "hcloud_get_server",
      { id: 1 },
    );
    expect(elapsed).toBeLessThan(GATEWAY_CALL_TIMEOUT_MS);
  });

  for (const tool of ["hcloud_list_servers", "hcloud_list_servers_raw"]) {
    it(`${tool} with slow pages returns a truncated list with a note before 60 s`, async () => {
      vi.useFakeTimers();
      const { elapsed, outcome } = await timeCall(
        async (_m, url, signal) => {
          const n = Number(url.searchParams.get("page") ?? "1");
          return after(25_000, () => json(200, {
            servers: [{ id: n, name: `s${n}` }],
            meta: { pagination: { page: n, per_page: 1, previous_page: null, next_page: n + 1, last_page: 10, total_entries: 10 } },
          }), signal);
        },
        tool,
        {},
      );
      expect(elapsed).toBeLessThan(GATEWAY_CALL_TIMEOUT_MS);
      const body = parsed(outcome);
      expect(body.truncated).toBe(true);
      expect(body.servers).toHaveLength(1);
      expect(body.note).toMatch(/PAGINATION_TIMEOUT_MS/);
    });
  }

  it("hcloud_wait_action on a never-finishing action returns before 60 s", async () => {
    vi.useFakeTimers();
    const { elapsed, outcome } = await timeCall(
      async (_m, _u, signal) => after(500, () => json(200, { action: running }), signal),
      "hcloud_wait_action",
      { id: 99 },
    );
    expect(elapsed).toBeLessThan(GATEWAY_CALL_TIMEOUT_MS);
    expect(parsed(outcome).polling_timed_out).toBe(true);
  });
});
