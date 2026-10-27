import { describe, it, expect } from "vitest";
import { OPERATIONS } from "../src/tools/generated/operations.js";

// B-017: the spec refresh of 2026-10 made `dns_ptr` required in the body of the
// change_dns_ptr actions. The tool contract keeps the required fields an existing
// tool had; the API stays the authority and rejects a call that lacks a field.
const PINNED_BODY_REQUIRED: Record<string, string[]> = {
  hcloud_floating_ip_change_dns_ptr_action: ["ip"],
  hcloud_load_balancer_change_dns_ptr_action: ["ip"],
  hcloud_primary_ip_change_dns_ptr_action: ["ip"],
  hcloud_server_change_dns_ptr_action: ["ip"],
};

describe("required body fields pinned across the spec refresh (B-017)", () => {
  for (const [tool, required] of Object.entries(PINNED_BODY_REQUIRED)) {
    it(`${tool} keeps body.required ${JSON.stringify(required)}`, () => {
      const op = OPERATIONS.find((o) => o.toolName === tool);
      expect(op, tool).toBeDefined();
      const body = op!.requestBodySchema as { required?: string[]; properties?: Record<string, unknown> };
      expect(body.required).toEqual(required);
      // The field itself stays declared, only optional.
      expect(Object.keys(body.properties ?? {})).toContain("dns_ptr");
    });
  }
});
