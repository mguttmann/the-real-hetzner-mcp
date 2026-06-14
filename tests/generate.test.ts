import { describe, it, expect } from "vitest";
import { buildOperations } from "../scripts/generate.js";

const MINI_SPEC = {
  openapi: "3.0.0",
  info: { title: "test", version: "1" },
  paths: {
    "/servers": {
      get: {
        summary: "List servers",
        operationId: "list_servers",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer" } },
          { name: "name", in: "query", schema: { type: "string" } },
        ],
        responses: { "200": {} },
      },
      post: {
        summary: "Create server",
        operationId: "create_server",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { name: { type: "string" }, server_type: { type: "string" } },
                required: ["name", "server_type"],
              },
            },
          },
        },
        responses: { "201": {} },
      },
    },
    "/servers/{id}": {
      get: {
        summary: "Get server",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        responses: { "200": {} },
      },
      delete: {
        summary: "Delete server",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        responses: { "204": {} },
      },
    },
    "/servers/{id}/actions/poweron": {
      post: {
        summary: "Power on server",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        responses: {
          "201": {
            content: {
              "application/json": {
                schema: { type: "object", properties: { action: { type: "object" } } },
              },
            },
          },
        },
      },
    },
    "/servers/{id}/actions/attach_to_network": {
      post: {
        summary: "Attach server to network",
        operationId: "attach_server_to_network",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { network: { type: "integer" } },
                required: ["network"],
              },
            },
          },
        },
        responses: { "201": {} },
      },
    },
    "/servers/{id}/metrics": {
      get: {
        summary: "Server metrics",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "integer" } },
          { name: "type", in: "query", required: true, schema: { type: "string" } },
        ],
        responses: { "200": {} },
      },
    },
    "/pricing": {
      get: { summary: "Pricing", responses: { "200": {} } },
    },
    "/zones/{id_or_name}/rrsets/{rr_name}/{rr_type}": {
      get: {
        summary: "Get RRSet",
        parameters: [
          { name: "id_or_name", in: "path", required: true, schema: { type: "string" } },
          { name: "rr_name", in: "path", required: true, schema: { type: "string" } },
          { name: "rr_type", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { "200": {} },
      },
      delete: {
        summary: "Delete RRSet",
        parameters: [
          { name: "id_or_name", in: "path", required: true, schema: { type: "string" } },
          { name: "rr_name", in: "path", required: true, schema: { type: "string" } },
          { name: "rr_type", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { "204": {} },
      },
      put: {
        summary: "Update RRSet",
        parameters: [
          { name: "id_or_name", in: "path", required: true, schema: { type: "string" } },
          { name: "rr_name", in: "path", required: true, schema: { type: "string" } },
          { name: "rr_type", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { "200": {} },
      },
    },
    "/zones/{id_or_name}/rrsets/{rr_name}/{rr_type}/actions/add_records": {
      post: {
        summary: "Add RRSet records",
        parameters: [
          { name: "id_or_name", in: "path", required: true, schema: { type: "string" } },
          { name: "rr_name", in: "path", required: true, schema: { type: "string" } },
          { name: "rr_type", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "201": {
            content: {
              "application/json": {
                schema: { type: "object", properties: { action: { type: "object" } } },
              },
            },
          },
        },
      },
    },
  },
};

describe("buildOperations", () => {
  it("emits one operation per path+method", () => {
    const ops = buildOperations(MINI_SPEC);
    expect(ops.map((o) => `${o.method} ${o.path}`)).toEqual(
      expect.arrayContaining([
        "GET /servers",
        "POST /servers",
        "GET /servers/{id}",
        "DELETE /servers/{id}",
        "POST /servers/{id}/actions/poweron",
        "POST /servers/{id}/actions/attach_to_network",
        "GET /servers/{id}/metrics",
        "GET /pricing",
        "GET /zones/{id_or_name}/rrsets/{rr_name}/{rr_type}",
        "DELETE /zones/{id_or_name}/rrsets/{rr_name}/{rr_type}",
        "PUT /zones/{id_or_name}/rrsets/{rr_name}/{rr_type}",
        "POST /zones/{id_or_name}/rrsets/{rr_name}/{rr_type}/actions/add_records",
      ]),
    );
    expect(ops).toHaveLength(12);
  });

  it("derives tool names per the naming scheme", () => {
    const ops = buildOperations(MINI_SPEC);
    const byPath = (m: string, p: string) =>
      ops.find((o) => o.method === m && o.path === p)!.toolName;
    expect(byPath("GET", "/servers")).toBe("hcloud_list_servers_raw"); // collision with wrapper
    expect(byPath("POST", "/servers")).toBe("hcloud_create_server");
    expect(byPath("GET", "/servers/{id}")).toBe("hcloud_get_server_raw"); // collision
    expect(byPath("DELETE", "/servers/{id}")).toBe("hcloud_delete_server");
    expect(byPath("POST", "/servers/{id}/actions/poweron"))
      .toBe("hcloud_server_poweron_action");
    expect(byPath("GET", "/servers/{id}/metrics")).toBe("hcloud_get_server_metrics_raw"); // collision
    expect(byPath("GET", "/pricing")).toBe("hcloud_get_pricing");
  });

  it("derives clean names for deep paths (5+ segments)", () => {
    const ops = buildOperations(MINI_SPEC);
    const byPath = (m: string, p: string) =>
      ops.find((o) => o.method === m && o.path === p)!.toolName;
    expect(byPath("GET", "/zones/{id_or_name}/rrsets/{rr_name}/{rr_type}"))
      .toBe("hcloud_get_zone_rrset");
    expect(byPath("DELETE", "/zones/{id_or_name}/rrsets/{rr_name}/{rr_type}"))
      .toBe("hcloud_delete_zone_rrset");
    expect(byPath("PUT", "/zones/{id_or_name}/rrsets/{rr_name}/{rr_type}"))
      .toBe("hcloud_update_zone_rrset");
    expect(byPath(
      "POST",
      "/zones/{id_or_name}/rrsets/{rr_name}/{rr_type}/actions/add_records",
    )).toBe("hcloud_zone_rrset_add_records_action");
  });

  it("marks DELETE and dangerous actions as destructive", () => {
    const ops = buildOperations(MINI_SPEC);
    const del = ops.find((o) => o.toolName === "hcloud_delete_server")!;
    expect(del.isDestructive).toBe(true);
    const pw = ops.find((o) => o.toolName === "hcloud_server_poweron_action")!;
    expect(pw.isDestructive).toBe(false); // poweron is NOT dangerous
  });

  it("marks responses that include an Action object as returnsAction", () => {
    const ops = buildOperations(MINI_SPEC);
    const pw = ops.find((o) => o.toolName === "hcloud_server_poweron_action")!;
    expect(pw.returnsAction).toBe(true);
    const list = ops.find((o) => o.toolName === "hcloud_list_servers_raw")!;
    expect(list.returnsAction).toBe(false);
  });

  it("captures path and query parameters with their schemas", () => {
    const ops = buildOperations(MINI_SPEC);
    const getServer = ops.find((o) => o.toolName === "hcloud_get_server_raw")!;
    expect(getServer.parameters).toEqual([
      { name: "id", in: "path", required: true, schema: { type: "integer" } },
    ]);
    const list = ops.find((o) => o.toolName === "hcloud_list_servers_raw")!;
    expect(list.parameters.map((p) => p.name)).toEqual(["page", "name"]);
  });

  it("captures requestBody schema when present", () => {
    const ops = buildOperations(MINI_SPEC);
    const create = ops.find((o) => o.toolName === "hcloud_create_server")!;
    expect(create.requestBodySchema).toEqual({
      type: "object",
      properties: { name: { type: "string" }, server_type: { type: "string" } },
      required: ["name", "server_type"],
    });
  });

  it("captures requestBody.required (defaults to false when omitted)", () => {
    const ops = buildOperations(MINI_SPEC);
    // POST /servers omits requestBody.required -> defaults to false
    const create = ops.find((o) => o.toolName === "hcloud_create_server")!;
    expect(create.requestBodyRequired).toBe(false);
    // POST /servers/{id}/actions/attach_to_network has requestBody.required: true
    const attach = ops.find(
      (o) => o.toolName === "hcloud_server_attach_to_network_action",
    )!;
    expect(attach.requestBodyRequired).toBe(true);
  });

  it("sorts operations deterministically by toolName", () => {
    const ops = buildOperations(MINI_SPEC);
    const names = ops.map((o) => o.toolName);
    expect(names).toEqual([...names].sort());
  });
});
