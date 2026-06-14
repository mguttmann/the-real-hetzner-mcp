import type { ToolDef, ToolResult } from "../../types.js";
import type { HetznerHttpClient } from "../../http/client.js";
import { asToolError } from "../_error.js";

type Server = { id: number; name: string; [k: string]: unknown };

function errorResult(message: string): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

export function makeServerGetTool(client: HetznerHttpClient): ToolDef {
  return {
    name: "hcloud_get_server",
    description:
      "Fetch a single Hetzner Cloud server by numeric id OR by exact name. Hand-tuned wrapper; use hcloud_get_server_raw for the id-only generated tool.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer", minimum: 1 },
        name: { type: "string", minLength: 1 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    handler: async (input) => {
      const hasId = typeof input.id === "number";
      const hasName = typeof input.name === "string";
      if (hasId === hasName) {
        return errorResult("Provide exactly one of `id` or `name`.");
      }

      if (hasId) {
        const res = await client.request<{ server: Server }>(
          "GET",
          `/servers/${input.id}`,
        );
        const errResult = asToolError(res);
        if (errResult) return errResult;
        if (!res.body?.server) {
          return errorResult(`Server with id=${input.id} not found.`);
        }
        return {
          content: [{ type: "text", text: JSON.stringify(res.body, null, 2) }],
        };
      }

      const res = await client.request<{ servers: Server[] }>(
        "GET",
        "/servers",
        { query: { name: input.name as string } },
      );
      const errResult = asToolError(res);
      if (errResult) return errResult;
      const found = res.body?.servers?.[0];
      if (!found) {
        return errorResult(`Server with name="${input.name}" not found.`);
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ server: found }, null, 2) }],
      };
    },
  };
}
