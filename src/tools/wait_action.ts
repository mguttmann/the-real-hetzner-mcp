import type { ToolDef, ToolResult } from "../types.js";
import type { HetznerHttpClient } from "../http/client.js";
import { pollAction, type PollOptions } from "../http/action-polling.js";
import { invalidIdResult, isResourceId } from "./_validate.js";

const MIN_INTERVAL_MS = 1_000;

export type WaitActionDeps = {
  client: HetznerHttpClient;
  defaultPoll: PollOptions;
};

export function makeWaitActionTool(deps: WaitActionDeps): ToolDef {
  return {
    name: "hcloud_wait_action",
    description:
      "Poll an existing Hetzner Cloud action until it reaches terminal status (success/error) or the timeout elapses. Returns the final action plus a polling_timed_out flag.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer", minimum: 1 },
        timeout_ms: { type: "integer", minimum: 1, description: "Override the default poll timeout for this call." },
        interval_ms: { type: "integer", minimum: 1, description: "Override the default poll interval for this call." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    handler: async (input, ctx): Promise<ToolResult> => {
      const id = input.id;
      if (!isResourceId(id)) return invalidIdResult("id", id);
      // Caller overrides are clamped here, not in the schema (a `maximum` would
      // change the tool fingerprint): timeout_ms can shorten the configured
      // budget (ACTION_POLL_TIMEOUT_MS, kept below the caller's call timeout)
      // but not extend it, and interval_ms cannot poll faster than once a
      // second (Hetzner refills one request per second) unless the configured
      // interval is already shorter.
      const base = deps.defaultPoll;
      const minIntervalMs = Math.min(MIN_INTERVAL_MS, base.intervalMs);
      const opts: PollOptions = {
        timeoutMs: typeof input.timeout_ms === "number" ? Math.min(input.timeout_ms, base.timeoutMs) : base.timeoutMs,
        intervalMs: typeof input.interval_ms === "number" ? Math.max(input.interval_ms, minIntervalMs) : base.intervalMs,
        ...(deps.defaultPoll.sleep ? { sleep: deps.defaultPoll.sleep } : {}),
        ...(deps.defaultPoll.now ? { now: deps.defaultPoll.now } : {}),
        ...(ctx?.signal ? { signal: ctx.signal } : {}),
      };
      const result = await pollAction(
        deps.client.request.bind(deps.client) as Parameters<typeof pollAction>[0],
        id,
        opts,
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { action: result.action, polling_timed_out: result.timedOut },
              null,
              2,
            ),
          },
        ],
      };
    },
  };
}
