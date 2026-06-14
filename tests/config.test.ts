import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  const original = { ...process.env };

  beforeEach(() => {
    for (const key of [
      "HETZNER_API_TOKEN",
      "HETZNER_API_BASE",
      "HETZNER_CONFIRM_WRITES",
      "LOG_LEVEL",
      "HTTP_TIMEOUT_MS",
      "ACTION_POLL_TIMEOUT_MS",
      "ACTION_POLL_INTERVAL_MS",
      "PAGINATION_MAX_ITEMS",
      "PAGINATION_MAX_PAGES",
    ]) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = { ...original };
  });

  it("returns parsed config when token is set", () => {
    const cfg = loadConfig({ HETZNER_API_TOKEN: "abc" });
    expect(cfg.token).toBe("abc");
    expect(cfg.baseUrl).toBe("https://api.hetzner.cloud/v1");
    expect(cfg.confirmWrites).toBe(false);
    expect(cfg.logLevel).toBe("warn");
    expect(cfg.httpTimeoutMs).toBe(30_000);
    expect(cfg.actionPollTimeoutMs).toBe(60_000);
    expect(cfg.paginationMaxItems).toBe(500);
  });

  it("throws when token is missing", () => {
    expect(() => loadConfig({})).toThrow(/HETZNER_API_TOKEN/);
  });

  it("respects overrides", () => {
    const cfg = loadConfig({
      HETZNER_API_TOKEN: "x",
      HETZNER_API_BASE: "https://example/v1",
      HETZNER_CONFIRM_WRITES: "true",
      LOG_LEVEL: "debug",
      HTTP_TIMEOUT_MS: "5000",
      PAGINATION_MAX_ITEMS: "100",
    });
    expect(cfg.baseUrl).toBe("https://example/v1");
    expect(cfg.confirmWrites).toBe(true);
    expect(cfg.logLevel).toBe("debug");
    expect(cfg.httpTimeoutMs).toBe(5000);
    expect(cfg.paginationMaxItems).toBe(100);
  });

  it("falls back to defaults on garbage numeric input", () => {
    const cfg = loadConfig({
      HETZNER_API_TOKEN: "x",
      HTTP_TIMEOUT_MS: "not-a-number",
    });
    expect(cfg.httpTimeoutMs).toBe(30_000);
  });

  it("rejects invalid log level by falling back to warn", () => {
    const cfg = loadConfig({
      HETZNER_API_TOKEN: "x",
      LOG_LEVEL: "verbose",
    });
    expect(cfg.logLevel).toBe("warn");
  });
});
