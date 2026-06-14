import type { ToolDef, ToolResult } from "../../types.js";
import { runServerAction, type ServerActionDeps } from "./_server_action.js";

export function makeServerBackupTool(deps: ServerActionDeps): ToolDef {
  return {
    name: "hcloud_server_backup",
    description:
      "Toggle Hetzner-managed automatic backups on a server. Hand-tuned wrapper around enable_backup / disable_backup actions.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer", minimum: 1 },
        enable: { type: "boolean", description: "true to turn backups on, false to turn them off." },
        wait: { type: "boolean", default: true },
      },
      required: ["id", "enable"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    handler: async (input): Promise<ToolResult> => {
      const id = input.id as number;
      const action = input.enable === true ? "enable_backup" : "disable_backup";
      const wait = input.wait !== false;
      return runServerAction(deps, id, action, undefined, wait);
    },
  };
}
