import type { ToolDef, ToolResult } from "../../types.js";
import { runServerAction, type ServerActionDeps } from "./_server_action.js";
import { invalidIdResult, isResourceId } from "../_validate.js";

export function makeServerRebuildTool(deps: ServerActionDeps): ToolDef {
  return {
    name: "hcloud_server_rebuild",
    description:
      "Rebuild a server from an image. Accept image_id (integer) OR image_name (string). Hand-tuned wrapper; polls the resulting action by default.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer", minimum: 1 },
        image_id: { type: "integer", minimum: 1 },
        image_name: { type: "string", minLength: 1 },
        wait: { type: "boolean", default: true },
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    handler: async (input, ctx): Promise<ToolResult> => {
      const id = input.id;
      if (!isResourceId(id)) return invalidIdResult("id", id);
      const hasId = typeof input.image_id === "number";
      const hasName = typeof input.image_name === "string";
      if (hasId === hasName) {
        return {
          content: [{ type: "text", text: "Provide exactly one of `image_id` or `image_name`." }],
          isError: true,
        };
      }
      const image = hasId ? (input.image_id as number) : (input.image_name as string);
      const wait = input.wait !== false;
      return runServerAction(deps, id, "rebuild", { image }, wait, "hcloud_server_rebuild", ctx?.signal);
    },
  };
}
