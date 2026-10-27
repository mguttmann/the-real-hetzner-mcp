import type { ToolDef, ToolResult } from "../types.js";
import type { HetznerHttpClient, HttpMethod } from "../http/client.js";

const VALID: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** %2F, %5C and %2E in any casing. */
const ENCODED_SEPARATOR = /%(2f|5c|2e)/i;

export type RawRequestDeps = {
  client: HetznerHttpClient;
  confirmWrites: boolean;
};

export function makeRawRequestTool(deps: RawRequestDeps): ToolDef {
  return {
    name: "hcloud_raw_request",
    description:
      "Escape hatch: issue an arbitrary request against the Hetzner Cloud API. The configured API token is sent and the client retries a 429, and a 5xx on methods other than POST, like every other tool. Pagination and action polling are not applied, and an HTTP error comes back as { status, body } instead of an error result. Use only when no dedicated tool fits.",
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
    handler: async (input, ctx): Promise<ToolResult> => {
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
      // The origin decodes an encoded separator or dot before routing, so inside
      // one segment it would still change the addressed path (B-020).
      if (ENCODED_SEPARATOR.test(path)) {
        return {
          content: [
            {
              type: "text",
              text: `Path must not contain a percent-encoded "/", "\\" or "." (%2F, %5C, %2E), got: ${JSON.stringify(path)}.`,
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
                `PREVIEW: would execute hcloud_raw_request\n` +
                `Input: ${JSON.stringify(preview, null, 2)}\n` +
                `To execute, retry the same call with confirm: "YES".`,
            },
          ],
        };
      }
      const res = await deps.client.request(method, path, {
        query: input.query as Record<string, string | number | boolean | undefined | null> | undefined,
        body: input.body,
        ...(ctx?.signal ? { signal: ctx.signal } : {}),
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
