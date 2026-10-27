// Shared by every tool that writes and then waits for the resulting action.
// Not registered as an MCP tool.
import { pollAction, type Action, type PollOptions } from "../http/action-polling.js";
import type { ToolResult } from "../types.js";
import { describeError } from "./_error.js";

type WriteBody = { action: { id: number } } & Record<string, unknown>;

/**
 * Polls the action of a write that already succeeded and returns the write body
 * with the polled action. The write body is the only copy of a new resource id
 * or a one-time root_password, so a failed poll (network error, request
 * timeout, HTTP error) must not replace it with isError: the body comes back
 * with `polling_timed_out: true` and `polling_error`, like the timeout path.
 *
 * `startedAt` is taken (with the poll clock) before the write request, so the
 * poll budget covers the whole tool call.
 *
 * A poll failure is logged at warn with the tool and the action id only; the
 * write body may hold a one-time root_password and is never logged.
 */
export async function pollAfterWrite(
  request: Parameters<typeof pollAction>[0],
  body: WriteBody,
  poll: PollOptions,
  startedAt: number,
  tool: string,
): Promise<ToolResult> {
  let extra: Record<string, unknown>;
  try {
    const polled = await pollAction(
      request,
      body.action.id,
      { ...poll, startedAt },
      body.action as Action,
    );
    extra = { action: polled.action, polling_timed_out: polled.timedOut };
  } catch (err) {
    const error = describeError(err);
    if (!poll.signal?.aborted) {
      poll.logger?.warn(
        { tool, action_id: body.action.id, error },
        "action polling failed after a successful write",
      );
    }
    extra = { polling_timed_out: true, polling_error: error };
  }
  return {
    content: [{ type: "text", text: JSON.stringify({ ...body, ...extra }, null, 2) }],
  };
}
