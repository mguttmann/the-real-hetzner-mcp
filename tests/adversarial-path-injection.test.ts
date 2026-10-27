// Adversarial end-to-end verification for issue #54.
//
// Everything else in the suite tests one layer at a time with a stubbed
// collaborator. This file wires the REAL chain the way src/index.ts does -
// MCP Client -> InMemoryTransport -> createMcpServer -> registry (wrappers +
// all generated tools) -> real HetznerHttpClient -> spy fetch - and asserts on
// the only thing that actually matters: the URL that would hit the network.
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
const TOKEN = "super-secret-token";

/**
 * Endpoints the issue names as pivot targets. Asserted as path segments in
 * section 1d - a URL may mention them inside a percent-encoded value
 * (`/zones/1%2F..%2Fssh_keys`, one opaque segment), never as a segment of its
 * own (`/ssh_keys`).
 */
const FORBIDDEN_TARGETS = [
  "reset_password",
  "ssh_keys",
  "floating_ips",
  "set_rules",
  "unassign",
];

type Sent = { url: string; body: string | undefined; authorization: string | undefined };

type PropSchema = { type?: unknown; enum?: unknown[] };

/** A schema-valid placeholder for one declared property. */
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

/**
 * Minimal arguments that satisfy a tool's declared schema: every `required`
 * property filled with a valid placeholder and nothing else. Sweeps that go
 * through the MCP boundary must use this - passing a blanket
 * `{wait, auto_paginate, body}` to every tool produces `unknown property`
 * rejections that would mask a still-open path guard.
 */
function minimalArgs(tool: ToolDef): Record<string, unknown> {
  const schema = tool.inputSchema as {
    properties?: Record<string, PropSchema>;
    required?: unknown;
  };
  const properties = schema.properties ?? {};
  const args: Record<string, unknown> = {};
  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (typeof key !== "string") continue;
      const prop = properties[key];
      if (prop) args[key] = placeholder(prop);
    }
  }
  // Only when declared, and always off, so no follow-up page/poll request runs.
  if (properties.wait) args.wait = false;
  if (properties.auto_paginate) args.auto_paginate = false;
  return args;
}

/** The path segments of a URL, e.g. `/v1/servers/42` -> ["v1","servers","42"]. */
function segments(url: string): string[] {
  return new URL(url).pathname.split("/").slice(1);
}


/**
 * Mirrors the registration order and options of src/index.ts main(). Kept in
 * this file (rather than imported) because index.ts runs main() on import;
 * `covers every registered tool` below asserts the tool set stays in sync.
 */
function harness(confirmWrites: boolean) {
  const urls: string[] = [];
  const sent: Sent[] = [];
  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as Request).url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    urls.push(url);
    sent.push({
      url,
      body: typeof init?.body === "string" ? init.body : undefined,
      authorization: headers.authorization,
    });
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
  const limits = { maxItems: 50, maxPages: 2 };
  const actionPoll = {
    timeoutMs: 0,
    intervalMs: 0,
    sleep: async () => {},
    now: () => 0,
  };
  const actionDeps = { client, actionPoll };
  const registry = new ToolRegistry();
  const register = (tool: ToolDef) =>
    registry.register(withConfirmGuard(tool, confirmWrites));

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

  return { registry, urls, sent, fetchImpl };
}

