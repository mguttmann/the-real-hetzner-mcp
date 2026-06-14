import type { ToolDef, ToolResult } from "../../types.js";
import type { HetznerHttpClient } from "../../http/client.js";
import { asToolError } from "../_error.js";

const VALID_TYPES = ["cpu", "disk", "network"] as const;

export type MetricsDeps = {
  client: HetznerHttpClient;
  nowMs?: () => number;
};

export function makeServerMetricsTool(deps: MetricsDeps): ToolDef {
  const now = deps.nowMs ?? (() => Date.now());
  return {
    name: "hcloud_get_server_metrics",
    description:
      "Fetch a server's metrics (cpu / disk / network). Accept id OR name. Defaults to the last hour with step=60s. Hand-tuned wrapper.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer", minimum: 1 },
        name: { type: "string", minLength: 1 },
        type: { type: "string", enum: [...VALID_TYPES] },
        start: { type: "string", description: "ISO-8601 timestamp; default: now - 1 hour" },
        end: { type: "string", description: "ISO-8601 timestamp; default: now" },
        step: { type: "integer", minimum: 1, default: 60 },
      },
      required: ["type"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    handler: async (input): Promise<ToolResult> => {
      const type = input.type as string;
      if (!VALID_TYPES.includes(type as (typeof VALID_TYPES)[number])) {
        return { content: [{ type: "text", text: `Invalid type="${type}". Use one of: ${VALID_TYPES.join(", ")}.` }], isError: true };
      }

      let id: number | undefined = typeof input.id === "number" ? input.id : undefined;
      if (id === undefined) {
        if (typeof input.name !== "string") {
          return { content: [{ type: "text", text: "Provide either `id` or `name`." }], isError: true };
        }
        const lookup = await deps.client.request<{ servers: Array<{ id: number }> }>(
          "GET",
          "/servers",
          { query: { name: input.name } },
        );
        const lookupErr = asToolError(lookup);
        if (lookupErr) return lookupErr;
        const match = lookup.body?.servers?.[0];
        if (!match) {
          return { content: [{ type: "text", text: `Server with name="${input.name}" not found.` }], isError: true };
        }
        id = match.id;
      }

      const end = typeof input.end === "string" ? input.end : new Date(now()).toISOString();
      const start = typeof input.start === "string"
        ? input.start
        : new Date(now() - 60 * 60 * 1000).toISOString();
      const step = typeof input.step === "number" ? input.step : 60;

      const res = await deps.client.request(
        "GET",
        `/servers/${id}/metrics`,
        { query: { type, start, end, step } },
      );
      const errResult = asToolError(res);
      if (errResult) return errResult;
      return { content: [{ type: "text", text: JSON.stringify(res.body ?? {}, null, 2) }] };
    },
  };
}
