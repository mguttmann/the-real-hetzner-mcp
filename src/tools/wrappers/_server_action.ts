// Shared helper for action-dispatching wrappers. Not registered as an MCP tool.
import type { HetznerHttpClient } from "../../http/client.js";
import type { pollAction, PollOptions } from "../../http/action-polling.js";
import type { ToolResult } from "../../types.js";
import { asToolError } from "../_error.js";
import { pollAfterWrite } from "../_poll-write.js";
import { isResourceId } from "../_validate.js";

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
  tool: string,
  signal?: AbortSignal,
): Promise<ToolResult> {
  // Programming-error guard: every caller must have validated the id already.
  if (!isResourceId(serverId)) {
    throw new Error(
      `runServerAction: serverId must be an integer >= 1, got ${JSON.stringify(serverId)}.`,
    );
  }
  const startedAt = (deps.actionPoll.now ?? Date.now)();
  const res = await deps.client.request<{ action?: { id: number } } & Record<string, unknown>>(
    "POST",
    `/servers/${encodeURIComponent(String(serverId))}/actions/${encodeURIComponent(action)}`,
    { ...(body ? { body } : {}), ...(signal ? { signal } : {}) },
  );
  const errResult = asToolError(res);
  if (errResult) return errResult;
  if (!wait || !res.body?.action?.id) {
    return {
      content: [{ type: "text", text: JSON.stringify(res.body ?? {}, null, 2) }],
    };
  }
  return pollAfterWrite(
    deps.client.request.bind(deps.client) as Parameters<typeof pollAction>[0],
    { ...res.body, action: res.body.action },
    signal ? { ...deps.actionPoll, signal } : deps.actionPoll,
    startedAt,
    tool,
  );
}
