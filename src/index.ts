#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { buildRegistry } from "./build-registry.js";
import { serve } from "./serve.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const registry = buildRegistry(config, { logger });

  await serve(registry, logger, {
    maxOutputBytes: config.maxOutputBytes,
    serveModernProtocol: config.serveModernProtocol,
  });
  logger.info(
    { tools: registry.size(), serveModernProtocol: config.serveModernProtocol },
    "hetzner-cloud-mcp ready",
  );
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
