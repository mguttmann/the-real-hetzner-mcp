import { describe, it, expect, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { loadConfig } from "../src/config.js";
import { buildRegistry } from "../src/build-registry.js";
import { createMcpServer } from "../src/server.js";
import { HetznerHttpClient } from "../src/http/client.js";
import { pollAction } from "../src/http/action-polling.js";
import { minimalArgs } from "./_minimal-args.js";

// A cancelled tool call (MCP notifications/cancelled, surfaced by the SDK as
// the handler's abort signal) must stop: the in-flight request is aborted and
// no further request (next page, next poll, retry) is sent.

function hang(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

describe("cancellation reaches every tool's requests", () => {
  it("every tool stops at the first request once its call is cancelled", async () => {
    const config = loadConfig({
      HETZNER_API_TOKEN: "dummy",
      HETZNER_API_BASE: "http://127.0.0.1:1/v1",
      HTTP_TIMEOUT_MS: "60000",
    });
    let calls = 0;
    let cancel: () => void = () => {};
    const registry = buildRegistry(config, {
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        calls++;
        cancel();
        return hang(init?.signal);
      }) as typeof globalThis.fetch,
    });
    const hung: string[] = [];
    const extra: string[] = [];
    let reached = 0;
    for (const tool of registry.getAll()) {
      calls = 0;
      const controller = new AbortController();
      cancel = () => controller.abort(new Error("cancelled by the caller"));
      const call = tool.handler(minimalArgs(tool.name, tool.inputSchema), { signal: controller.signal })
        .then(() => "settled", () => "settled");
      const outcome = await Promise.race([call, new Promise((r) => setTimeout(() => r("hung"), 200))]);
      if (outcome === "hung") hung.push(tool.name);
      if (calls > 1) extra.push(tool.name);
      if (calls > 0) reached++;
    }
    expect(hung).toEqual([]);
    expect(extra).toEqual([]);
    // Nearly every tool reaches the fake upstream with these arguments; the
    // few that refuse them locally (exactly one of id or name) do not count.
    expect(reached).toBeGreaterThan(registry.size() - 5);
  }, 120_000);

  it("an MCP client cancel aborts the upstream request and sends no further one", async () => {
    const config = loadConfig({ HETZNER_API_TOKEN: "dummy", HETZNER_API_BASE: "http://127.0.0.1:1/v1" });
    const signals: AbortSignal[] = [];
    const registry = buildRegistry(config, {
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        signals.push(init!.signal!);
        return hang(init?.signal);
      }) as typeof globalThis.fetch,
    });
    const server = createMcpServer(registry, { debug() {}, info() {}, warn() {}, error() {} } as never);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const mcp = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await mcp.connect(clientTransport);
    const controller = new AbortController();
    const call = mcp.callTool({ name: "hcloud_list_servers", arguments: {} }, { signal: controller.signal })
      .catch((e: unknown) => e);
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    controller.abort("stop");
    await call;
    await vi.waitFor(() => expect(signals[0]!.aborted).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(signals).toHaveLength(1);
    await mcp.close();
    await server.close();
  });
});

describe("cancellation in the client and the poller", () => {
  it("an already aborted call sends nothing", async () => {
    const fetch = vi.fn();
    const client = new HetznerHttpClient({ baseUrl: "http://127.0.0.1:1/v1", token: "t", fetch });
    const signal = AbortSignal.abort(new Error("cancelled"));
    await expect(client.request("GET", "/servers", { signal })).rejects.toThrow("cancelled");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a cancel during a retry delay stops the retry", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 429, headers: { "retry-after": "5" } }));
    const client = new HetznerHttpClient({ baseUrl: "http://127.0.0.1:1/v1", token: "t", fetch });
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("cancelled")), 20);
    const started = Date.now();
    await expect(client.request("GET", "/servers", { signal: controller.signal })).rejects.toThrow("cancelled");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("a cancel during the pause between polls stops polling", async () => {
    const running = { id: 5, status: "running", command: "x", progress: 0, started: "", finished: null, resources: [], error: null };
    const request = vi.fn(async () => ({ status: 200, headers: new Headers(), body: { action: running } }));
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("cancelled")), 20);
    const started = Date.now();
    await expect(pollAction(request as never, 5, { timeoutMs: 30_000, intervalMs: 5_000, signal: controller.signal }))
      .rejects.toThrow("cancelled");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
