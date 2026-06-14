import "dotenv/config";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type Config = {
  token: string;
  baseUrl: string;
  confirmWrites: boolean;
  logLevel: LogLevel;
  httpTimeoutMs: number;
  actionPollTimeoutMs: number;
  actionPollIntervalMs: number;
  paginationMaxItems: number;
  paginationMaxPages: number;
};

const DEFAULTS = {
  baseUrl: "https://api.hetzner.cloud/v1",
  confirmWrites: false,
  logLevel: "warn" as LogLevel,
  httpTimeoutMs: 30_000,
  actionPollTimeoutMs: 60_000,
  actionPollIntervalMs: 2_000,
  paginationMaxItems: 500,
  paginationMaxPages: 10,
} as const;

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return fallback;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.trunc(n);
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
    baseUrl: env.HETZNER_API_BASE ?? DEFAULTS.baseUrl,
    confirmWrites: parseBool(env.HETZNER_CONFIRM_WRITES, DEFAULTS.confirmWrites),
    logLevel: parseLogLevel(env.LOG_LEVEL),
    httpTimeoutMs: parsePositiveInt(env.HTTP_TIMEOUT_MS, DEFAULTS.httpTimeoutMs),
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
  };
}
