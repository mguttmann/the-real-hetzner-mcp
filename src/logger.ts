import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";
import type { LogLevel } from "./config.js";

/** The destination defaults to stderr; tests pass a stream to read the output. */
export function createLogger(level: LogLevel, destination?: DestinationStream): Logger {
  const opts: LoggerOptions = {
    level,
    redact: {
      paths: ["headers.authorization", "*.authorization", "*.HETZNER_API_TOKEN"],
      remove: true,
    },
  };
  return pino(opts, destination ?? pino.destination(2));
}
