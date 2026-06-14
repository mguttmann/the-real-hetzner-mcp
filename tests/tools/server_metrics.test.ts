import { describe, it, expect, vi } from "vitest";
import { makeServerMetricsTool } from "../../src/tools/wrappers/server_metrics.js";

function responder() {
  // Lookup-by-name path returns one server with id=77; metrics path returns sample series.
  return vi.fn(async (_m: string, p: string, opts?: any) => {
    if (p === "/servers" && opts?.query?.name === "example-server-1") {
      return { status: 200, headers: new Headers(), body: {
        servers: [{ id: 77, name: "example-server-1" }],
        meta: { pagination: { page: 1, per_page: 25, next_page: null, last_page: 1 } },
      }};
    }
    if (/^\/servers\/\d+\/metrics$/.test(p)) {
      return { status: 200, headers: new Headers(), body: { metrics: { timeseries: {} } } };
    }
    throw new Error(`unexpected ${p}`);
  });
}

describe("hcloud_get_server_metrics", () => {
  it("looks up by name and forwards default time window", async () => {
    const request = responder();
    const tool = makeServerMetricsTool({ client: { request } as any, nowMs: () => Date.parse("2026-05-25T12:00:00Z") });
    await tool.handler({ name: "example-server-1", type: "cpu" });
    const lastCall = request.mock.calls.at(-1)!;
    expect(lastCall[1]).toBe("/servers/77/metrics");
    const q = lastCall[2].query;
    expect(q.type).toBe("cpu");
    expect(q.step).toBe(60);
    expect(q.start).toBe("2026-05-25T11:00:00.000Z");
    expect(q.end).toBe("2026-05-25T12:00:00.000Z");
  });

  it("accepts id directly without lookup", async () => {
    const request = responder();
    const tool = makeServerMetricsTool({ client: { request } as any });
    await tool.handler({ id: 5, type: "disk", start: "2026-01-01T00:00:00Z", end: "2026-01-01T01:00:00Z" });
    expect(request).toHaveBeenCalledWith(
      "GET",
      "/servers/5/metrics",
      expect.objectContaining({ query: expect.objectContaining({ type: "disk", start: "2026-01-01T00:00:00Z", end: "2026-01-01T01:00:00Z" }) }),
    );
  });

  it("rejects unknown metric type", async () => {
    const tool = makeServerMetricsTool({ client: { request: vi.fn() } as any });
    const res = await tool.handler({ id: 1, type: "bogus" });
    expect(res.isError).toBe(true);
  });

  it("surfaces 4xx on the metrics endpoint as isError with Hetzner code", async () => {
    const request = vi.fn(async () => ({
      status: 422,
      headers: new Headers(),
      body: { error: { code: "invalid_input", message: "step too small" } },
    }));
    const tool = makeServerMetricsTool({ client: { request } as any });
    const res = await tool.handler({ id: 5, type: "cpu" });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("422");
    expect(text).toContain("invalid_input");
    expect(text).toContain("step too small");
  });
});
