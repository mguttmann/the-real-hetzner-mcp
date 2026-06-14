// Shared helper for action-dispatching wrappers. Not registered as an MCP tool.
import type { HetznerHttpClient } from "../../http/client.js";
import { pollAction, type PollOptions } from "../../http/action-polling.js";
import type { ToolResult } from "../../types.js";
import { asToolError } from "../_error.js";

export type ServerActionDeps = {
  client: HetznerHttpClient;
  actionPoll: PollOptions;
};

export async function runServerAction(
  deps: ServerActionDeps,
  serverId: number,
  action: string,
  body: Record<string, unknown> | undefined,
  wait: boolean,
): Promise<ToolResult> {
  const res = await deps.client.request<{ action?: { id: number } } & Record<string, unknown>>(
    "POST",
    `/servers/${serverId}/actions/${action}`,
    body ? { body } : {},
  );
  const errResult = asToolError(res);
  if (errResult) return errResult;
  if (!wait || !res.body?.action?.id) {
    return {
      content: [{ type: "text", text: JSON.stringify(res.body ?? {}, null, 2) }],
    };
  }
  const polled = await pollAction(
    deps.client.request.bind(deps.client) as Parameters<typeof pollAction>[0],
    res.body.action.id,
    deps.actionPoll,
  );
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          { ...(res.body ?? {}), action: polled.action, polling_timed_out: polled.timedOut },
          null,
          2,
        ),
      },
    ],
  };
}
