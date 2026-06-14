import { describe, it, expect, beforeAll } from "vitest";
import { loadConfig } from "../src/config.js";
import { HetznerHttpClient } from "../src/http/client.js";
import { makeServerListTool } from "../src/tools/wrappers/server_list.js";
import { buildGeneratedTools } from "../src/tools/generated/tools.js";
import { OPERATIONS } from "../src/tools/generated/operations.js";
import type { ToolDef, ToolResult } from "../src/types.js";

const skip = process.env.RUN_LIVE_TESTS !== "1";

// Optional anchor server names. Set HETZNER_LIVE_SMOKE_ANCHORS to a
// comma-separated list of server names you expect to see in the account.
// When unset, the live read-only smoke test only checks that at least one
// server is returned.
function parseAnchors(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseToolJson(result: ToolResult): any {
  expect(result.isError).not.toBe(true);
  const first = result.content[0];
  expect(first).toBeDefined();
  expect(first!.type).toBe("text");
  return JSON.parse((first as { text: string }).text);
}

function getGenerated(tools: ToolDef[], name: string): ToolDef {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Generated tool "${name}" not found`);
  return tool;
}

describe.runIf(!skip)("live smoke — Hetzner Cloud API (via tool handlers)", () => {
  let client: HetznerHttpClient;
  let serverListTool: ToolDef;
  let generated: ToolDef[];

  beforeAll(() => {
    const cfg = loadConfig();
    client = new HetznerHttpClient({
      baseUrl: cfg.baseUrl,
      token: cfg.token,
      timeoutMs: cfg.httpTimeoutMs,
    });
    const limits = {
      maxItems: cfg.paginationMaxItems,
      maxPages: cfg.paginationMaxPages,
    };
    serverListTool = makeServerListTool(client, limits);
    generated = buildGeneratedTools(client, OPERATIONS, {
      maxItems: cfg.paginationMaxItems,
      maxPages: cfg.paginationMaxPages,
      actionPoll: {
        timeoutMs: cfg.actionPollTimeoutMs,
        intervalMs: cfg.actionPollIntervalMs,
      },
    });
  });

  it("hcloud_list_servers returns ≥1 server (optionally verifying anchors)", async () => {
    const result = await serverListTool.handler({});
    const parsed = parseToolJson(result);
    expect(Array.isArray(parsed.servers)).toBe(true);
    expect(parsed.servers.length).toBeGreaterThanOrEqual(1);

    const anchors = parseAnchors(process.env.HETZNER_LIVE_SMOKE_ANCHORS);
    if (anchors.length > 0) {
      const names = (parsed.servers as Array<{ name: string }>).map((s) => s.name);
      const found = anchors.filter((a) => names.includes(a));
      expect(
        found.length,
        `expected at least one anchor server name from ${JSON.stringify(anchors)} to be present; got names: ${JSON.stringify(names)}`,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it("hcloud_list_datacenters returns datacenters", async () => {
    const tool = getGenerated(generated, "hcloud_list_datacenters");
    const result = await tool.handler({});
    const parsed = parseToolJson(result);
    expect(Array.isArray(parsed.datacenters)).toBe(true);
    expect(parsed.datacenters.length).toBeGreaterThanOrEqual(1);
  });

  it("hcloud_list_server_types returns server_types", async () => {
    const tool = getGenerated(generated, "hcloud_list_server_types");
    const result = await tool.handler({});
    const parsed = parseToolJson(result);
    expect(Array.isArray(parsed.server_types)).toBe(true);
    expect(parsed.server_types.length).toBeGreaterThanOrEqual(1);
  });

  it("hcloud_list_locations returns locations", async () => {
    const tool = getGenerated(generated, "hcloud_list_locations");
    const result = await tool.handler({});
    const parsed = parseToolJson(result);
    expect(Array.isArray(parsed.locations)).toBe(true);
    expect(parsed.locations.length).toBeGreaterThanOrEqual(1);
  });
});
