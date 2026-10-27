import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { DEFAULT_MAX_OUTPUT_BYTES } from "./tools/output-cap.js";

/**
 * The .env file of the package itself (next to package.json), not of the working
 * directory: whoever controls the cwd must not be able to set HETZNER_API_BASE.
 * Variables that are already set (for example by `node --env-file=...`) win.
 * `quiet` keeps dotenv off stdout and stderr; stdout carries the MCP protocol.
 */
export const PACKAGE_ENV_FILE = fileURLToPath(new URL("../.env", import.meta.url));
loadDotenv({ path: PACKAGE_ENV_FILE, quiet: true });

export type LogLevel = "debug" | "info" | "warn" | "error";

export type Config = {
  token: string;
  baseUrl: string;
  confirmWrites: boolean;
  logLevel: LogLevel;
  httpTimeoutMs: number;
  httpMaxRetryDelayMs: number;
  actionPollTimeoutMs: number;
  actionPollIntervalMs: number;
  paginationMaxItems: number;
  paginationMaxPages: number;
  paginationTimeoutMs: number;
  maxOutputBytes: number;
  readOnly: boolean;
  denyTools: string[];
  /** MCP_SERVE_MODERN_PROTOCOL: also serve the 2026-07-28 revision over stdio. */
  serveModernProtocol: boolean;
};

const DEFAULTS = {
  baseUrl: "https://api.hetzner.cloud/v1",
  confirmWrites: false,
  logLevel: "warn" as LogLevel,
  httpTimeoutMs: 30_000,
  httpMaxRetryDelayMs: 10_000,
  // Wall-clock budget from the start of a wait=true tool call. Kept below a
  // 60 s client call timeout so the caller gets the write body with
  // polling_timed_out instead of a client timeout.
  actionPollTimeoutMs: 45_000,
  actionPollIntervalMs: 2_000,
  paginationMaxItems: 500,
  paginationMaxPages: 10,
  // Wall-clock budget of one auto-paginated list, below a 60 s client call
  // timeout like actionPollTimeoutMs.
  paginationTimeoutMs: 45_000,
  readOnly: false,
  serveModernProtocol: false,
} as const;

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return fallback;
}

/**
 * Like parseBool, but an unknown value stops the server: a typo in a safety
 * switch must not silently leave writes open. Unset or empty means the fallback.
 */
function parseStrictBool(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const v = value.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  throw new Error(`${name} must be true, 1, yes, false, 0 or no.`);
}

/** Comma-separated list; entries are trimmed, empty ones dropped. */
function parseList(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.trunc(n);
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * HETZNER_API_BASE must be https; plain http only for a loopback host (tests,
 * a local fake upstream). The token goes wherever this points, so anything
 * else stops the server at startup. The error names only scheme and host.
 */
function parseBaseUrl(value: string | undefined): string {
  if (value === undefined) return DEFAULTS.baseUrl;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("HETZNER_API_BASE is not a valid absolute URL.");
  }
  if (url.protocol === "https:") return value;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return value;
  throw new Error(
    `HETZNER_API_BASE must use https (http only for localhost, 127.0.0.1 or ::1), got ${url.protocol}//${url.host}.`,
  );
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }
  return DEFAULTS.logLevel;
}

export function loadConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Config {
  const token = env.HETZNER_API_TOKEN;
  if (!token) {
    throw new Error(
      "HETZNER_API_TOKEN is required. Set it in .env or your environment.",
    );
  }
  return {
    token,
    baseUrl: parseBaseUrl(env.HETZNER_API_BASE),
    confirmWrites: parseBool(env.HETZNER_CONFIRM_WRITES, DEFAULTS.confirmWrites),
    logLevel: parseLogLevel(env.LOG_LEVEL),
    httpTimeoutMs: parsePositiveInt(env.HTTP_TIMEOUT_MS, DEFAULTS.httpTimeoutMs),
    httpMaxRetryDelayMs: parsePositiveInt(
      env.HTTP_MAX_RETRY_DELAY_MS,
      DEFAULTS.httpMaxRetryDelayMs,
    ),
    actionPollTimeoutMs: parsePositiveInt(
      env.ACTION_POLL_TIMEOUT_MS,
      DEFAULTS.actionPollTimeoutMs,
    ),
    actionPollIntervalMs: parsePositiveInt(
      env.ACTION_POLL_INTERVAL_MS,
      DEFAULTS.actionPollIntervalMs,
    ),
    paginationMaxItems: parsePositiveInt(
      env.PAGINATION_MAX_ITEMS,
      DEFAULTS.paginationMaxItems,
    ),
    paginationMaxPages: parsePositiveInt(
      env.PAGINATION_MAX_PAGES,
      DEFAULTS.paginationMaxPages,
    ),
    paginationTimeoutMs: parsePositiveInt(
      env.PAGINATION_TIMEOUT_MS,
      DEFAULTS.paginationTimeoutMs,
    ),
    // The default is also the ceiling: above it one result line could exceed
    // the 10 MiB stdio line limit of the reader.
    maxOutputBytes: Math.min(
      parsePositiveInt(env.MAX_OUTPUT_BYTES, DEFAULT_MAX_OUTPUT_BYTES),
      DEFAULT_MAX_OUTPUT_BYTES,
    ),
    readOnly: parseStrictBool("HETZNER_READ_ONLY", env.HETZNER_READ_ONLY, DEFAULTS.readOnly),
    denyTools: parseList(env.HETZNER_DENY_TOOLS),
    serveModernProtocol: parseBool(env.MCP_SERVE_MODERN_PROTOCOL, DEFAULTS.serveModernProtocol),
  };
}
