import type { ToolDef, ToolResult } from "../types.js";
import type { HetznerHttpClient } from "../http/client.js";
import { pollAction, type PollOptions } from "../http/action-polling.js";

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
    handler: async (input): Promise<ToolResult> => {
      const id = input.id as number;
      const opts: PollOptions = {
        timeoutMs: typeof input.timeout_ms === "number" ? input.timeout_ms : deps.defaultPoll.timeoutMs,
        intervalMs: typeof input.interval_ms === "number" ? input.interval_ms : deps.defaultPoll.intervalMs,
        ...(deps.defaultPoll.sleep ? { sleep: deps.defaultPoll.sleep } : {}),
        ...(deps.defaultPoll.now ? { now: deps.defaultPoll.now } : {}),
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
