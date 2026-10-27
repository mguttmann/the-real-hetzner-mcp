import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildRegistry } from "../src/build-registry.js";

// MCP: destructiveHint false means the tool performs only additive updates.
// Every write tool is destructive unless it only adds a resource, an
// association or a copy, or starts a stopped server (B-015). This list is the
// expectation, kept independent of the generator's own allowlist.
const ADDITIVE_WRITE_TOOLS = new Set([
  "hcloud_create_certificate",
  "hcloud_create_firewall",
  "hcloud_create_floating_ip",
  "hcloud_create_load_balancer",
  "hcloud_create_network",
  "hcloud_create_placement_group",
  "hcloud_create_primary_ip",
  "hcloud_create_server",
  "hcloud_create_ssh_key",
  "hcloud_create_volume",
  "hcloud_create_zone",
  "hcloud_post_zone_rrsets",
  "hcloud_certificate_retry_action",
  "hcloud_load_balancer_add_service_action",
  "hcloud_load_balancer_add_target_action",
  "hcloud_load_balancer_attach_to_network_action",
  "hcloud_network_add_route_action",
  "hcloud_network_add_subnet_action",
  "hcloud_server_add_to_placement_group_action",
  "hcloud_server_attach_to_network_action",
  "hcloud_server_create_image_action",
  "hcloud_server_enable_backup_action",
  "hcloud_server_poweron_action",
  "hcloud_volume_attach_action",
  "hcloud_zone_rrset_add_records_action",
  "hcloud_server_snapshot",
]);

function registryTools() {
  const offlineFetch = (async () => {
    throw new Error("no network in this test");
  }) as typeof globalThis.fetch;
  return buildRegistry(
    loadConfig({ HETZNER_API_TOKEN: "dummy", HETZNER_API_BASE: "http://127.0.0.1:1" }),
    { fetch: offlineFetch },
  ).getAll();
}

describe("destructiveHint on the real registry (B-015)", () => {
  const tools = registryTools();

  it("is false for every read-only tool", () => {
    const wrong = tools
      .filter((t) => t.annotations.readOnlyHint && t.annotations.destructiveHint)
      .map((t) => t.name);
    expect(wrong).toEqual([]);
  });

  it("is true for every write tool outside the additive list", () => {
    const writes = tools.filter((t) => !t.annotations.readOnlyHint);
    const wrong = writes
      .filter((t) => t.annotations.destructiveHint === ADDITIVE_WRITE_TOOLS.has(t.name))
      .map((t) => `${t.name}=${t.annotations.destructiveHint}`);
    expect(wrong).toEqual([]);
    // Every name in the list exists, so a renamed tool cannot hide here.
    const names = new Set(writes.map((t) => t.name));
    expect([...ADDITIVE_WRITE_TOOLS].filter((n) => !names.has(n))).toEqual([]);
  });

  it("marks the known non-additive writes destructive", () => {
    const byName = new Map(tools.map((t) => [t.name, t]));
    const mustBeDestructive = [
      "hcloud_server_disable_backup_action",
      "hcloud_server_backup",
      "hcloud_server_rescue",
      "hcloud_server_enable_rescue_action",
      "hcloud_apply_firewall_to_server",
      "hcloud_firewall_set_rules_action",
      "hcloud_update_server",
      ...tools.map((t) => t.name).filter((n) => n.endsWith("_change_protection_action")),
    ];
    for (const name of mustBeDestructive) {
      expect(byName.get(name)?.annotations.destructiveHint, name).toBe(true);
    }
  });
});
