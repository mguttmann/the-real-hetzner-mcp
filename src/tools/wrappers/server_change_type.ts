import type { ToolDef, ToolResult } from "../../types.js";
import { runServerAction, type ServerActionDeps } from "./_server_action.js";

export function makeServerChangeTypeTool(deps: ServerActionDeps): ToolDef {
  return {
    name: "hcloud_server_change_type",
    description:
      "Change a server's hardware type. Defaults upgrade_disk to false (disk size kept; safer to downgrade later). Hand-tuned wrapper; polls the resulting action by default.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer", minimum: 1 },
        server_type: { type: "string", minLength: 1 },
        upgrade_disk: { type: "boolean", default: false },
        wait: { type: "boolean", default: true },
      },
      required: ["id", "server_type"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    handler: async (input): Promise<ToolResult> => {
      const id = input.id as number;
      const server_type = input.server_type as string;
      const upgrade_disk = input.upgrade_disk === true;
      const wait = input.wait !== false;
      return runServerAction(deps, id, "change_type", { server_type, upgrade_disk }, wait);
    },
  };
}
