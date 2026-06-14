import type { ToolDef, ToolResult } from "../../types.js";
import { runServerAction, type ServerActionDeps } from "./_server_action.js";

const VALID_OPS = ["poweron", "poweroff", "reboot", "shutdown", "reset"] as const;
type Op = (typeof VALID_OPS)[number];

export function makeServerPowerTool(deps: ServerActionDeps): ToolDef {
  return {
    name: "hcloud_server_power",
    description:
      "Run a power operation on a server (poweron / poweroff / reboot / shutdown / reset). Hand-tuned wrapper that polls the resulting action by default.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer", minimum: 1 },
        op: { type: "string", enum: [...VALID_OPS] },
        wait: { type: "boolean", default: true },
      },
      required: ["id", "op"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    handler: async (input): Promise<ToolResult> => {
      const id = input.id as number;
      const op = input.op as Op;
      if (!VALID_OPS.includes(op)) {
        return {
          content: [{ type: "text", text: `Invalid op="${op}". Must be one of: ${VALID_OPS.join(", ")}.` }],
          isError: true,
        };
      }
      const wait = input.wait !== false;
      return runServerAction(deps, id, op, undefined, wait);
    },
  };
}
