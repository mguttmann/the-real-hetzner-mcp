import type { ToolDef, ToolResult } from "../../types.js";
import { runServerAction, type ServerActionDeps } from "./_server_action.js";

export function makeServerRescueTool(deps: ServerActionDeps): ToolDef {
  return {
    name: "hcloud_server_rescue",
    description:
      "Toggle Hetzner rescue mode on a server. When enabling, defaults type to 'linux64' and accepts ssh_keys (array of SSH-key ids). Hand-tuned wrapper.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer", minimum: 1 },
        enable: { type: "boolean", description: "true to enter rescue, false to leave." },
        type: { type: "string", enum: ["linux64", "linux32", "freebsd64"], default: "linux64" },
        ssh_keys: { type: "array", items: { type: "integer" } },
        wait: { type: "boolean", default: true },
      },
      required: ["id", "enable"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    handler: async (input): Promise<ToolResult> => {
      const id = input.id as number;
      const wait = input.wait !== false;
      if (input.enable === true) {
        const body: Record<string, unknown> = {
          type: typeof input.type === "string" ? input.type : "linux64",
        };
        if (Array.isArray(input.ssh_keys)) body.ssh_keys = input.ssh_keys;
        return runServerAction(deps, id, "enable_rescue", body, wait);
      }
      return runServerAction(deps, id, "disable_rescue", undefined, wait);
    },
  };
}
