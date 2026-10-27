import type {
  JSONSchema,
  OperationDef,
  ParameterDef,
  ToolDef,
  ToolResult,
} from "../../types.js";
import type { HetznerHttpClient } from "../../http/client.js";
import { fetchAllPages } from "../../http/pagination.js";
import type { pollAction, PollOptions } from "../../http/action-polling.js";
import { asToolError } from "../_error.js";
import { pollAfterWrite } from "../_poll-write.js";
import { invalidPathValueResult, pathSegmentIssue } from "../_validate.js";

export type BuilderLimits = {
  maxItems: number;
  maxPages: number;
  /** Total time budget of an auto-paginated list (PAGINATION_TIMEOUT_MS). */
  timeoutMs?: number;
  actionPoll?: PollOptions;
};

type RequestFn = HetznerHttpClient["request"];

function inputSchemaFor(op: OperationDef): JSONSchema {
  const properties: Record<string, JSONSchema> = {};
  const required: string[] = [];

  for (const p of op.parameters) {
    properties[p.name] = {
      ...(p.schema as Record<string, unknown>),
      ...(p.description ? { description: p.description } : {}),
    };
    if (p.required) required.push(p.name);
  }
  if (op.requestBodySchema) {
    properties.body = op.requestBodySchema;
    if (op.requestBodyRequired) required.push("body");
  }
  if (op.returnsAction) {
    properties.wait = {
      type: "boolean",
      default: true,
      description: "Poll the resulting action until success/error or timeout.",
    };
  }
  // page/per_page convenience for list endpoints (top-level or per-resource action history)
  if (isListEndpoint(op)) {
    properties.auto_paginate = {
      type: "boolean",
      default: true,
      description: "Auto-merge all pages up to the soft-cap. Set false to use raw page/per_page.",
    };
  }

  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function buildPath(path: string, params: Record<string, unknown>): string {
  return path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const v = params[name];
    if (v === undefined || v === null) {
      throw new Error(`Missing path parameter "${name}" for ${path}`);
    }
    const text = String(v);
    // Depth guard: unreachable through a handler (invalidPathVar answers the
    // caller first), kept so the interpolation site itself cannot be misused.
    const issue = pathSegmentIssue(text);
    if (issue) {
      throw new Error(`Invalid path parameter "${name}" for ${path}: ${issue}.`);
    }
    return encodeURIComponent(text);
  });
}

/**
 * Caller-facing rejection for a path parameter that would not stay inside its own
 * segment. Encoding keeps the value in one segment as far as `new URL` is
 * concerned, but the origin decodes "%2f" and collapses ".." - see
 * pathSegmentIssue. Missing values stay with buildPath's own error.
 */
function invalidPathVar(pathVars: Record<string, unknown>): ToolResult | null {
  for (const [key, value] of Object.entries(pathVars)) {
    if (value === undefined || value === null) continue;
    const issue = pathSegmentIssue(String(value));
    if (issue) return invalidPathValueResult(key, value, issue);
  }
  return null;
}

function splitInput(op: OperationDef, input: Record<string, unknown>): {
  pathVars: Record<string, unknown>;
  query: Record<string, unknown>;
  body: unknown;
  wait: boolean;
  autoPaginate: boolean;
} {
  const pathVars: Record<string, unknown> = {};
  const query: Record<string, unknown> = {};
  const paramByName = new Map<string, ParameterDef>(
    op.parameters.map((p) => [p.name, p]),
  );
  for (const [k, v] of Object.entries(input)) {
    if (k === "body" || k === "wait" || k === "auto_paginate") continue;
    const p = paramByName.get(k);
    if (!p) continue; // ignore unknown - schema will have caught it server-side
    if (p.in === "path") pathVars[k] = v;
    else if (p.in === "query") query[k] = v;
  }
  return {
    pathVars,
    query,
    body: input.body,
    wait: input.wait !== false,
    autoPaginate: input.auto_paginate !== false,
  };
}

function isPathParam(seg: string): boolean {
  return seg.startsWith("{") && seg.endsWith("}");
}

