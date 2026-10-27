import { describe, it, expect } from "vitest";
import pino from "pino";
import { loadConfig } from "../src/config.js";
import { buildRegistry } from "../src/build-registry.js";
import { globMatcher } from "../src/tools/policy.js";
import type { ToolRegistry } from "../src/tools/registry.js";
import { minimalArgs } from "./_minimal-args.js";

// B-016: HETZNER_READ_ONLY and HETZNER_DENY_TOOLS are enforced at call time
// against the real registry. A blocked call returns isError and sends nothing;
// the tool list and every schema stay exactly as they are without the switches.

const BASE = { HETZNER_API_TOKEN: "dummy", HETZNER_API_BASE: "http://127.0.0.1:1/v1" };

function harness(env: Record<string, string>, logger?: pino.Logger) {
  const methods: string[] = [];
  const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    methods.push(init?.method ?? "GET");
    return new Response(
      JSON.stringify({ action: { id: 1, status: "success" }, meta: { pagination: { next_page: null } } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
  const registry = buildRegistry(loadConfig({ ...BASE, ...env }), {
    fetch,
    ...(logger ? { logger } : {}),
  });
  return { registry, methods };
}

function surface(registry: ToolRegistry): string {
  return JSON.stringify(
    registry.getAll().map((t) => [t.name, t.description, t.inputSchema, t.annotations]),
  );
}

function text(res: { content: Array<{ type: string; text?: string }> }): string {
  return res.content.map((c) => c.text ?? "").join("");
}

describe("HETZNER_READ_ONLY (B-016)", () => {
  it("blocks every tool that is not read-only and sends no request for it", async () => {
    const h = harness({ HETZNER_READ_ONLY: "true" });
    const blocked: string[] = [];
    let readOnlyReached = 0;
    let readOnlyTools = 0;
    for (const tool of h.registry.getAll()) {
      if (tool.name === "hcloud_raw_request") continue;
      const before = h.methods.length;
      const res = await tool.handler(minimalArgs(tool.name, tool.inputSchema)).catch((err: unknown) => ({
        content: [{ type: "text", text: String(err) }],
        isError: true,
      }));
      if (tool.annotations.readOnlyHint) {
        readOnlyTools++;
        if (h.methods.length > before) readOnlyReached++;
      } else {
        expect(res.isError, tool.name).toBe(true);
        expect(text(res), tool.name).toMatch(/HETZNER_READ_ONLY/);
        expect(h.methods.length, tool.name).toBe(before);
        blocked.push(tool.name);
      }
    }
    // Every request that did go out was a GET.
    expect(new Set(h.methods)).toEqual(new Set(["GET"]));
    expect(blocked.length).toBeGreaterThan(90);
    // Read-only tools keep working; the few that refuse these arguments locally
    // (exactly one of id or name) do not count.
    expect(readOnlyReached).toBeGreaterThan(readOnlyTools - 5);
  });

  it("lets hcloud_raw_request send GET and blocks every other method", async () => {
    const h = harness({ HETZNER_READ_ONLY: "true" });
    const raw = h.registry.getByName("hcloud_raw_request")!;
    const ok = await raw.handler({ method: "GET", path: "/servers" });
    expect(ok.isError).toBeUndefined();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await raw.handler({ method, path: "/servers", body: {} });
      expect(res.isError, method).toBe(true);
      expect(text(res)).toMatch(/HETZNER_READ_ONLY/);
    }
    expect(h.methods).toEqual(["GET"]);
  });

  it("blocks a write even with confirm: \"YES\" when the confirm guard is on", async () => {
    const h = harness({ HETZNER_READ_ONLY: "true", HETZNER_CONFIRM_WRITES: "true" });
    const tool = h.registry.getByName("hcloud_server_power")!;
    const res = await tool.handler({ id: 1, action: "poweroff", confirm: "YES" });
    expect(res.isError).toBe(true);
    const raw = await h.registry.getByName("hcloud_raw_request")!.handler({ method: "DELETE", path: "/servers/1", confirm: "YES" });
    expect(raw.isError).toBe(true);
    expect(h.methods).toEqual([]);
  });

  it("leaves the tool list and every schema unchanged", () => {
    const plain = surface(harness({}).registry);
    expect(surface(harness({ HETZNER_READ_ONLY: "true" }).registry)).toBe(plain);
    expect(surface(harness({ HETZNER_DENY_TOOLS: "hcloud_*" }).registry)).toBe(plain);
    const confirm = surface(harness({ HETZNER_CONFIRM_WRITES: "true" }).registry);
    expect(
      surface(harness({ HETZNER_CONFIRM_WRITES: "true", HETZNER_READ_ONLY: "true", HETZNER_DENY_TOOLS: "*" }).registry),
    ).toBe(confirm);
  });

  it("is off by default: writes still go out", async () => {
    const h = harness({});
    const res = await h.registry.getByName("hcloud_raw_request")!.handler({ method: "POST", path: "/servers", body: {} });
    expect(res.isError).toBeUndefined();
    expect(h.methods).toEqual(["POST"]);
  });
});

describe("HETZNER_DENY_TOOLS (B-016)", () => {
  it("blocks matching tools, read-only ones included, and nothing else", async () => {
    const h = harness({ HETZNER_DENY_TOOLS: " hcloud_delete_* , hcloud_raw_request,hcloud_list_server?" });
    const denied: string[] = [];
    for (const tool of h.registry.getAll()) {
      const before = h.methods.length;
      const res = await tool.handler(minimalArgs(tool.name, tool.inputSchema)).catch(() => ({
        content: [{ type: "text", text: "threw" }],
        isError: true,
      }));
      if (/HETZNER_DENY_TOOLS/.test(text(res))) {
        expect(res.isError, tool.name).toBe(true);
        expect(h.methods.length, tool.name).toBe(before);
        denied.push(tool.name);
      }
    }
    const expected = h.registry
      .getAll()
      .map((t) => t.name)
      .filter((n) => n.startsWith("hcloud_delete_") || n === "hcloud_raw_request" || n === "hcloud_list_servers");
    expect(denied.sort()).toEqual(expected.sort());
    expect(denied).toContain("hcloud_list_servers");
    expect(denied.length).toBeGreaterThan(10);
  });

  it("is checked before the confirm guard, so a denied tool shows no preview", async () => {
    const h = harness({ HETZNER_CONFIRM_WRITES: "true", HETZNER_DENY_TOOLS: "hcloud_server_power" });
    const res = await h.registry.getByName("hcloud_server_power")!.handler({ id: 1, action: "poweroff" });
    expect(res.isError).toBe(true);
    expect(text(res)).not.toMatch(/PREVIEW/);
  });

  it("stops at startup on a pattern that matches no tool, so a typo cannot leave the switch off", () => {
    expect(() => harness({ HETZNER_DENY_TOOLS: "hcloud_delete_*,hcloud_typo_tool" })).toThrow(
      /HETZNER_DENY_TOOLS pattern "hcloud_typo_tool" matches no tool/,
    );
    // Patterns use the server-local names, not a gateway-prefixed name.
    expect(() => harness({ HETZNER_DENY_TOOLS: "hetzner_hcloud_delete_*" })).toThrow(/matches no tool/);
  });
});

describe("globMatcher", () => {
  it("supports * and ? and treats everything else literally", () => {
    expect(globMatcher("hcloud_delete_*")("hcloud_delete_server")).toBe(true);
    expect(globMatcher("hcloud_delete_*")("hcloud_list_servers")).toBe(false);
    expect(globMatcher("*")("anything")).toBe(true);
    expect(globMatcher("hcloud_list_server?")("hcloud_list_servers")).toBe(true);
    expect(globMatcher("hcloud_list_server?")("hcloud_list_server")).toBe(false);
    expect(globMatcher("hcloud.list")("hcloudxlist")).toBe(false);
    expect(globMatcher("hcloud_raw_request")("hcloud_raw_request_x")).toBe(false);
    expect(globMatcher("HCLOUD_*")("hcloud_get_server")).toBe(false);
  });
});
