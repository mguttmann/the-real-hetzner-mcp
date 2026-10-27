import type { ToolDef, ToolResult } from "../../types.js";
import { runServerAction, type ServerActionDeps } from "./_server_action.js";
import { invalidIdResult, isResourceId } from "../_validate.js";

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
        type: { type: "string", enum: ["linux64"], default: "linux64" },
        ssh_keys: { type: "array", items: { type: "integer" } },
        wait: { type: "boolean", default: true },
      },
      required: ["id", "enable"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    handler: async (input, ctx): Promise<ToolResult> => {
      const id = input.id;
      if (!isResourceId(id)) return invalidIdResult("id", id);
      const wait = input.wait !== false;
      if (input.enable === true) {
        const body: Record<string, unknown> = {
          type: typeof input.type === "string" ? input.type : "linux64",
        };
        // Never silently drop a value the caller believes it sent (refs #54 QA).
        // The central validator accepts a scalar where an array is declared -
        // that leniency exists for repeatable QUERY parameters, and `ssh_keys` is
        // the repo's only array parameter that goes into the BODY. Before this,
        // `ssh_keys: 42` reported success and put the server into rescue mode
        // WITHOUT the requested key. Normalise instead of ignoring; anything that
        // is neither an array nor a usable id is refused rather than dropped.
        if (input.ssh_keys !== undefined && input.ssh_keys !== null) {
          const keys = Array.isArray(input.ssh_keys) ? input.ssh_keys : [input.ssh_keys];
          const bad = keys.findIndex((k) => !isResourceId(k));
          if (bad !== -1) return invalidIdResult(`ssh_keys[${bad}]`, keys[bad]);
          body.ssh_keys = keys;
        }
        return runServerAction(deps, id, "enable_rescue", body, wait, "hcloud_server_rescue", ctx?.signal);
      }
      return runServerAction(deps, id, "disable_rescue", undefined, wait, "hcloud_server_rescue", ctx?.signal);
    },
  };
}