function isListEndpoint(op: OperationDef): boolean {
  if (op.method !== "GET") return false;
  const segs = op.path.split("/").filter(Boolean);
  // Top-level list: /servers, /actions, /zones, ...
  if (segs.length === 1 && !isPathParam(segs[0]!)) return true;
  // Per-resource action history: /servers/{id}/actions, /zones/{id_or_name}/actions, ...
  if (
    segs.length === 3 &&
    !isPathParam(segs[0]!) &&
    isPathParam(segs[1]!) &&
    segs[2] === "actions"
  ) {
    return true;
  }
  return false;
}

/**
 * True when the endpoint is classified as a list AND its 200 response carries an
 * array under the resource key. GET /pricing passes isListEndpoint (one static
 * segment) but returns `pricing` as an object, so it must not be paginated. The
 * input schema still uses isListEndpoint, so `auto_paginate` stays in the
 * contract for /pricing.
 */
function paginates(op: OperationDef): boolean {
  if (!isListEndpoint(op)) return false;
  const props = (op.responseSchema as { properties?: Record<string, { type?: unknown }> } | undefined)
    ?.properties;
  if (!props) return true;
  return props[resourceKey(op)]?.type === "array";
}

function resourceKey(op: OperationDef): string {
  const segs = op.path.split("/").filter(Boolean);
  // Use the last non-param segment as the resource key. For /servers it's "servers";
  // for /servers/{id}/actions it's "actions".
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i]!;
    if (!isPathParam(s)) return s;
  }
  // Shouldn't happen on a list endpoint, but keep a safe fallback.
  return segs[0]!;
}

export function buildGeneratedTools(
  client: HetznerHttpClient,
  operations: OperationDef[],
  limits: BuilderLimits,
): ToolDef[] {
  const request: RequestFn = client.request.bind(client);

  return operations.map<ToolDef>((op) => ({
    name: op.toolName,
    description:
      [op.summary, op.description].filter(Boolean).join("\n\n") ||
      `${op.method} ${op.path}`,
    inputSchema: inputSchemaFor(op),
    annotations: {
      readOnlyHint: op.method === "GET",
      destructiveHint: op.isDestructive,
      openWorldHint: true,
    },
    handler: async (rawInput, ctx): Promise<ToolResult> => {
      const signal = ctx?.signal;
      const { pathVars, query, body, wait, autoPaginate } = splitInput(op, rawInput);
      const badPathVar = invalidPathVar(pathVars);
      if (badPathVar) return badPathVar;
      const finalPath = buildPath(op.path, pathVars);

      // Auto-paginate list endpoints when no explicit page is given
      if (paginates(op) && autoPaginate && query.page === undefined) {
        const merged = await fetchAllPages<unknown>(
          request as Parameters<typeof fetchAllPages>[0],
          op.method,
          finalPath,
          query,
          {
            resourceKey: resourceKey(op),
            maxItems: limits.maxItems,
            maxPages: limits.maxPages,
            ...(limits.timeoutMs !== undefined ? { timeoutMs: limits.timeoutMs } : {}),
            ...(signal ? { signal } : {}),
          },
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  [resourceKey(op)]: merged.items,
                  truncated: merged.truncated,
                  pagination: merged.pagination ?? null,
                  ...(merged.note ? { note: merged.note } : {}),
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      const pollOpts = limits.actionPoll ?? { timeoutMs: 45_000, intervalMs: 2_000 };
      const startedAt = (pollOpts.now ?? Date.now)();
      const res = await request<{ action?: { id: number } } & Record<string, unknown>>(
        op.method,
        finalPath,
        {
          query: query as Record<string, string | number | boolean | undefined | null>,
          body,
          ...(signal ? { signal } : {}),
        },
      );

      // Hetzner 4xx/5xx -> typed error -> isError:true ToolResult
      const errResult = asToolError(res);
      if (errResult) return errResult;

      // If this returns an Action and caller wants to wait, poll it
      if (op.returnsAction && wait && res.body?.action?.id) {
        return pollAfterWrite(
          request as Parameters<typeof pollAction>[0],
          { ...res.body, action: res.body.action },
          signal ? { ...pollOpts, signal } : pollOpts,
          startedAt,
          op.toolName,
        );
      }

      return {
        content: [
          { type: "text", text: JSON.stringify(res.body ?? {}, null, 2) },
        ],
      };
    },
  }));
}
