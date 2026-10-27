import type { Logger } from "pino";
import type { Config } from "./config.js";
import { HetznerHttpClient } from "./http/client.js";
import { ToolRegistry } from "./tools/registry.js";
import { makeServerListTool } from "./tools/wrappers/server_list.js";
import { makeServerGetTool } from "./tools/wrappers/server_get.js";
import { makeServerPowerTool } from "./tools/wrappers/server_power.js";
import { makeServerRebuildTool } from "./tools/wrappers/server_rebuild.js";
import { makeServerChangeTypeTool } from "./tools/wrappers/server_change_type.js";
import { makeServerSnapshotTool } from "./tools/wrappers/server_snapshot.js";
import { makeServerBackupTool } from "./tools/wrappers/server_backup.js";
import { makeServerRescueTool } from "./tools/wrappers/server_rescue.js";
import { makeServerMetricsTool } from "./tools/wrappers/server_metrics.js";
import { makeApplyFirewallToServerTool } from "./tools/wrappers/apply_firewall_to_server.js";
import { makeRawRequestTool } from "./tools/raw_request.js";
import { makeWaitActionTool } from "./tools/wait_action.js";
import { withConfirmGuard } from "./tools/confirm.js";
import { globMatcher, withCallPolicy } from "./tools/policy.js";
import { OPERATIONS } from "./tools/generated/operations.js";
import { buildGeneratedTools } from "./tools/generated/tools.js";
import type { ToolDef } from "./types.js";

/**
 * Builds the full tool registry exactly as the stdio server exposes it.
 * The optional `fetch` lets tests swap in a fake upstream; production passes none.
 */
export function buildRegistry(
  config: Config,
  opts: { fetch?: typeof globalThis.fetch; logger?: Logger } = {},
): ToolRegistry {
  const client = new HetznerHttpClient({
    baseUrl: config.baseUrl,
    token: config.token,
    timeoutMs: config.httpTimeoutMs,
    maxRetryDelayMs: config.httpMaxRetryDelayMs,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });

  const registry = new ToolRegistry();
  const limits = {
    maxItems: config.paginationMaxItems,
    maxPages: config.paginationMaxPages,
    timeoutMs: config.paginationTimeoutMs,
  };

  const policy = { readOnly: config.readOnly, denyTools: config.denyTools };

  // The call policy wraps the confirm guard, so a blocked tool shows no preview.
  function register(reg: ToolRegistry, tool: ToolDef): void {
    reg.register(withCallPolicy(withConfirmGuard(tool, config.confirmWrites), policy));
  }

  register(registry, makeServerListTool(client, limits));
  register(registry, makeServerGetTool(client));

  const actionPoll = {
    timeoutMs: config.actionPollTimeoutMs,
    intervalMs: config.actionPollIntervalMs,
    ...(opts.logger ? { logger: opts.logger } : {}),
  };
  const actionDeps = { client, actionPoll };

  register(registry, makeServerPowerTool(actionDeps));
  register(registry, makeServerRebuildTool(actionDeps));
  register(registry, makeServerChangeTypeTool(actionDeps));
  register(registry, makeServerSnapshotTool(actionDeps));
  register(registry, makeServerBackupTool(actionDeps));
  register(registry, makeServerRescueTool(actionDeps));
  register(registry, makeServerMetricsTool({ client }));
  register(registry, makeApplyFirewallToServerTool({ client, actionPoll }));

  for (const tool of buildGeneratedTools(client, OPERATIONS, { ...limits, actionPoll })) {
    // Wrapper takes precedence on name collision (wrappers register first, generated tools have _raw suffix)
    if (registry.getByName(tool.name)) continue;
    register(registry, tool);
  }

  // raw_request handles confirm-mode itself (only for non-GET methods per spec §16).
  // Bypass withConfirmGuard so GET passes through even when HETZNER_CONFIRM_WRITES=true.
  registry.register(
    withCallPolicy(makeRawRequestTool({ client, confirmWrites: config.confirmWrites }), policy),
  );
  register(registry, makeWaitActionTool({
    client,
    defaultPoll: actionPoll,
  }));

  // A deny pattern that matches nothing is most likely a typo or a gateway-prefixed
  // name; stop like HETZNER_READ_ONLY does, so the switch never silently does nothing.
  const names = registry.getAll().map((t) => t.name);
  for (const pattern of config.denyTools) {
    const matches = globMatcher(pattern);
    if (!names.some((n) => matches(n))) {
      throw new Error(
        `HETZNER_DENY_TOOLS pattern "${pattern}" matches no tool (patterns use the server's own hcloud_* names)`,
      );
    }
  }

  return registry;
}