async function connect(registry: ToolRegistry) {
  const server = createMcpServer(registry, createLogger("error"));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcp = new Client({ name: "adversary", version: "0" }, { capabilities: {} });
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
// 1. The exact payloads reproduced in issue #54, through the whole real chain.
// ---------------------------------------------------------------------------

/** Verbatim from the issue's reproduction, plus the authority-confusion pair. */
const REPRODUCED: string[] = [
  "42",
  ".", // segment collapse, not segment smuggling - see section 1c
  "",
  "42/actions/reset_password?",
  "42/actions/reset_password#",
  "1/../../floating_ips/9/actions/unassign?",
  "1/../../firewalls/1/actions/set_rules#",
  "42/../../ssh_keys#",
  "//evil.com/x",
  "\\evil.com",
];

/** Every hand-written sink that takes a caller-supplied resource id. */
const ID_SINKS: Array<{ tool: string; extra: Record<string, unknown> }> = [
  { tool: "hcloud_server_backup", extra: { enable: true } },
  { tool: "hcloud_server_power", extra: { op: "reboot" } },
  { tool: "hcloud_server_rescue", extra: { enable: true } },
  { tool: "hcloud_server_snapshot", extra: {} },
  { tool: "hcloud_server_change_type", extra: { server_type: "cx22" } },
  // image_id, not image: an undeclared key would make every case pass on
  // "unknown property" and stop isolating the id guard.
  { tool: "hcloud_server_rebuild", extra: { image_id: 42 } },
  { tool: "hcloud_wait_action", extra: {} },
];

describe("issue #54 - reproduced payloads through the real chain", () => {
  for (const { tool, extra } of ID_SINKS) {
    for (const [i, id] of REPRODUCED.entries()) {
      it(`${tool} rejects id #${i} ${JSON.stringify(id)} and issues no request`, async () => {
        const h = harness(false);
        const mcp = await connect(h.registry);
        try {
          const res = await mcp.call(tool, { id, ...extra });
          expect(res.isError).toBe(true);
          expect(h.fetchImpl).not.toHaveBeenCalled();
          expect(h.urls).toEqual([]);
          // The rejection must not echo the bearer token back to the caller.
          expect(res.text).not.toContain(TOKEN);
        } finally {
          await mcp.close();
        }
      });
    }
  }

  it("confirm:'YES' does not buy a bypass when HETZNER_CONFIRM_WRITES=true", async () => {
    const h = harness(true);
    const mcp = await connect(h.registry);
    try {
      for (const { tool, extra } of ID_SINKS) {
        for (const id of REPRODUCED) {
          const res = await mcp.call(tool, { id, ...extra, confirm: "YES" });
          expect(res.isError).toBe(true);
        }
      }
      expect(h.urls).toEqual([]);
    } finally {
      await mcp.close();
    }
  });

  it("the legitimate call still reaches exactly the intended URL", async () => {
    const h = harness(false);
    const mcp = await connect(h.registry);
    try {
      const res = await mcp.call("hcloud_server_backup", { id: 42, enable: true });
      expect(res.isError).toBe(false);
      expect(h.urls).toEqual([
        "https://api.hetzner.cloud/v1/servers/42/actions/enable_backup",
      ]);
    } finally {
      await mcp.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 1b. The wrappers that were deliberately NOT given an own id guard.
//
// apply_firewall_to_server (server_id -> body), server_get (id) and
// server_metrics (id) rely on schema validation in server.ts as their only
// guard. If layer (d) ever regresses, nothing else catches them - so pin the
// MCP boundary behaviour explicitly.
// ---------------------------------------------------------------------------

const SCHEMA_ONLY_SINKS: Array<{ tool: string; key: string; extra: Record<string, unknown> }> = [
  { tool: "hcloud_apply_firewall_to_server", key: "server_id", extra: { firewall_id: 11 } },
  { tool: "hcloud_apply_firewall_to_server", key: "firewall_id", extra: { server_id: 7 } },
  { tool: "hcloud_get_server", key: "id", extra: {} },
  { tool: "hcloud_get_server_metrics", key: "id", extra: { type: "cpu" } },
];

describe("issue #54 - wrappers guarded by schema validation alone", () => {
  for (const { tool, key, extra } of SCHEMA_ONLY_SINKS) {
    for (const bad of ["1/../../ssh_keys#", "1/actions/reset_password?", "1.5", 1.5, "7"]) {
      it(`${tool} rejects ${key}=${JSON.stringify(bad)} at the MCP boundary`, async () => {
        const h = harness(false);
        const mcp = await connect(h.registry);
        try {
          const res = await mcp.call(tool, { ...extra, [key]: bad });
          expect(res.isError).toBe(true);
          expect(res.text).toMatch(/^Invalid input for /);
          // Not even the firewall/server *lookup* request may go out.
          expect(h.urls).toEqual([]);
        } finally {
          await mcp.close();
        }
      });
    }
  }

  it("still lets the legitimate apply_firewall call through unchanged", async () => {
    const h = harness(false);
    const mcp = await connect(h.registry);
    try {
      const res = await mcp.call("hcloud_apply_firewall_to_server", {
        firewall_id: 11,
        server_id: 7,
      });
      expect(res.isError).toBe(false);
      expect(h.urls).toEqual([
        "https://api.hetzner.cloud/v1/firewalls/11/actions/apply_to_resources",
      ]);
      expect(JSON.parse(h.sent[0]!.body!)).toEqual({
        apply_to: [{ type: "server", server: { id: 7 } }],
      });
      // The privileged token goes to Hetzner and nowhere else.
      expect(h.sent[0]!.authorization).toBe(`Bearer ${TOKEN}`);
    } finally {
      await mcp.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 1c. Segment COLLAPSE - the other half of path injection.
//
// Adding a segment is not the only way to move a request: removing one works
// just as well. `encodeURIComponent(".") === "."` and `new URL` deletes "."
// segments, so a single dot in a string-typed path parameter turns
// /zones/{id_or_name}/actions into /zones/actions - which is a *different,
// separately granted* tool (hcloud_get_zones_actions). Where tools are granted by
// name, that is the same authorisation bypass as issue #54.
// ---------------------------------------------------------------------------

/**
 * Raw-path spellings the WHATWG URL parser collapses. Only the first three
 * survive `encodeURIComponent` unchanged, so only those can collapse a path when
 * they arrive as a tool *parameter* (PARAM_COLLAPSING); the percent-encoded ones
 * matter for `hcloud_raw_request`, which passes its path through unencoded.
 */
const PARAM_COLLAPSING: string[] = [".", "", ".."];
const COLLAPSING_PAYLOADS: string[] = [
  ...PARAM_COLLAPSING,
  "%2e",
  "%2E",
  ".%2e",
  "%2e%2e",
  "%2E%2E",
];

/** Payloads that may legitimately survive as ONE opaque segment. */
const OPAQUE_PAYLOADS: string[] = ["./", "/.", ".%2F.", "%2520", " ", "\t.", "..%2f..%2f"];

const COLLAPSE_SINKS: Array<{
  tool: string;
  key: string;
  extra: Record<string, unknown>;
  /** The endpoint the collapse would reach - a tool of its own. */
  wouldReach: string;
}> = [
  {
    tool: "hcloud_list_zone_actions",
    key: "id_or_name",
    extra: { auto_paginate: false },
    wouldReach: "/v1/zones/actions (== hcloud_get_zones_actions)",
  },
  {
    tool: "hcloud_get_zone_action",
    key: "id_or_name",
    extra: { action_id: 4711 },
    wouldReach: "/v1/zones/actions/4711 (== hcloud_get_zones_actions_id)",
  },
  { tool: "hcloud_get_zone", key: "id_or_name", extra: {}, wouldReach: "/v1/zones/" },
  { tool: "hcloud_get_zone_rrsets", key: "id_or_name", extra: {}, wouldReach: "/v1/zones/rrsets" },
  { tool: "hcloud_get_zone_zonefile", key: "id_or_name", extra: {}, wouldReach: "/v1/zones/zonefile" },
  { tool: "hcloud_delete_zone", key: "id_or_name", extra: {}, wouldReach: "DELETE /v1/zones/" },
  {
    tool: "hcloud_update_zone",
    key: "id_or_name",
    extra: { body: { ttl: 3600 } },
    wouldReach: "PUT /v1/zones/",
  },
  {
    tool: "hcloud_zone_rrset_set_records_action",
    key: "rr_name",
    extra: {
      id_or_name: "example.com",
      rr_type: "A",
      body: { records: [{ value: "1.2.3.4" }] },
      wait: false,
    },
    wouldReach: "/v1/zones/example.com/rrsets/A/actions/set_records",
  },
  {
    tool: "hcloud_delete_zone_rrset",
    key: "rr_name",
    extra: { id_or_name: "example.com", rr_type: "A" },
    wouldReach: "DELETE /v1/zones/example.com/rrsets/A",
  },
];

describe("issue #54 - a path parameter may not delete a path segment", () => {
  for (const { tool, key, extra, wouldReach } of COLLAPSE_SINKS) {
    for (const payload of PARAM_COLLAPSING) {
      it(`${tool} rejects ${key}=${JSON.stringify(payload)} instead of reaching ${wouldReach}`, async () => {
        const h = harness(false);
        const mcp = await connect(h.registry);
        try {
          const res = await mcp.call(tool, { ...extra, [key]: payload });
          expect(res.isError).toBe(true);
          expect(h.urls).toEqual([]);
          // Isolation: the rejection must come from the path guard, not from a
          // missing/unknown property that would mask a still-open collapse.
          expect(res.text).not.toMatch(/missing required property|unknown property/);
          expect(res.text).not.toContain(TOKEN);
        } finally {
          await mcp.close();
        }
      });
    }
  }

  it("rejects percent-encoded separator/dot spellings outright", async () => {
    // encodeURIComponent escapes the "%" itself, so at the parameter layer these
    // cannot become dot segments *for the URL parser*. They are refused anyway,
    // because the guard must not depend on assumptions about how the origin
    // decodes: a value that spells a separator has no legitimate use in a slot.
    const h = harness(false);
    const mcp = await connect(h.registry);
    try {
      for (const payload of ["%2e", "%2E", ".%2e", "%2e%2e", "%2E%2E", "..%2f..%2f", "%5c.."]) {
        const before = h.urls.length;
        const res = await mcp.call("hcloud_get_zone_rrsets", { id_or_name: payload });
        expect(res.isError, `${payload} was accepted`).toBe(true);
        expect(h.urls.slice(before), payload).toEqual([]);
        expect(res.text, payload).not.toMatch(/missing required property|unknown property/);
      }
      // Not over-blocking: a double-encoded value spells no separator (the "%" is
      // escaped a second time) and still travels as exactly one opaque segment.
      const before = h.urls.length;
      const ok = await mcp.call("hcloud_get_zone_rrsets", { id_or_name: "%252e%252e" });
      expect(ok.isError).toBe(false);
      expect(h.urls.slice(before)).toEqual([
        "https://api.hetzner.cloud/v1/zones/%25252e%25252e/rrsets",
      ]);
    } finally {
      await mcp.close();
    }
  });

  it("still sends the legitimate zone calls to exactly the intended URL", async () => {
    const h = harness(false);
    const mcp = await connect(h.registry);
    try {
      expect((await mcp.call("hcloud_get_zone", { id_or_name: "example.com" })).isError).toBe(false);
      expect(
        (
          await mcp.call("hcloud_zone_rrset_set_records_action", {
            id_or_name: "example.com",
            rr_name: "www",
            rr_type: "A",
            body: { records: [{ value: "1.2.3.4" }] },
            wait: false,
          })
        ).isError,
      ).toBe(false);
      expect(h.urls).toEqual([
        "https://api.hetzner.cloud/v1/zones/example.com",
        "https://api.hetzner.cloud/v1/zones/example.com/rrsets/www/A/actions/set_records",
      ]);
    } finally {
      await mcp.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 1d. The climb the ORIGIN performs for you.
//
// Sections 1a-1c cover values that `new URL` itself would move. The string-typed
// path parameters (`id_or_name`, `rr_name`) need one step more: encodeURIComponent
// turns a caller's raw "/" into "%2F", so as far as this process can tell the value
// stays in its slot - but the actor that resolves the path is the origin, and the
// Hetzner API decodes "%2f" and collapses ".." before routing, so a value that is
// one opaque segment to this process can name a different route at the origin,
// and one grant of a tool would reach endpoints of other tools. Nothing that
// fills a single path slot may carry a separator, in any spelling.
// ---------------------------------------------------------------------------

const ORIGIN_CLIMB_PAYLOADS: string[] = [
  "../servers/42",
  "..%2Fservers%2F42",
  "..%2fservers%2f42",
  "../ssh_keys",
  "../../ssh_keys",
  "..\\servers",
  "..%5Cservers",
  "%2e%2e%2fservers",
  "1/../../ssh_keys",
  "servers/42", // no climb needed where the slot is the last segment
  "42/actions/change_protection",
];

describe("issue #54 - a string path parameter may not climb out of its slot", () => {
  it("rejects every climb payload at the MCP boundary, on every zone tool", async () => {
    const h = harness(true); // confirm mode on: `confirm` must buy no bypass
    const mcp = await connect(h.registry);
    let checked = 0;
    try {
      for (const { tool, key, extra } of COLLAPSE_SINKS) {
        for (const payload of ORIGIN_CLIMB_PAYLOADS) {
          const context = `${tool}.${key} = ${JSON.stringify(payload)}`;
          const before = h.urls.length;
          const res = await mcp.call(tool, { ...extra, [key]: payload, confirm: "YES" });
          checked++;
          expect(res.isError, `${context}: accepted`).toBe(true);
          expect(h.urls.slice(before), `${context}: reached the network`).toEqual([]);
          // Isolation: the rejection is about the payload, not about the
          // arguments this test supplied.
          expect(res.text, `${context}: masked by another error`).not.toMatch(
            /missing required property|unknown property/,
          );
          expect(res.text, `${context}: leaked the token`).not.toContain(TOKEN);
        }
      }
    } finally {
      await mcp.close();
    }
    expect(checked).toBe(COLLAPSE_SINKS.length * ORIGIN_CLIMB_PAYLOADS.length);
    expect(h.urls).toEqual([]);
  });

  it("rejects them at the handler boundary too (schema layer removed)", async () => {
    const h = harness(false);
    for (const { tool, key, extra } of COLLAPSE_SINKS) {
      const def = h.registry.getByName(tool);
      expect(def, tool).toBeDefined();
      for (const payload of ORIGIN_CLIMB_PAYLOADS) {
        const before = h.urls.length;
        try {
          await def!.handler({ ...extra, [key]: payload, wait: false, auto_paginate: false });
        } catch {
          // A loud throw is a pass; only what reached fetch is under test.
        }
        expect(
          h.urls.slice(before),
          `${tool}.${key} = ${JSON.stringify(payload)}: reached the network`,
        ).toEqual([]);
      }
    }
    expect(h.urls).toEqual([]);
  });

  it("the three write/read pivots from the report specifically", async () => {
    // Named one by one so a regression is reported in the vocabulary of the
    // finding: these are the tools whose parameter is the LAST path segment, i.e.
    // an arbitrary GET/PUT/DELETE target for the privileged token.
    const h = harness(false);
    const mcp = await connect(h.registry);
    try {
      const del = await mcp.call("hcloud_delete_zone", { id_or_name: "../servers/42" });
      const put = await mcp.call("hcloud_update_zone", {
        id_or_name: "../servers/42",
        body: { ttl: 3600 },
      });
      const get = await mcp.call("hcloud_get_zone", { id_or_name: "../ssh_keys" });
      for (const res of [del, put, get]) expect(res.isError).toBe(true);
      expect(h.urls).toEqual([]);
      // …while the legitimate call on the very same tool still goes out.
      const ok = await mcp.call("hcloud_delete_zone", { id_or_name: "example.com" });
      expect(ok.isError, ok.text).toBe(false);
      expect(h.urls).toEqual(["https://api.hetzner.cloud/v1/zones/example.com"]);
    } finally {
      await mcp.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Registry-wide sweep at the HANDLER boundary.
//
// This deliberately skips the MCP layer, i.e. it removes defence layer (d)
// (schema validation in server.ts) from the picture and proves that encoding
// (b) plus the client-side path assertions (c) hold on their own - a guard
// that only works because a second guard runs first is not a guard.
// ---------------------------------------------------------------------------

const MARK = "pwn3d";

/** Each payload tries to smuggle an extra `/MARK` path segment into the URL. */
const SMUGGLE_PAYLOADS: string[] = [
  `1/${MARK}`,
  `1/${MARK}?x=1`,
  `1/${MARK}#frag`,
  `1/../../${MARK}`,
  `../${MARK}`,
  `//${MARK}.example.com/x`,
  `\\${MARK}.example.com`,
  `1/%2e%2e/%2e%2e/${MARK}`,
  `1/%2E%2E/%2E%2E/${MARK}`,
  `1/.%2e/.%2e/${MARK}`,
  `1/\t../\t../${MARK}`,
  `1/\n../\r../${MARK}`,
  `1/..%2f..%2f${MARK}`,
];

function assertNoSmuggledSegment(url: string, context: string): void {
  const parsed = new URL(url);
  expect(parsed.origin, `${context}: origin escaped`).toBe("https://api.hetzner.cloud");
  expect(parsed.pathname.startsWith("/v1/"), `${context}: left the /v1 base path`).toBe(
    true,
  );
  // The payload may only survive as ONE opaque, percent-encoded segment.
  expect(parsed.pathname, `${context}: payload became its own path segment`).not.toContain(
    `/${MARK}`,
  );
  expect(parsed.pathname, `${context}: unencoded dot-segment reached the URL`).not.toContain(
    "/../",
  );
  // A payload landing in a query *value* is fine and expected (e.g. ?name=...)
  // as long as it stays percent-encoded: `1%2Fpwn3d` is one opaque value,
  // `/pwn3d` or `&pwn3d=` would mean the payload reshaped the query itself.
  expect(parsed.search, `${context}: unencoded separator in the query string`).not.toContain(
    `/${MARK}`,
  );
  expect(parsed.search, `${context}: payload injected its own query parameter`).not.toMatch(
    new RegExp(`[?&]${MARK}`),
  );
  expect(parsed.hash, `${context}: payload leaked into a fragment`).toBe("");
}

const OP_BY_TOOL = new Map<string, OperationDef>(OPERATIONS.map((op) => [op.toolName, op]));

/**
 * Structural invariant assertNoSmuggledSegment cannot express: the request path
 * must have exactly the segments its operation template has - none added, and
 * none collapsed away. Every literal segment keeps its position, and every
 * parameter slot is still filled.
 */
function assertPathShape(url: string, template: string, context: string): void {
  const parsed = new URL(url);
  expect(parsed.origin, `${context}: origin escaped`).toBe("https://api.hetzner.cloud");
  const actual = parsed.pathname.split("/").slice(1);
  const expected = `/v1${template}`.split("/").slice(1);
  expect(
    actual.length,
    `${context}: segment count changed (${parsed.pathname} vs /v1${template})`,
  ).toBe(expected.length);
  for (const [i, segment] of expected.entries()) {
    if (segment.startsWith("{")) {
      expect(actual[i], `${context}: parameter slot ${i} is empty (${parsed.pathname})`).not.toBe("");
    } else {
      expect(actual[i], `${context}: literal segment "${segment}" moved (${parsed.pathname})`).toBe(
        segment,
      );
    }
  }
}

describe("issue #54 - registry-wide segment-collapse sweep", () => {
  it("the shape invariant sees deletions, additions and empty slots (self-test)", () => {
    const template = "/zones/{id_or_name}/actions";
    // Positive control.
    assertPathShape("https://api.hetzner.cloud/v1/zones/example.com/actions", template, "ok");
    // A collapsed segment - the exact bypass this file exists for.
    expect(() =>
      assertPathShape("https://api.hetzner.cloud/v1/zones/actions", template, "collapsed"),
    ).toThrow();
    // An added segment.
    expect(() =>
      assertPathShape("https://api.hetzner.cloud/v1/zones/1/pwn3d/actions", template, "added"),
    ).toThrow();
    // An emptied parameter slot.
    expect(() =>
      assertPathShape("https://api.hetzner.cloud/v1/zones//actions", template, "empty"),
    ).toThrow();
    // A literal segment swapped for something else.
    expect(() =>
      assertPathShape("https://api.hetzner.cloud/v1/ssh_keys/1/actions", template, "moved"),
    ).toThrow();
  });

  it("no path parameter of any generated tool can collapse or move a segment", async () => {
    const h = harness(false);
    let collapsing = 0;
    let opaque = 0;

    for (const tool of h.registry.getAll()) {
      const op = OP_BY_TOOL.get(tool.name);
      if (!op) continue;
      const pathParams = op.parameters.filter((p) => p.in === "path").map((p) => p.name);
      if (pathParams.length === 0) continue;

      for (const target of pathParams) {
        for (const payload of [...COLLAPSING_PAYLOADS, ...OPAQUE_PAYLOADS]) {
          const args: Record<string, unknown> = { wait: false, auto_paginate: false, body: {} };
          for (const name of pathParams) args[name] = name === target ? payload : "1";
          const context = `${tool.name}.${target} = ${JSON.stringify(payload)}`;
          const before = h.urls.length;
          try {
            await tool.handler(args);
          } catch {
            // Rejected loudly by the client guard - nothing left to check.
          }
          const sent = h.urls.slice(before);
          if (PARAM_COLLAPSING.includes(payload)) {
            // These reach the client verbatim (encodeURIComponent leaves ".",
            // ".." and "" alone), so they must never produce a request at all.
            collapsing++;
            expect(sent, `${context}: a collapsing payload reached the network`).toEqual([]);
          } else {
            // The rest may pass, but only as one opaque segment in the right slot.
            opaque++;
            for (const url of sent) assertPathShape(url, op.path, context);
          }
        }
      }
    }

    // Guard against the sweep degenerating into a no-op.
    expect(collapsing).toBeGreaterThan(400);
    expect(opaque).toBeGreaterThan(1500);
  });
});

describe("issue #54 - registry-wide path-smuggling sweep", () => {
  it("covers every registered tool (guards against new unswept sinks)", () => {
    const { registry } = harness(false);
    // 189 generated + 12 hand-written + raw_request; a change here means a new
    // sink was added and this sweep must be re-read, not just re-run.
    expect(registry.size()).toBe(OPERATIONS.length + 12);
    expect(registry.getByName("hcloud_raw_request")).toBeDefined();
  });

  it("no top-level argument of any tool can add a path segment", async () => {
    const h = harness(false);
    const tools = h.registry.getAll();
    let injections = 0;

    for (const tool of tools) {
      const properties = (tool.inputSchema as { properties?: Record<string, unknown> })
        .properties;
      if (!properties) continue;
      for (const prop of Object.keys(properties)) {
        // `path` on the escape hatch is arbitrary by contract; asserted separately.
        if (tool.name === "hcloud_raw_request" && prop === "path") continue;
        for (const payload of SMUGGLE_PAYLOADS) {
          const before = h.urls.length;
          try {
            await tool.handler({
              wait: false,
              auto_paginate: false,
              body: {},
              confirm: "YES",
              [prop]: payload,
            });
          } catch {
            // Rejected loudly (assertSafePath / programming-error guard) - the
            // only thing under test is what reached fetch.
          }
          injections++;
          for (const url of h.urls.slice(before)) {
            assertNoSmuggledSegment(url, `${tool.name}.${prop} = ${JSON.stringify(payload)}`);
          }
        }
      }
    }

    // Guard against the sweep silently degenerating into a no-op.
    expect(injections).toBeGreaterThan(2000);
  });

  it("the escape hatch sends the caller's path verbatim or not at all", async () => {
    const h = harness(false);
    const mcp = await connect(h.registry);
    try {
      const sentFor = new Map<string, string[]>();
      for (const payload of [...SMUGGLE_PAYLOADS, ...COLLAPSING_PAYLOADS, ...OPAQUE_PAYLOADS]) {
        const before = h.urls.length;
        await mcp.call("hcloud_raw_request", { method: "GET", path: `/${payload}` });
        sentFor.set(payload, h.urls.slice(before));
      }
      // raw_request takes an arbitrary path by contract, so "rejected" is not
      // required - but whatever goes out must be byte-for-byte the path the
      // caller asked for. Any URL-parser rewriting (a removed dot segment, a
      // stripped tab, a decoded %2e) means the request would land somewhere the
      // caller's own path does not name, and that never leaves the process.
      for (const [payload, urls] of sentFor) {
        for (const url of urls) {
          expect(new URL(url).pathname, `path=/${payload} was rewritten`).toBe(`/v1/${payload}`);
        }
      }
      // And the traversal payloads specifically must not have been sent at all.
      for (const payload of COLLAPSING_PAYLOADS) {
        expect(sentFor.get(payload), `path=/${payload}`).toEqual([]);
      }
      expect(sentFor.get(`1/${MARK}`)).toEqual([
        `https://api.hetzner.cloud/v1/1/${MARK}`,
      ]);
    } finally {
      await mcp.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. The reported IMPACT, asserted instead of described.
//
// Everything above asserts *structure*: segment counts, no `/pwn3d`, no moved
// literal. None of it asserts the sentence the issue actually makes - "whoever
// is granted only hcloud_server_backup can trigger reset_password, POST
// /ssh_keys, firewalls/{id}/actions/set_rules". This section asserts exactly
// that, with the endpoint names from the issue rather than a synthetic marker,
// so a regression is reported in the vocabulary of the vulnerability.
// ---------------------------------------------------------------------------

/** The pivots from the issue's reproduction, in every spelling the fix rejects. */
const PIVOT_PAYLOADS: string[] = [
  "1/actions/reset_password?",
  "1/actions/reset_password#",
  "1/../../ssh_keys?",
  "1/../../ssh_keys#",
  "1/../../floating_ips/9/actions/unassign?",
  "1/../../firewalls/1/actions/set_rules#",
  "1/%2e%2e/%2e%2e/ssh_keys",
  "1/%2E%2E/%2E%2E/ssh_keys",
  "1/.%2e/.%2e/ssh_keys",
  "1/\t../\t../ssh_keys",
  "../../ssh_keys",
];

/**
 * No path segment of `url` may be one of the pivot targets. A target appearing
 * *inside* a percent-encoded segment is fine and expected - `%2Fssh_keys` is
 * part of one opaque value the origin will 404, not a request for /ssh_keys.
 */
function assertNoForbiddenPivot(url: string, context: string): void {
  for (const segment of segments(url)) {
    expect(
      FORBIDDEN_TARGETS.includes(segment),
      `${context}: reached the pivot target "${segment}" (${new URL(url).pathname})`,
    ).toBe(false);
  }
}

/**
 * The hand-written wrappers plus the schema-only ones: not one of them
 * legitimately touches any FORBIDDEN_TARGETS endpoint (server_rescue's
 * `ssh_keys` goes into the request *body*), so for these the assertion is
 * absolute - no exemptions to get wrong.
 */
const WRAPPER_PIVOT_CASES: Array<{ tool: string; key: string; extra: Record<string, unknown> }> = [
  ...ID_SINKS.map(({ tool, extra }) => ({ tool, key: "id", extra })),
  ...SCHEMA_ONLY_SINKS,
];

describe("issue #54 - no tool may reach another endpoint's resource or action", () => {
  it("hand-written wrappers: no pivot target, at the MCP boundary", async () => {
    const h = harness(true);
    const mcp = await connect(h.registry);
    let checked = 0;
    try {
      for (const { tool, key, extra } of WRAPPER_PIVOT_CASES) {
        for (const payload of PIVOT_PAYLOADS) {
          const before = h.urls.length;
          const res = await mcp.call(tool, { ...extra, [key]: payload, confirm: "YES" });
          checked++;
          expect(res.isError, `${tool}.${key}=${JSON.stringify(payload)} was accepted`).toBe(true);
          expect(h.urls.slice(before), `${tool}.${key}=${JSON.stringify(payload)}`).toEqual([]);
        }
      }
    } finally {
      await mcp.close();
    }
    expect(checked).toBe(WRAPPER_PIVOT_CASES.length * PIVOT_PAYLOADS.length);
    expect(h.urls).toEqual([]);
  });

  it("hand-written wrappers: no pivot target at the HANDLER boundary either", async () => {
    // Same payloads with schema validation removed from the picture, so the
    // wrappers' own id guard and the client guard have to carry it alone.
    const h = harness(false);
    for (const { tool, key, extra } of WRAPPER_PIVOT_CASES) {
      const def = h.registry.getByName(tool);
      expect(def, tool).toBeDefined();
      for (const payload of PIVOT_PAYLOADS) {
        const before = h.urls.length;
        try {
          await def!.handler({ ...extra, [key]: payload });
        } catch {
          // A loud throw is a pass; only what reached fetch is under test.
        }
        for (const url of h.urls.slice(before)) {
          assertNoForbiddenPivot(url, `${tool}.${key} = ${JSON.stringify(payload)}`);
        }
      }
    }
  });

  it("every generated tool: no path parameter reaches a foreign endpoint", async () => {
    const h = harness(false);
    let checked = 0;
    for (const tool of h.registry.getAll()) {
      const op = OP_BY_TOOL.get(tool.name);
      if (!op) continue;
      const pathParams = op.parameters.filter((p) => p.in === "path").map((p) => p.name);
      if (pathParams.length === 0) continue;
      // A tool whose own template names a target (hcloud_list_ssh_keys,
      // hcloud_server_reset_password_action, …) is exempt for that target only.
      const exempt = FORBIDDEN_TARGETS.filter((t) => op.path.includes(t));
      for (const target of pathParams) {
        for (const payload of PIVOT_PAYLOADS) {
          const args: Record<string, unknown> = { wait: false, auto_paginate: false, body: {} };
          for (const name of pathParams) args[name] = name === target ? payload : "1";
          const before = h.urls.length;
          try {
            await tool.handler(args);
          } catch {
            // Loud rejection - nothing reached the network.
          }
          checked++;
          for (const url of h.urls.slice(before)) {
            const context = `${tool.name}.${target} = ${JSON.stringify(payload)}`;
            for (const segment of segments(url)) {
              if (exempt.includes(segment)) continue;
              expect(
                FORBIDDEN_TARGETS.includes(segment),
                `${context}: reached the pivot target "${segment}" (${new URL(url).pathname})`,
              ).toBe(false);
            }
            // And the payload must still sit in its own slot.
            assertPathShape(url, op.path, context);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1500);
  });
});

// ---------------------------------------------------------------------------
// 4. Registry-wide sweep at the MCP boundary.
//
// Section 2 sweeps the handler boundary on purpose (layer (d) removed). That
// leaves the full stack - schema validation *and* encoding *and* the client
// guard, in the order the gateway actually hits them - asserted for nine
// hand-picked tools only. This sweeps all 177 path parameters of every
// generated tool through the real MCP round trip, with per-tool minimal args so
// no rejection can come from a missing or unknown property.
// ---------------------------------------------------------------------------

describe("issue #54 - registry-wide sweep through the MCP boundary", () => {
  it("every path parameter of every generated tool, full stack", async () => {
    const h = harness(false);
    const mcp = await connect(h.registry);
    let rejected = 0;
    let opaque = 0;
    try {
      for (const tool of h.registry.getAll()) {
        const op = OP_BY_TOOL.get(tool.name);
        if (!op) continue;
        const pathParams = op.parameters.filter((p) => p.in === "path").map((p) => p.name);
        if (pathParams.length === 0) continue;
        for (const target of pathParams) {
          for (const payload of [...PARAM_COLLAPSING, "1/../../ssh_keys#", "1/actions/reset_password?"]) {
            const args = { ...minimalArgs(tool), [target]: payload };
            const context = `${tool.name}.${target} = ${JSON.stringify(payload)}`;
            const before = h.urls.length;
            const res = await mcp.call(tool.name, args);
            const sent = h.urls.slice(before);
            // Isolation: a rejection must be about the payload, never about the
            // arguments the sweep itself supplied.
            expect(res.text, `${context}: sweep supplied bad arguments`).not.toMatch(
              /missing required property|unknown property/,
            );
            if (PARAM_COLLAPSING.includes(payload)) {
              // Collapsing spellings survive encodeURIComponent, so nothing may
              // go out at all.
              rejected++;
              expect(res.isError, `${context}: accepted`).toBe(true);
              expect(sent, `${context}: a collapsing payload reached the network`).toEqual([]);
            } else {
              opaque++;
              for (const url of sent) {
                assertPathShape(url, op.path, context);
                assertNoForbiddenPivot(url, context);
              }
            }
          }
        }
      }
    } finally {
      await mcp.close();
    }
    // Lower bounds so the sweep cannot degenerate into a no-op.
    expect(rejected).toBeGreaterThan(500);
    expect(opaque).toBeGreaterThan(300);
  });
});

// ---------------------------------------------------------------------------
// 5. Payloads outside the fix's own vocabulary.
//
// Sections 1-4 use the spellings the fix was written against, which makes them
// good regression tests and weak evidence that the guard generalises. These are
// chosen independently: alternative encodings, RFC 3986 sub-delimiters, Unicode
// solidus look-alikes, authority confusion, control characters and length.
// ---------------------------------------------------------------------------

const NOVEL_PAYLOADS: string[] = [
  "%252e%252e", // double-encoded traversal
  "%252E%252E%252F",
  "1;/../ssh_keys", // ";" is a sub-delim, not a separator
  "..;",
  "1/..;/ssh_keys",
  "1%00/../ssh_keys",
  "1 /../ssh_keys",
  "／..／ssh_keys", // U+FF0F fullwidth solidus
  "1⁄..⁄ssh_keys", // U+2044 fraction slash
  "1∕..∕ssh_keys", // U+2215 division slash
  "http://evil.com",
  "https://evil.com/x",
  "//evil.com",
  "///evil.com",
  ":evil.com",
  "1@evil.com",
  "evil.com:8080",
  "%2f..%2f..%2fssh_keys",
  "%2F%2E%2E%2Fssh_keys",
  "1/%5c../ssh_keys",
  "1K", // U+212A Kelvin sign - case-folding probe
  "İ", // U+0130 - normalisation probe
  ".%00.",
  ". .",
  "1/.​./ssh_keys", // zero-width space between the dots
  "..%00",
  "1/..%09/ssh_keys",
  "1/..%0a/ssh_keys",
  "x".repeat(5000),
  "../../../../../../ssh_keys",
  "1/../../pricing",
];

describe("issue #54 - payloads the fix was not written against", () => {
  it("none reshapes any generated tool's path (handler boundary)", async () => {
    const h = harness(false);
    let checked = 0;
    for (const tool of h.registry.getAll()) {
      const op = OP_BY_TOOL.get(tool.name);
      if (!op) continue;
      const pathParams = op.parameters.filter((p) => p.in === "path").map((p) => p.name);
      if (pathParams.length === 0) continue;
      const exempt = FORBIDDEN_TARGETS.filter((t) => op.path.includes(t));
      for (const target of pathParams) {
        for (const payload of NOVEL_PAYLOADS) {
          const args: Record<string, unknown> = { wait: false, auto_paginate: false, body: {} };
          for (const name of pathParams) args[name] = name === target ? payload : "1";
          const context = `${tool.name}.${target} = ${JSON.stringify(payload)}`;
          const before = h.urls.length;
          try {
            await tool.handler(args);
          } catch {
            // Loud rejection is a pass.
          }
          checked++;
          for (const url of h.urls.slice(before)) {
            assertPathShape(url, op.path, context);
            expect(new URL(url).hash, `${context}: leaked into a fragment`).toBe("");
            for (const segment of segments(url)) {
              if (exempt.includes(segment)) continue;
              expect(
                FORBIDDEN_TARGETS.includes(segment),
                `${context}: reached the pivot target "${segment}"`,
              ).toBe(false);
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(4000);
  });

  it("none is accepted by any id sink (MCP boundary)", async () => {
    const h = harness(true);
    const mcp = await connect(h.registry);
    try {
      for (const { tool, key, extra } of WRAPPER_PIVOT_CASES) {
        for (const payload of NOVEL_PAYLOADS) {
          const context = `${tool}.${key} = ${JSON.stringify(payload)}`;
          const before = h.urls.length;
          const res = await mcp.call(tool, { ...extra, [key]: payload, confirm: "YES" });
          expect(res.isError, `${context}: accepted`).toBe(true);
          expect(h.urls.slice(before), context).toEqual([]);
        }
      }
    } finally {
      await mcp.close();
    }
    expect(h.urls).toEqual([]);
  });

  it("the escape hatch still sends them verbatim or not at all", async () => {
    const h = harness(false);
    const mcp = await connect(h.registry);
    try {
      for (const payload of NOVEL_PAYLOADS) {
        const path = `/${payload}`;
        const before = h.urls.length;
        await mcp.call("hcloud_raw_request", { method: "GET", path });
        for (const url of h.urls.slice(before)) {
          expect(new URL(url).pathname, `${JSON.stringify(path)} was rewritten`).toBe(`/v1${path}`);
        }
      }
    } finally {
      await mcp.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 6. The other failure mode: FALSE rejections.
//
// A guard that rejects a genuine zone name or record label is an outage, and
// every assertion above would still pass - they only ever demand that hostile
// input be refused. DNS identifiers are the exposed case: unlike the numeric
// ids they are free-form strings that legitimately contain non-ASCII, "_", "*",
// "@", "'", "(" and a trailing dot.
// ---------------------------------------------------------------------------

describe("issue #54 - the guard must not reject legitimate identifiers", () => {
  /** Real Hetzner DNS zone names, with the URL each has to produce. */
  const LEGITIMATE_ZONES: Array<[string, string]> = [
    ["example.com", "/v1/zones/example.com"],
    ["münchen.de", "/v1/zones/m%C3%BCnchen.de"], // IDN, unencoded by the caller
    ["xn--mnchen-3ya.de", "/v1/zones/xn--mnchen-3ya.de"], // the punycode form
    ["example.com.", "/v1/zones/example.com."], // fully-qualified trailing dot
    ["EXAMPLE.COM", "/v1/zones/EXAMPLE.COM"], // case must survive
    ["a'b.example.com", "/v1/zones/a'b.example.com"], // sub-delim, valid pchar
    ["zone(1).example.com", "/v1/zones/zone(1).example.com"],
    ["sub.domain.example.com", "/v1/zones/sub.domain.example.com"],
  ];

  /** Record labels that must reach the rrsets endpoint unchanged. */
  const LEGITIMATE_LABELS: Array<[string, string]> = [
    ["www", "/v1/zones/example.com/rrsets/www/A"],
    // The apex label: %40 is the correct wire form, and it must be encoded
    // rather than dropped or passed through raw.
    ["@", "/v1/zones/example.com/rrsets/%40/A"],
    ["*", "/v1/zones/example.com/rrsets/*/A"], // wildcard
    ["*.sub", "/v1/zones/example.com/rrsets/*.sub/A"],
    ["_dmarc", "/v1/zones/example.com/rrsets/_dmarc/A"],
    ["_acme-challenge", "/v1/zones/example.com/rrsets/_acme-challenge/A"],
    ["sub.domain", "/v1/zones/example.com/rrsets/sub.domain/A"],
  ];

  it("sends every legitimate zone name to exactly the expected URL", async () => {
    const h = harness(false);
    const mcp = await connect(h.registry);
    try {
      for (const [zone, expected] of LEGITIMATE_ZONES) {
        const before = h.urls.length;
        const res = await mcp.call("hcloud_get_zone", { id_or_name: zone });
        expect(res.isError, `${JSON.stringify(zone)} was rejected: ${res.text}`).toBe(false);
        expect(h.urls.slice(before), JSON.stringify(zone)).toEqual([
          `https://api.hetzner.cloud${expected}`,
        ]);
      }
    } finally {
      await mcp.close();
    }
  });

  it("sends every legitimate record label to exactly the expected URL", async () => {
    const h = harness(false);
    const mcp = await connect(h.registry);
    try {
      for (const [label, expected] of LEGITIMATE_LABELS) {
        const before = h.urls.length;
        const res = await mcp.call("hcloud_get_zone_rrset", {
          id_or_name: "example.com",
          rr_name: label,
          rr_type: "A",
        });
        expect(res.isError, `${JSON.stringify(label)} was rejected: ${res.text}`).toBe(false);
        expect(h.urls.slice(before), JSON.stringify(label)).toEqual([
          `https://api.hetzner.cloud${expected}`,
        ]);
      }
    } finally {
      await mcp.close();
    }
  });

  it("accepts the full declared range of numeric ids", async () => {
    // `maximum` in the generated schemas is 2^53-1, so isResourceId must accept
    // the whole range - an off-by-one there silently breaks the largest ids.
    const h = harness(false);
    const mcp = await connect(h.registry);
    try {
      for (const id of [1, 42, Number.MAX_SAFE_INTEGER]) {
        const before = h.urls.length;
        const res = await mcp.call("hcloud_get_certificate", { id });
        expect(res.isError, `id=${id} was rejected: ${res.text}`).toBe(false);
        expect(h.urls.slice(before), `id=${id}`).toEqual([
          `https://api.hetzner.cloud/v1/certificates/${id}`,
        ]);
        // The hand-written server wrapper takes the same id through its own
        // guard; the stub body makes it report "not found", so assert the URL.
        const beforeServer = h.urls.length;
        await mcp.call("hcloud_server_backup", { id, enable: true, wait: false });
        expect(h.urls.slice(beforeServer), `server id=${id}`).toEqual([
          `https://api.hetzner.cloud/v1/servers/${id}/actions/enable_backup`,
        ]);
      }
    } finally {
      await mcp.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 7. The EXACT-URL oracle.
//
// Everything above asserts a *shape*: right segment count, literals in place,
// no slot emptied, no forbidden segment. That is necessary but not sufficient -
// it cannot see a payload that gets rewritten *inside* its own slot. If a future
// change decoded one level of escaping, `%252e` would become `%2e` and
// `..%252f..%252f` would become `..%2f..%2f`: same segment count, same literals,
// same non-empty slots, every assertion above still green - and a request that
// addresses a different resource than the caller named, with origins that
// decode `%2f` reachable again.
//
// So this section drops the shape heuristic and states the whole invariant:
// there is exactly ONE pathname a request may have, and it is the operation
// template with `encodeURIComponent(String(value))` in each slot. Anything else,
// including "no request at all", is the only alternative.
// ---------------------------------------------------------------------------

/** The single pathname a request for `template` with these values may have. */
function onlyLegalPathname(template: string, values: Record<string, unknown>): string {
  return (
    "/v1" +
    template.replace(/\{([^}]+)\}/g, (_, name: string) =>
      encodeURIComponent(String(values[name])),
    )
  );
}

/**
 * Independent of any payload list: true when a value cannot be made safe by
 * encoding, so the only correct answer is no request at all. Two ways that
 * happens, both derived from the payload itself rather than from a list someone
 * has to remember to extend:
 *
 * 1. `encodeURIComponent` is a no-op on it (so the value reaches the client
 *    verbatim) *and* the WHATWG parser removes it from a path - `.` and `..`.
 * 2. it is empty, which the parser does NOT collapse: `/zones//actions` stays
 *    two slashes, and it is the *origin* that normalises it to some other
 *    resource. That makes an empty slot at least as dangerous as a removed one,
 *    and a parser-only definition would miss it entirely.
 */
function collapsesAPath(payload: string): boolean {
  try {
    if (encodeURIComponent(payload) !== payload) return false;
    if (payload === "") return true;
    const probe = `https://h.invalid/v1/a/${payload}/b`;
    return new URL(probe).pathname !== `/v1/a/${payload}/b`;
  } catch {
    return false;
  }
}

/**
 * True when encoding cannot keep the value inside its slot *at the origin*.
 * Derived from the payload rather than from a list: take what the wire actually
 * carries (`encodeURIComponent`), undo the one level of percent-decoding a router
 * performs before matching a route - the Hetzner API does exactly this, measured -
 * and see whether more than one segment, or a dot segment, appears.
 *
 * This is the invariant the shape and exact-URL oracles cannot express: they both
 * accept `/v1/zones/..%2Fservers%2F42` as "one opaque segment in the right slot",
 * and it is not - the origin routes it to /v1/servers/42.
 */
function escapesOneSegment(payload: string): boolean {
  const onWire = encodeURIComponent(payload);
  const asOriginSeesIt = onWire
    .replace(/%2f/gi, "/")
    .replace(/%5c/gi, "\\")
    .replace(/%2e/gi, ".");
  if (asOriginSeesIt === "") return true;
  const segs = asOriginSeesIt.split(/[/\\]/);
  return segs.length > 1 || segs.some((s) => s === "." || s === "..");
}

describe("issue #54 - exactly one legal URL per call", () => {
  it("classifies origin-decodable payloads without a hard-coded list (self-test)", () => {
    for (const p of ["../servers/42", "servers/42", "..\\x", "..", ".", "", "1/../x"]) {
      expect(escapesOneSegment(p), `${JSON.stringify(p)} must count as escaping`).toBe(true);
    }
    // Already-encoded spellings are deliberately NOT in that group, and the
    // distinction is the point: encodeURIComponent escapes their "%" a second
    // time, so one decode at the origin yields a literal "%2F" again rather than a
    // separator. The implementation rejects them anyway (section 1c) - belt and
    // braces, not something this oracle demands.
    for (const p of ["..%2Fservers%2F42", "%2e%2e%2fservers", "%2f", "%5c", "%2e%2e"]) {
      expect(escapesOneSegment(p), `${JSON.stringify(p)} decodes only once`).toBe(false);
    }
    for (const p of [
      "example.com",
      "münchen.de",
      "xn--mnchen-3ya.de",
      "example.com.",
      "@",
      "*",
      "*.sub",
      "_dmarc",
      "a'b.com",
      "zone(1).com",
      "42",
      "%252e%252e", // double-encoded: the "%" is escaped again, no separator
      "1@evil.com",
      "a;b",
    ]) {
      expect(escapesOneSegment(p), `${JSON.stringify(p)} must NOT count as escaping`).toBe(
        false,
      );
    }
  });

  it("classifies collapsing vs. encodable payloads without a hard-coded list (self-test)", () => {
    for (const p of [".", "..", ""]) {
      expect(collapsesAPath(p), `${JSON.stringify(p)} must count as collapsing`).toBe(true);
    }
    for (const p of ["%2e", "%2e%2e", "1/../x", "1?a=b", "1#f", "münchen.de", "@", "*", "1"]) {
      expect(collapsesAPath(p), `${JSON.stringify(p)} must NOT count as collapsing`).toBe(false);
    }
  });

  it("every path parameter of every generated tool: one legal URL, or none", async () => {
    // Payloads chosen against the *guard's* mechanics rather than the issue's
    // reproduction: alternative dot spellings, separators that only some parsers
    // honour, look-alike code points, control characters, length, and the
    // already-encoded forms whose second decoding is the regression this section
    // exists to catch.
    const payloads: string[] = [
      ".", "..", "", "./.", "../..", "1/./",
      "1/x", "1/../x", "1?a=b", "1#f", "1\\x",
      "%2e", "%2E", "%2e%2e", "%252e%252e", "%2f", "%2F", "%5c", "..%2f..%2f",
      "1\t/../x", "1\n/x", "1\r/x", " ", "1 /x", "1 /x",
      "．．", "․․", "﹒", "。", "／..／x", "1⁄..⁄x", "1∕..∕x", "％2e",
      "-1", "0", "1e3", "0x1", " 1", "1 ", "9007199254740993",
      "id=1&x=2", "a;b", "a,b", "a=b", "a&b", "a+b", "a$b", "a!b", "a*b", "a'b", "a(b)",
      "servers", "actions", "ssh_keys", "reset_password", "..;", "1/..;/x",
      "/1", "1//2", "//", "///", "//evil.com/x", "http://evil.com", "1@evil.com",
      "x".repeat(3000),
    ];

    const h = harness(false);
    let sent = 0;
    let blocked = 0;
    let collapsingChecked = 0;
    let climbChecked = 0;

    for (const tool of h.registry.getAll()) {
      const op = OP_BY_TOOL.get(tool.name);
      if (!op) continue;
      const pathParams = op.parameters.filter((p) => p.in === "path").map((p) => p.name);
      if (pathParams.length === 0) continue;

      for (const target of pathParams) {
        for (const payload of payloads) {
          const values: Record<string, unknown> = {};
          for (const name of pathParams) values[name] = name === target ? payload : "1";
          const context = `${tool.name}.${target} = ${JSON.stringify(payload)}`;
          const before = h.urls.length;
          try {
            await tool.handler({ wait: false, auto_paginate: false, body: {}, ...values });
          } catch {
            // A loud throw is a pass; only what reached fetch is under test.
          }
          const got = h.urls.slice(before);

          if (collapsesAPath(payload)) {
            collapsingChecked++;
            expect(got, `${context}: encoding cannot defend this - it must not be sent`).toEqual(
              [],
            );
          }
          if (escapesOneSegment(payload)) {
            climbChecked++;
            expect(
              got,
              `${context}: the origin would decode this out of its slot - it must not be sent`,
            ).toEqual([]);
          }
          if (got.length === 0) {
            blocked++;
            continue;
          }
          sent += got.length;
          const legal = onlyLegalPathname(op.path, values);
          for (const url of got) {
            expect(new URL(url).origin, `${context}: left the API origin`).toBe(
              "https://api.hetzner.cloud",
            );
            expect(new URL(url).hash, `${context}: leaked into a fragment`).toBe("");
            expect(new URL(url).pathname, `${context}: not the one legal URL`).toBe(legal);
          }
        }
      }
    }

    // Lower bounds so the oracle cannot degenerate. `sent` matters most: it is
    // the number of URLs actually compared against the oracle, and a guard that
    // simply refused everything would be an outage, not a fix. (It dropped from
    // ~9500 to ~6500 when separator-carrying values stopped being sent as one
    // encoded segment - that is the fix, not a degeneration.)
    expect(sent).toBeGreaterThan(6000);
    expect(blocked).toBeGreaterThan(4000);
    expect(collapsingChecked).toBeGreaterThan(500);
    expect(climbChecked).toBeGreaterThan(3000);
  });
});

// ---------------------------------------------------------------------------
// 8. Value TYPES, not just hostile strings.
//
// Every payload in sections 1-7 is a string. The new guard is
// `isResourceId` (Number.isSafeInteger && >= 1) plus the schema type check, and
// neither is exercised by strings alone: an array, a boxed object, a bare `0`
// or 2^53+1 take different branches. `String([42]) === "42"` and
// `String({toString: () => "1/../x"})` are the interesting ones - a cast-only
// guard accepts both.
// ---------------------------------------------------------------------------

const HOSTILE_ID_VALUES: unknown[] = [
  0,
  -1,
  1.5,
  -0,
  1e21,
  Number.MAX_SAFE_INTEGER + 2,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  true,
  false,
  null,
  [42],
  ["42"],
  [1, 2],
  [],
  { id: 42 },
  {},
  "42",
  "0x2a",
  "1e3",
  " 42",
  "42 ",
  "042",
  "+42",
  "9007199254740993",
  "٤٢", // Arabic-Indic digits: Number() parses these, the guard must not
];

describe("issue #54 - the id guard checks the type, not just the spelling", () => {
  for (const confirmWrites of [false, true]) {
    it(`rejects every non-id value at the MCP boundary (confirmWrites=${confirmWrites})`, async () => {
      const h = harness(confirmWrites);
      const mcp = await connect(h.registry);
      let checked = 0;
      try {
        for (const { tool, extra } of ID_SINKS) {
          for (const id of HOSTILE_ID_VALUES) {
            const args: Record<string, unknown> = { id, ...extra };
            if (confirmWrites) args.confirm = "YES";
            const context = `${tool} id=${JSON.stringify(id) ?? String(id)}`;
            const before = h.urls.length;
            const res = await mcp.call(tool, args);
            checked++;
            expect(res.isError, `${context}: accepted`).toBe(true);
            expect(h.urls.slice(before), `${context}: reached the network`).toEqual([]);
            expect(res.text, `${context}: leaked the token`).not.toContain(TOKEN);
          }
        }
      } finally {
        await mcp.close();
      }
      expect(checked).toBe(ID_SINKS.length * HOSTILE_ID_VALUES.length);
      expect(h.urls).toEqual([]);
    });
  }

  it("rejects them at the handler boundary too, coercion tricks included", async () => {
    // Schema validation removed from the picture: the wrappers' own guard has to
    // carry these. `toString`/`valueOf` overrides cannot cross the MCP wire, but
    // they are exactly what a cast-only guard (`input.id as number`) waves
    // through, so pin them at the layer where they are reachable.
    const h = harness(false);
    const coercers: unknown[] = [
      { toString: () => "1/../../ssh_keys" },
      { valueOf: () => "1/../x" },
      { toString: () => "1", valueOf: () => 1 },
      new Number(42), // eslint-disable-line no-new-wrappers
      new String("42"), // eslint-disable-line no-new-wrappers
    ];
    for (const { tool, extra } of ID_SINKS) {
      const def = h.registry.getByName(tool);
      expect(def, tool).toBeDefined();
      for (const id of [...HOSTILE_ID_VALUES, ...coercers]) {
        const before = h.urls.length;
        try {
          await def!.handler({ id, ...extra });
        } catch {
          // A loud throw is a pass - runServerAction's programming-error guard.
        }
        expect(
          h.urls.slice(before),
          `${tool} id=${Object.prototype.toString.call(id)}: reached the network`,
        ).toEqual([]);
      }
    }
  });

  it("accepts the ids that are actually valid (no false rejections)", async () => {
    const h = harness(false);
    const mcp = await connect(h.registry);
    try {
      for (const id of [1, 42, 4.0, Number.MAX_SAFE_INTEGER]) {
        const before = h.urls.length;
        const res = await mcp.call("hcloud_server_power", { id, op: "reboot", wait: false });
        expect(res.isError, `id=${id} was rejected: ${res.text}`).toBe(false);
        expect(h.urls.slice(before), `id=${id}`).toEqual([
          `https://api.hetzner.cloud/v1/servers/${id}/actions/reboot`,
        ]);
      }
    } finally {
      await mcp.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 9. The query string.
//
// The fix changed query serialisation too (repeated parameters instead of a
// comma-joined value), and `hcloud_raw_request` lets the caller choose the
// parameter NAMES as well as the values. Nothing above asserts that a query
// value or key cannot add a parameter of its own or reach back into the path -
// the same class of bug as the path injection, one layer over.
// ---------------------------------------------------------------------------

describe("issue #54 - a query key or value may not reshape the request", () => {
  const HOSTILE_QUERY: unknown[] = [
    "a&b=c",
    "a#f",
    "a?b",
    "x=1&y=2",
    "/../ssh_keys",
    "%2e%2e%2f",
    "\n",
    "\r\n",
    " ",
    ["a", "b&c=d"],
    ["a#f"],
    1,
    true,
    null,
  ];

  it("raw_request: a caller-chosen key/value pair stays exactly one parameter", async () => {
    const h = harness(false);
    const mcp = await connect(h.registry);
    let checked = 0;
    try {
      for (const key of ["name", "a&b", "a=b", "a#b", "sort", "__proto__"]) {
        for (const value of HOSTILE_QUERY) {
          const context = `query[${JSON.stringify(key)}] = ${JSON.stringify(value)}`;
          const before = h.urls.length;
          await mcp.call("hcloud_raw_request", {
            method: "GET",
            path: "/servers",
            query: { [key]: value },
          });
          checked++;
          for (const url of h.urls.slice(before)) {
            const parsed = new URL(url);
            expect(parsed.pathname, `${context}: reached back into the path`).toBe("/v1/servers");
            expect(parsed.hash, `${context}: leaked into a fragment`).toBe("");
            expect(parsed.origin, `${context}: left the API origin`).toBe(
              "https://api.hetzner.cloud",
            );
            // The URL may expose no parameter name other than the one asked for.
            expect(
              [...new Set(parsed.searchParams.keys())],
              `${context}: injected a parameter`,
            ).toEqual(value === null ? [] : [key]);
            // …and the value must come back out unchanged, one entry per element.
            const want =
              value === null ? [] : (Array.isArray(value) ? value : [value]).map(String);
            expect(parsed.searchParams.getAll(key), `${context}: value was reshaped`).toEqual(want);
          }
        }
      }
    } finally {
      await mcp.close();
    }
    expect(checked).toBe(6 * HOSTILE_QUERY.length);
  });

  it("a generated tool's array-typed query parameter accepts both shapes and smuggles neither", async () => {
    // `sort` is declared as an array of enums; the fix also made a bare scalar
    // acceptable. Both shapes must reach the wire as repeated parameters, and a
    // hostile element must stay one opaque value.
    const h = harness(false);
    const mcp = await connect(h.registry);
    try {
      for (const sort of ["id:asc", ["id:asc", "command:desc"]]) {
        const before = h.urls.length;
        const res = await mcp.call("hcloud_get_certificates_actions", { sort });
        expect(res.isError, `sort=${JSON.stringify(sort)} was rejected: ${res.text}`).toBe(false);
        const url = h.urls.slice(before)[0]!;
        const parsed = new URL(url);
        expect(parsed.pathname).toBe("/v1/certificates/actions");
        expect(parsed.searchParams.getAll("sort")).toEqual(
          Array.isArray(sort) ? sort : [sort],
        );
        expect(parsed.search, "comma-joined instead of repeated").not.toContain("%2C");
      }
      // An element of the wrong type is rejected before any request.
      for (const sort of [[{ x: 1 }], [5], [null]]) {
        const before = h.urls.length;
        const res = await mcp.call("hcloud_get_certificates_actions", { sort });
        expect(res.isError, `sort=${JSON.stringify(sort)} was accepted`).toBe(true);
        expect(h.urls.slice(before), JSON.stringify(sort)).toEqual([]);
      }
      // A hostile element that IS a string stays one opaque value.
      const before = h.urls.length;
      await mcp.call("hcloud_get_certificates_actions", { sort: ["id:asc&status=x", "a#f"] });
      for (const url of h.urls.slice(before)) {
        const parsed = new URL(url);
        expect(parsed.pathname).toBe("/v1/certificates/actions");
        expect(parsed.hash).toBe("");
        // `/certificates/actions` is not a list endpoint, so no `page` is added:
        // the only parameter present must be the one the caller passed.
        expect([...new Set(parsed.searchParams.keys())]).toEqual(["sort"]);
        expect(parsed.searchParams.getAll("sort")).toEqual(["id:asc&status=x", "a#f"]);
      }
    } finally {
      await mcp.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 10. The one path value the CALLER does not control.
//
// `pollAction` puts `response.body.action.id` into a path, and `apply_firewall`
// puts `response.body.firewalls[0].id` into one. Those come from the upstream
// response, so no amount of input validation covers them - and
// tests/action-polling.test.ts asserts them against a `vi.fn()` stand-in for the
// client, which cannot show what the URL would actually be. Assert it through
// the real client instead.
// ---------------------------------------------------------------------------

describe("issue #54 - a hostile upstream response may not reshape a follow-up path", () => {
  /** A client whose fetch answers with `bodies[n]` and records every URL. */
  function respondingHarness(bodies: string[]) {
    const urls: string[] = [];
    let i = 0;
    const client = new HetznerHttpClient({
      baseUrl: BASE_URL,
      token: TOKEN,
      maxRetries: 0,
      sleep: async () => {},
      fetch: (async (input: unknown) => {
        urls.push(typeof input === "string" ? input : String((input as Request).url));
        const body = bodies[Math.min(i++, bodies.length - 1)]!;
        return new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof globalThis.fetch,
    });
    return { client, urls };
  }

  it("a traversal payload in `action.id` cannot move the poll request", async () => {
    const hostile = "1/../../ssh_keys";
    const { client, urls } = respondingHarness([
      JSON.stringify({ action: { id: hostile, status: "running" } }),
      JSON.stringify({ action: { id: hostile, status: "success" } }),
    ]);
    const registry = new ToolRegistry();
    registry.register(
      makeServerBackupTool({
        client,
        actionPoll: { timeoutMs: 1_000, intervalMs: 0, sleep: async () => {}, now: () => 0 },
      }),
    );
    const mcp = await connect(registry);
    try {
      await mcp.call("hcloud_server_backup", { id: 42, enable: true, wait: true });
    } finally {
      await mcp.close();
    }
    expect(urls.length).toBeGreaterThan(1); // the poll actually happened
    expect(urls.map((u) => new URL(u).pathname)).toEqual([
      "/v1/servers/42/actions/enable_backup",
      `/v1/actions/${encodeURIComponent(hostile)}`,
    ]);
    for (const url of urls) assertNoForbiddenPivot(url, `poll of action.id=${hostile}`);
  });

  it("a traversal payload in a firewall lookup result cannot move the apply request", async () => {
    const hostile = "11/../../ssh_keys";
    const { client, urls } = respondingHarness([
      JSON.stringify({ firewalls: [{ id: hostile }] }),
      JSON.stringify({ action: { id: 1, status: "success" } }),
    ]);
    const registry = new ToolRegistry();
    registry.register(
      makeApplyFirewallToServerTool({
        client,
        actionPoll: { timeoutMs: 0, intervalMs: 0, sleep: async () => {}, now: () => 0 },
      }),
    );
    const mcp = await connect(registry);
    try {
      await mcp.call("hcloud_apply_firewall_to_server", {
        firewall_name: "web",
        server_id: 7,
      });
    } finally {
      await mcp.close();
    }
    expect(urls.map((u) => new URL(u).pathname)).toEqual([
      "/v1/firewalls",
      `/v1/firewalls/${encodeURIComponent(hostile)}/actions/apply_to_resources`,
    ]);
    for (const url of urls) assertNoForbiddenPivot(url, `apply with firewall id=${hostile}`);
  });
});
