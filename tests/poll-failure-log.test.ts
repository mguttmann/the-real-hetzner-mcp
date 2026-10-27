import { describe, it, expect, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildRegistry } from "../src/build-registry.js";

// A poll failure after a successful write is returned as polling_error (the
// write body is kept) and logged at warn with the tool and the action id. The
// write body may hold a one-time root_password, so it never goes into the log.

const running = { id: 99, command: "create_server", status: "running", progress: 0,
  started: "2026-10-27T10:00:00Z", finished: null, resources: [], error: null };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function setup(writeBody: unknown) {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const config = loadConfig({ HETZNER_API_TOKEN: "dummy", HETZNER_API_BASE: "http://127.0.0.1:1/v1" });
  const registry = buildRegistry(config, {
    logger: logger as never,
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") return json(201, writeBody);
      throw new TypeError("fetch failed");
    }) as typeof globalThis.fetch,
  });
  return { registry, logger };
}

describe("poll failure after a write is logged", () => {
  const cases: Array<[string, Record<string, unknown>, unknown]> = [
    ["hcloud_create_server", { body: { name: "web-1", server_type: "cx22", image: "ubuntu-24.04" } },
      { server: { id: 4711 }, root_password: "S3cret", action: running }],
    ["hcloud_server_rebuild", { id: 42, image_name: "ubuntu-24.04" },
      { root_password: "S3cret", action: { ...running, command: "rebuild_server" } }],
  ];

  for (const [tool, args, writeBody] of cases) {
    it(`${tool}: warn with tool and action id, never the body`, async () => {
      const { registry, logger } = setup(writeBody);
      const res = await registry.getByName(tool)!.handler(args);
      expect(JSON.parse((res.content[0] as { text: string }).text).polling_error).toBe("fetch failed");
      expect(logger.warn).toHaveBeenCalledWith(
        { tool, action_id: 99, error: "fetch failed" },
        "action polling failed after a successful write",
      );
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("S3cret");
    });
  }
});
