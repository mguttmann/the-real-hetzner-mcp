import type { ToolDef, ToolResult } from "../../types.js";
import { runServerAction, type ServerActionDeps } from "./_server_action.js";

export function makeServerSnapshotTool(deps: ServerActionDeps): ToolDef {
  return {
    name: "hcloud_server_snapshot",
    description:
      "Create an image (snapshot or backup) of a server. Default type is 'snapshot'. Hand-tuned wrapper that polls the resulting action.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer", minimum: 1 },
        type: { type: "string", enum: ["snapshot", "backup"], default: "snapshot" },
        description: { type: "string" },
        labels: { type: "object", additionalProperties: { type: "string" } },
        wait: { type: "boolean", default: true },
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    handler: async (input): Promise<ToolResult> => {
      const id = input.id as number;
      const body: Record<string, unknown> = {
        type: typeof input.type === "string" ? input.type : "snapshot",
      };
      if (typeof input.description === "string") body.description = input.description;
      if (input.labels && typeof input.labels === "object") body.labels = input.labels;
      const wait = input.wait !== false;
      return runServerAction(deps, id, "create_image", body, wait);
    },
  };
}
