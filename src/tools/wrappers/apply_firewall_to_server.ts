import type { ToolDef, ToolResult } from "../../types.js";
import type { HetznerHttpClient } from "../../http/client.js";
import type { PollOptions } from "../../http/action-polling.js";
import { asToolError } from "../_error.js";

export type ApplyFirewallDeps = {
  client: HetznerHttpClient;
  actionPoll: PollOptions;
};

export function makeApplyFirewallToServerTool(deps: ApplyFirewallDeps): ToolDef {
  return {
    name: "hcloud_apply_firewall_to_server",
    description:
      "Apply a firewall (by id or by name) to a server. Hand-tuned wrapper around POST /firewalls/{id}/actions/apply_to_resources.",
    inputSchema: {
      type: "object",
      properties: {
        firewall_id: { type: "integer", minimum: 1 },
        firewall_name: { type: "string", minLength: 1 },
        server_id: { type: "integer", minimum: 1 },
      },
      required: ["server_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    handler: async (input): Promise<ToolResult> => {
      const serverId = input.server_id as number;
      const hasId = typeof input.firewall_id === "number";
      const hasName = typeof input.firewall_name === "string";
      if (hasId === hasName) {
        return { content: [{ type: "text", text: "Provide exactly one of `firewall_id` or `firewall_name`." }], isError: true };
      }
      let fwId: number;
      if (hasId) {
        fwId = input.firewall_id as number;
      } else {
        const lookup = await deps.client.request<{ firewalls: Array<{ id: number }> }>(
          "GET",
          "/firewalls",
          { query: { name: input.firewall_name as string } },
        );
        const lookupErr = asToolError(lookup);
        if (lookupErr) return lookupErr;
        const found = lookup.body?.firewalls?.[0];
        if (!found) {
          return { content: [{ type: "text", text: `Firewall with name="${input.firewall_name}" not found.` }], isError: true };
        }
        fwId = found.id;
      }
      const res = await deps.client.request(
        "POST",
        `/firewalls/${fwId}/actions/apply_to_resources`,
        { body: { apply_to: [{ type: "server", server: { id: serverId } }] } },
      );
      const errResult = asToolError(res);
      if (errResult) return errResult;
      return { content: [{ type: "text", text: JSON.stringify(res.body ?? {}, null, 2) }] };
    },
  };
}
