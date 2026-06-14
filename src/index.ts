#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { HetznerHttpClient } from "./http/client.js";
import { createMcpServer } from "./server.js";
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
import { OPERATIONS } from "./tools/generated/operations.js";
import { buildGeneratedTools } from "./tools/generated/tools.js";
import type { ToolDef } from "./types.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const client = new HetznerHttpClient({
    baseUrl: config.baseUrl,
    token: config.token,
    timeoutMs: config.httpTimeoutMs,
  });

  const registry = new ToolRegistry();
  const limits = {
    maxItems: config.paginationMaxItems,
    maxPages: config.paginationMaxPages,
  };

  function register(reg: ToolRegistry, tool: ToolDef): void {
    reg.register(withConfirmGuard(tool, config.confirmWrites));
  }

  register(registry, makeServerListTool(client, limits));
  register(registry, makeServerGetTool(client));

  const actionPoll = {
    timeoutMs: config.actionPollTimeoutMs,
    intervalMs: config.actionPollIntervalMs,
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

  for (const tool of buildGeneratedTools(client, OPERATIONS, {
    maxItems: config.paginationMaxItems,
    maxPages: config.paginationMaxPages,
    actionPoll,
  })) {
    // Wrapper takes precedence on name collision (wrappers register first, generated tools have _raw suffix)
    if (registry.getByName(tool.name)) continue;
    register(registry, tool);
  }

  // raw_request handles confirm-mode itself (only for non-GET methods per spec §16).
  // Bypass withConfirmGuard so GET passes through even when HETZNER_CONFIRM_WRITES=true.
  registry.register(makeRawRequestTool({ client, confirmWrites: config.confirmWrites }));
  register(registry, makeWaitActionTool({
    client,
    defaultPoll: actionPoll,
  }));

  const server = createMcpServer(registry, logger);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info({ tools: registry.size() }, "hetzner-cloud-mcp ready");
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
