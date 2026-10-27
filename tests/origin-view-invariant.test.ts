// Independent adversarial verification for issue #54, written by the tester
// against the fix rather than alongside it.
//
// Why a second file next to tests/adversarial-path-injection.test.ts: that suite
// classifies the *payload* (does this input escape its slot?) and then asserts
// "no request". A guard that misses a payload spelling nobody thought of is
// therefore invisible to it. This file inverts the direction and classifies the
// *artifact that would hit the network*: whatever URL leaves the process, one
// round of the percent-decoding a router performs before route matching must not
// turn it into a different path. That invariant needs no payload list to be
// correct, so it also covers spellings this file never thought of - it simply
// never lets a request out whose origin view differs in shape from its wire form.
//
// Basis: the Hetzner API decodes "%2f" and collapses a ".." dot segment before
// routing, so an encoded separator inside one segment can move a request to a
// different route. "One opaque percent-encoded segment" is therefore NOT a
// safety property; "stable under one decode" is.
//
// The real chain is wired the way src/index.ts does it - MCP Client ->
// InMemoryTransport -> createMcpServer -> registry -> real HetznerHttpClient ->
// spy fetch. Nothing between the tool boundary and fetch is stubbed.
import { describe, it, expect, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { HetznerHttpClient } from "../src/http/client.js";
import { createMcpServer } from "../src/server.js";
import { createLogger } from "../src/logger.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { withConfirmGuard } from "../src/tools/confirm.js";
import { makeServerListTool } from "../src/tools/wrappers/server_list.js";
import { makeServerGetTool } from "../src/tools/wrappers/server_get.js";
import { makeServerPowerTool } from "../src/tools/wrappers/server_power.js";
import { makeServerRebuildTool } from "../src/tools/wrappers/server_rebuild.js";
import { makeServerChangeTypeTool } from "../src/tools/wrappers/server_change_type.js";
import { makeServerSnapshotTool } from "../src/tools/wrappers/server_snapshot.js";
import { makeServerBackupTool } from "../src/tools/wrappers/server_backup.js";
import { makeServerRescueTool } from "../src/tools/wrappers/server_rescue.js";
import { makeServerMetricsTool } from "../src/tools/wrappers/server_metrics.js";
import { makeApplyFirewallToServerTool } from "../src/tools/wrappers/apply_firewall_to_server.js";
import { makeRawRequestTool } from "../src/tools/raw_request.js";
import { makeWaitActionTool } from "../src/tools/wait_action.js";
import { buildGeneratedTools } from "../src/tools/generated/tools.js";
import { OPERATIONS } from "../src/tools/generated/operations.js";
import type { OperationDef, ToolDef } from "../src/types.js";

const BASE_URL = "https://api.hetzner.cloud/v1";
const API_ORIGIN = "https://api.hetzner.cloud";
const TOKEN = "tester-secret-token";

// `hcloud_raw_request` accepts any path by design, but since B-020 it rejects
// percent-encoded separators and dots, so the invariant holds for it as well:
// no tool is exempt.

function harness(confirmWrites = false) {
  const urls: string[] = [];
  const fetchImpl = vi.fn(async (input: unknown) => {
    urls.push(typeof input === "string" ? input : String((input as Request).url));
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const client = new HetznerHttpClient({
    baseUrl: BASE_URL,
    token: TOKEN,
    fetch: fetchImpl as unknown as typeof globalThis.fetch,
    sleep: async () => {},
    maxRetries: 0,
  });
  const limits = { maxItems: 20, maxPages: 2 };
  const actionPoll = { timeoutMs: 0, intervalMs: 0, sleep: async () => {}, now: () => 0 };
  const actionDeps = { client, actionPoll };
  const registry = new ToolRegistry();
  const register = (tool: ToolDef) => registry.register(withConfirmGuard(tool, confirmWrites));

  register(makeServerListTool(client, limits));
  register(makeServerGetTool(client));
  register(makeServerPowerTool(actionDeps));
  register(makeServerRebuildTool(actionDeps));
  register(makeServerChangeTypeTool(actionDeps));
  register(makeServerSnapshotTool(actionDeps));
  register(makeServerBackupTool(actionDeps));
  register(makeServerRescueTool(actionDeps));
  register(makeServerMetricsTool({ client }));
  register(makeApplyFirewallToServerTool({ client, actionPoll }));
  for (const tool of buildGeneratedTools(client, OPERATIONS, { ...limits, actionPoll })) {
    if (registry.getByName(tool.name)) continue;
    register(tool);
  }
  registry.register(makeRawRequestTool({ client, confirmWrites }));
  register(makeWaitActionTool({ client, defaultPoll: actionPoll }));

  return { registry, urls };
}

async function connect(registry: ToolRegistry) {
  const server = createMcpServer(registry, createLogger("error"));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcp = new Client({ name: "tester", version: "0" }, { capabilities: {} });
  await mcp.connect(clientTransport);
  return {
    async call(name: string, args: Record<string, unknown>) {
      const res = await mcp.callTool({ name, arguments: args });
      const content = res.content as Array<{ type: string; text?: string }>;
      return {
        isError: res.isError === true,
        text: content.map((c) => c.text ?? "").join("\n"),
      };
    },
    async close() {
      await mcp.close();
      await server.close();
    },
  };
}

// ---------------------------------------------------------------------------
// The invariant.
// ---------------------------------------------------------------------------

/**
 * The pathname as the ORIGIN sees it: one round of the percent-decoding a router
 * performs before matching a route. Only the three byte classes that can change
 * the *shape* of a path are decoded - a separator in either direction and the dot
 * that forms a dot segment. Everything else may decode to whatever it likes; it
 * still lands inside one segment.
 */
function originView(pathname: string): string {
  return pathname
    .replace(/%2f/gi, "/")
    .replace(/%5c/gi, "\\")
    .replace(/%2e/gi, ".");
}

/**
 * A request may only be emitted when its path means the same thing on the wire
 * and after one decode. Concretely: decoding must not add a separator, must not
 * introduce a backslash (which some routers accept as one), and must not produce
 * a dot segment or an empty segment - those are how a value climbs out of its slot
 * or deletes the slot next to it.
 *
 * No payload list is involved: the check reads the emitted URL only, so it holds
 * for spellings this file does not know about.
 */
function assertStableUnderOriginDecode(url: string, context: string): void {
  const parsed = new URL(url);
  expect(parsed.origin, `${context}: left the API origin (${url})`).toBe(API_ORIGIN);
  expect(parsed.hash, `${context}: leaked into a fragment (${url})`).toBe("");
  expect(parsed.pathname.startsWith("/v1/"), `${context}: left the /v1 base (${url})`).toBe(true);

  const onWire = parsed.pathname;
  const asOriginSeesIt = originView(onWire);
  expect(
    asOriginSeesIt.split("/").length,
    `${context}: one decode ADDS a path separator - ${onWire} becomes ${asOriginSeesIt}`,
  ).toBe(onWire.split("/").length);
  expect(
    asOriginSeesIt.includes("\\"),
    `${context}: one decode yields a backslash separator - ${onWire} becomes ${asOriginSeesIt}`,
  ).toBe(false);
  for (const [i, segment] of asOriginSeesIt.split("/").slice(1).entries()) {
    expect(
      segment === "." || segment === ".." || segment === "",
      `${context}: segment ${i} of ${onWire} is a dot/empty segment after one decode (${asOriginSeesIt})`,
    ).toBe(false);
  }
}

it("the invariant actually fails on the URLs issue #54 reproduced (self-test)", () => {
  // Without these, a guard that blocks everything - or one that blocks nothing -
  // could both make the sweeps below pass.
  const bad = [
    // What hcloud_delete_zone {id_or_name:"../servers/42"} used to emit.
    `${API_ORIGIN}/v1/zones/..%2Fservers%2F42`,
    `${API_ORIGIN}/v1/zones/..%2fservers%2f42`,
    `${API_ORIGIN}/v1/zones/%2e%2e%2Fssh_keys`,
    `${API_ORIGIN}/v1/zones/..%5Cservers`,
    `${API_ORIGIN}/v1/zones/1%2F%2E%2E%2F%2E%2E%2Fssh_keys`,
    // Segment deleted rather than added. (`/zones/%2e%2e/actions` is NOT in this
    // list: the WHATWG parser already collapses that one, so `new URL().pathname`
    // never shows it and no client can emit it.)
    `${API_ORIGIN}/v1/zones//actions`,
  ];
  for (const url of bad) {
    expect(() => assertStableUnderOriginDecode(url, "self-test"), url).toThrow();
  }
  const good = [
    `${API_ORIGIN}/v1/zones/example.com`,
    `${API_ORIGIN}/v1/zones/m%C3%BCnchen.de/rrsets/%40/A`,
    `${API_ORIGIN}/v1/servers/42/actions/enable_backup`,
    `${API_ORIGIN}/v1/zones/a%20b%23c%3Fd`, // encoded space/#/? stay in the slot
    `${API_ORIGIN}/v1/zones/%25252e%25252e`, // double-encoded: no separator spelled
  ];
  for (const url of good) {
    expect(() => assertStableUnderOriginDecode(url, "self-test"), url).not.toThrow();
  }
});

// ---------------------------------------------------------------------------
// 1. The payloads reproduced in the issue, verbatim, end to end.
// ---------------------------------------------------------------------------

/** Verbatim from the issue's reproduction section. */
const REPRODUCED_VERBATIM: string[] = [
  "42",
  "42/actions/reset_password?",
  "42/actions/reset_password#",
  "1/../../floating_ips/9/actions/unassign?",
];

const ID_SINKS: Array<{ tool: string; extra: Record<string, unknown> }> = [
  { tool: "hcloud_server_backup", extra: { enable: true } },
  { tool: "hcloud_server_power", extra: { op: "reboot" } },
  { tool: "hcloud_server_rescue", extra: { enable: true } },
  { tool: "hcloud_server_snapshot", extra: {} },
  { tool: "hcloud_server_change_type", extra: { server_type: "cx22" } },
  { tool: "hcloud_server_rebuild", extra: { image_id: 42 } },
  { tool: "hcloud_wait_action", extra: {} },
  { tool: "hcloud_get_server", extra: {} },
  { tool: "hcloud_get_server_metrics", extra: { type: "cpu" } },
  { tool: "hcloud_get_server_raw", extra: {} },
];

describe("issue #54 - the reproduced payloads, through the real chain", () => {
  it("no id sink turns any of them into a request", async () => {
    const h = harness(true); // confirm mode on - `confirm` must buy nothing
    const mcp = await connect(h.registry);
    let checked = 0;
    try {
      for (const { tool, extra } of ID_SINKS) {
        for (const id of REPRODUCED_VERBATIM) {
          const context = `${tool} id=${JSON.stringify(id)}`;
          const before = h.urls.length;
          const res = await mcp.call(tool, { ...extra, id, confirm: "YES" });
          checked++;
          expect(res.isError, `${context}: accepted`).toBe(true);
          expect(h.urls.slice(before), `${context}: reached the network`).toEqual([]);
          // The rejection has to be about the id, not about this test's own args.
          expect(res.text, `${context}: masked by an unrelated error`).not.toMatch(
            /missing required property|unknown property/,
          );
          expect(res.text, `${context}: leaked the token`).not.toContain(TOKEN);
        }
      }
    } finally {
      await mcp.close();
    }
    expect(checked).toBe(ID_SINKS.length * REPRODUCED_VERBATIM.length);
    expect(h.urls).toEqual([]);
  });

  it("the string-typed path parameters reject the traversal spellings too", async () => {
    // These are the sinks the first fix round left open: `id_or_name` and
    // `rr_name` are declared `type: "string"`, so the type check that stops the
    // numeric ids does not apply and only the segment guard does.
    const climbs = [
      "../servers/42",
      "..%2Fservers%2F42",
      "42/actions/reset_password",
      "1/../../floating_ips/9/actions/unassign",
      "../../ssh_keys",
      "..\\servers",
      "%2e%2e%2Fssh_keys",
    ];
    const sinks: Array<{ tool: string; key: string; extra: Record<string, unknown> }> = [
      { tool: "hcloud_get_zone", key: "id_or_name", extra: {} },
      { tool: "hcloud_delete_zone", key: "id_or_name", extra: {} },
      { tool: "hcloud_update_zone", key: "id_or_name", extra: { body: { ttl: 3600 } } },
      { tool: "hcloud_get_zone_rrsets", key: "id_or_name", extra: {} },
      {
        tool: "hcloud_delete_zone_rrset",
        key: "rr_name",
        extra: { id_or_name: "example.com", rr_type: "A" },
      },
    ];
    const h = harness(false);
    const mcp = await connect(h.registry);
    try {
      for (const { tool, key, extra } of sinks) {
        for (const payload of climbs) {
          const context = `${tool}.${key} = ${JSON.stringify(payload)}`;
          const before = h.urls.length;
          const res = await mcp.call(tool, { ...extra, [key]: payload });
          expect(res.isError, `${context}: accepted`).toBe(true);
          expect(h.urls.slice(before), `${context}: reached the network`).toEqual([]);
          expect(res.text, `${context}: masked by an unrelated error`).not.toMatch(
            /missing required property|unknown property/,
          );
        }
      }
    } finally {
      await mcp.close();
    }
    expect(h.urls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Registry-wide: whatever DOES go out is stable under one origin decode.
// ---------------------------------------------------------------------------

const OP_BY_TOOL = new Map<string, OperationDef>(OPERATIONS.map((op) => [op.toolName, op]));

type PropSchema = { type?: unknown; enum?: unknown[] };

function placeholder(schema: PropSchema): unknown {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case "integer":
    case "number":
      return 1;
    case "string":
      return "1";
    case "boolean":
      return false;
    case "array":
      return [];
    default:
      return {};
  }
}

function propsOf(tool: ToolDef): Record<string, PropSchema> {
  return ((tool.inputSchema as { properties?: Record<string, PropSchema> }).properties ?? {});
}

function validArgs(tool: ToolDef): Record<string, unknown> {
  const schema = tool.inputSchema as { required?: unknown };
  const properties = propsOf(tool);
  const args: Record<string, unknown> = {};
  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (typeof key !== "string") continue;
      const prop = properties[key];
      if (prop) args[key] = placeholder(prop);
    }
  }
  if (properties.wait) args.wait = false;
  if (properties.auto_paginate) args.auto_paginate = false;
  return args;
}

/**
 * Deliberately NOT the developer's list. Chosen to attack the guard's mechanics:
 * every spelling of a separator and a dot segment I could think of, plus the
 * "already encoded" and "double encoded" forms whose classification is the part a
 * payload-driven oracle gets wrong.
 */
const HOSTILE_STRINGS: string[] = [
  "../servers/42",
  "..%2Fservers%2F42",
  "..%2fservers%2f42",
  "%2e%2e%2f%2e%2e%2fssh_keys",
  "%2E%2E/%2E%2E/ssh_keys",
  "..%5Cservers",
  "..\\..\\ssh_keys",
  "1%2F..%2F..%2Fssh_keys",
  "1/actions/reset_password?x=1",
  "1/actions/reset_password#f",
  ".",
  "..",
  "",
  "./",
  "1//2",
  "//evil.example.com/x",
  "\\\\evil.example.com\\x",
  "http://evil.example.com/x",
  "1\t/../x",
  "1\n/../x",
  "%252e%252e%252fssh_keys",
  "%c0%ae%c0%ae/ssh_keys",
  "..%00/ssh_keys",
  "．．/servers", // fullwidth dots
  "∕servers", // division slash
];

describe("issue #54 - every emitted URL is stable under one origin decode", () => {
  it("injecting a hostile string into any declared property of any tool", async () => {
    const h = harness(false);
    let inspected = 0;
    let emitted = 0;
    let toolsSwept = 0;

    for (const tool of h.registry.getAll()) {
      toolsSwept++;
      const keys = Object.keys(propsOf(tool));
      for (const key of keys) {
        for (const payload of HOSTILE_STRINGS) {
          const args = { ...validArgs(tool), [key]: payload };
          const context = `${tool.name}.${key} = ${JSON.stringify(payload)}`;
          const before = h.urls.length;
          try {
            await tool.handler(args);
          } catch {
            // A throw is a pass: only what reached fetch is under test.
          }
          const got = h.urls.slice(before);
          inspected++;
          emitted += got.length;
          for (const url of got) assertStableUnderOriginDecode(url, context);
        }
      }
    }

    // Guards against the sweep quietly becoming a no-op: it has to cover the
    // whole tool set, and enough requests have to actually be emitted that the
    // invariant is doing work rather than being vacuously true.
    expect(h.registry.size()).toBeGreaterThan(200);
    expect(toolsSwept).toBe(h.registry.size()); // hcloud_raw_request included (B-020)
    expect(inspected).toBeGreaterThan(9000);
    expect(emitted).toBeGreaterThan(2000);
  });

  it("and through the MCP boundary, for every path parameter of every generated tool", async () => {
    const h = harness(false);
    const mcp = await connect(h.registry);
    let inspected = 0;
    try {
      for (const tool of h.registry.getAll()) {
        const op = OP_BY_TOOL.get(tool.name);
        if (!op) continue;
        const pathParams = op.parameters.filter((p) => p.in === "path");
        if (pathParams.length === 0) continue;
        for (const target of pathParams) {
          for (const payload of HOSTILE_STRINGS) {
            const args = { ...validArgs(tool), [target.name]: payload };
            const context = `${tool.name}.${target.name} = ${JSON.stringify(payload)}`;
            const before = h.urls.length;
            await mcp.call(tool.name, args);
            inspected++;
            for (const url of h.urls.slice(before)) {
              assertStableUnderOriginDecode(url, context);
            }
          }
        }
      }
    } finally {
      await mcp.close();
    }
    expect(inspected).toBeGreaterThan(2000);
  });

  it("exempts no tool, hcloud_raw_request included (B-020)", async () => {
    const h = harness(false);
    const exempt: string[] = [];
    for (const tool of h.registry.getAll()) {
      const before = h.urls.length;
      try {
        await tool.handler({ ...validArgs(tool), path: "/zones/..%2f..%2fssh_keys", id_or_name: "..%2fssh_keys" });
      } catch {
        /* a throw is a pass */
      }
      for (const url of h.urls.slice(before)) {
        try {
          assertStableUnderOriginDecode(url, tool.name);
        } catch {
          exempt.push(tool.name);
        }
      }
    }
    expect([...new Set(exempt)]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. The fix must not have cost anything: legitimate calls still go out.
// ---------------------------------------------------------------------------

describe("issue #54 - no false rejections", () => {
  it("real zone names and record labels reach exactly the expected URL", async () => {
    const cases: Array<[string, string]> = [
      ["example.com", "/v1/zones/example.com"],
      ["example.com.", "/v1/zones/example.com."],
      ["münchen.de", "/v1/zones/m%C3%BCnchen.de"],
      ["xn--mnchen-3ya.de", "/v1/zones/xn--mnchen-3ya.de"],
      ["EXAMPLE.COM", "/v1/zones/EXAMPLE.COM"],
      ["sub.deep.example.com", "/v1/zones/sub.deep.example.com"],
      ["12345", "/v1/zones/12345"],
      ["zone(1).example.com", "/v1/zones/zone(1).example.com"],
      ["a'b.example.com", "/v1/zones/a'b.example.com"],
    ];
    const h = harness(false);
    const mcp = await connect(h.registry);
    try {
      for (const [value, expected] of cases) {
        const before = h.urls.length;
        const res = await mcp.call("hcloud_get_zone", { id_or_name: value });
        expect(res.isError, `${value}: ${res.text}`).toBe(false);
        expect(h.urls.slice(before).map((u) => new URL(u).pathname), value).toEqual([expected]);
      }
      const labels: Array<[string, string]> = [
        ["www", "www"],
        ["@", "%40"],
        ["*", "*"],
        ["*.sub", "*.sub"],
        ["_dmarc", "_dmarc"],
        ["_acme-challenge", "_acme-challenge"],
      ];
      for (const [label, encoded] of labels) {
        const before = h.urls.length;
        const res = await mcp.call("hcloud_get_zone_rrset", {
          id_or_name: "example.com",
          rr_name: label,
          rr_type: "TXT",
        });
        expect(res.isError, `${label}: ${res.text}`).toBe(false);
        expect(h.urls.slice(before).map((u) => new URL(u).pathname), label).toEqual([
          `/v1/zones/example.com/rrsets/${encoded}/TXT`,
        ]);
      }
    } finally {
      await mcp.close();
    }
  });

  it("the legitimate server-action call still reaches its exact URL", async () => {
    const h = harness(false);
    const mcp = await connect(h.registry);
    try {
      const res = await mcp.call("hcloud_server_backup", { id: 42, enable: true, wait: false });
      expect(res.isError, res.text).toBe(false);
      expect(h.urls).toEqual([`${API_ORIGIN}/v1/servers/42/actions/enable_backup`]);
    } finally {
      await mcp.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. The regression the second fix round had to repair, end to end.
//
// Round 1 enforced `additionalProperties: false` and thereby rejected `wait` and
// `auto_paginate` on the tools that do not declare them, although the runtime has
// always discarded both. tests/validate-input.test.ts pins that at the schema
// level; this pins that a call carrying them still reaches the network.
// ---------------------------------------------------------------------------

describe("issue #54 - the control keys stay tolerated at the MCP boundary", () => {
  it("a call carrying wait/auto_paginate still reaches the network", async () => {
    const h = harness(false);
    const mcp = await connect(h.registry);
    try {
      const one = await mcp.call("hcloud_get_server_raw", { id: 42, wait: false });
      expect(one.isError, one.text).toBe(false);
      const two = await mcp.call("hcloud_list_servers_raw", { wait: false, auto_paginate: false });
      expect(two.isError, two.text).toBe(false);
      expect(h.urls.map((u) => new URL(u).pathname)).toEqual(["/v1/servers/42", "/v1/servers"]);
    } finally {
      await mcp.close();
    }
  });

  it("no tool in the registry rejects them as an unknown property", async () => {
    const h = harness(false);
    const mcp = await connect(h.registry);
    const offenders: string[] = [];
    try {
      for (const tool of h.registry.getAll()) {
        const props = propsOf(tool);
        if (props.wait && props.auto_paginate) continue; // declared: nothing to tolerate
        const args = { ...validArgs(tool), wait: false, auto_paginate: false };
        const res = await mcp.call(tool.name, args);
        if (/unknown property `(wait|auto_paginate)`/.test(res.text)) offenders.push(tool.name);
      }
    } finally {
      await mcp.close();
    }
    expect(offenders).toEqual([]);
  });
});
