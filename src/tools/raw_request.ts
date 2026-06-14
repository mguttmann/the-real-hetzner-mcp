import type { ToolDef, ToolResult } from "../types.js";
import type { HetznerHttpClient, HttpMethod } from "../http/client.js";

const VALID: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

export type RawRequestDeps = {
  client: HetznerHttpClient;
  confirmWrites: boolean;
};

export function makeRawRequestTool(deps: RawRequestDeps): ToolDef {
  return {
    name: "hcloud_raw_request",
    description:
      "Escape hatch: issue an arbitrary request against the Hetzner Cloud API. Bearer auth, retries and pagination are NOT applied automatically — this is a pass-through. Use only when no dedicated tool fits.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", enum: VALID },
        path: {
          type: "string",
          pattern: "^/.+",
          description: "Path beginning with '/', e.g. '/servers/42/actions/poweron'.",
        },
        query: { type: "object", additionalProperties: true },
        body: {
          type: ["object", "array", "string", "number", "boolean", "null"],
          description: "Request body, JSON-serialised when sent.",
        },
        confirm: {
          type: "string",
          enum: ["YES"],
          description:
            'Required when HETZNER_CONFIRM_WRITES=true and method is not GET. Set to "YES" to actually execute; without it the tool returns a preview only. Ignored for GET and when confirm mode is disabled.',
        },
      },
      required: ["method", "path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    handler: async (input): Promise<ToolResult> => {
      const method = input.method as HttpMethod;
      const path = input.path as string;
      if (!VALID.includes(method)) {
        return {
          content: [
            {
              type: "text",
              text: `Unsupported method "${String(input.method)}". Allowed: ${VALID.join(", ")}.`,
            },
          ],
          isError: true,
        };
      }
      if (typeof path !== "string" || !path.startsWith("/")) {
        return {
          content: [
            {
              type: "text",
              text: `Path must start with "/", got: ${JSON.stringify(input.path)}.`,
            },
          ],
          isError: true,
        };
      }
      const isWrite = method !== "GET";
      if (isWrite && deps.confirmWrites && input.confirm !== "YES") {
        const { confirm: _drop, ...preview } = input;
        return {
          content: [
            {
              type: "text",
              text:
                `PREVIEW — would execute hcloud_raw_request\n` +
                `Input: ${JSON.stringify(preview, null, 2)}\n` +
                `To execute, retry the same call with confirm: "YES".`,
            },
          ],
        };
      }
      const res = await deps.client.request(method, path, {
        query: input.query as Record<string, string | number | boolean | undefined | null> | undefined,
        body: input.body,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: res.status,
                body: res.body ?? null,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  };
}
