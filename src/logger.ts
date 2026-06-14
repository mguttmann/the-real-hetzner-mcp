import pino, { type Logger, type LoggerOptions } from "pino";
import type { LogLevel } from "./config.js";

export function createLogger(level: LogLevel): Logger {
  const opts: LoggerOptions = {
    level,
    redact: {
      paths: ["headers.authorization", "*.authorization", "*.HETZNER_API_TOKEN"],
      remove: true,
    },
  };
  return pino(opts, pino.destination(2));
}
