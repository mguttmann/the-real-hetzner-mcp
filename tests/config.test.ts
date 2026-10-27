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
      "HTTP_MAX_RETRY_DELAY_MS",
      "PAGINATION_TIMEOUT_MS",
      "MAX_OUTPUT_BYTES",
      "HETZNER_READ_ONLY",
      "HETZNER_DENY_TOOLS",
      "MCP_SERVE_MODERN_PROTOCOL",
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
    expect(cfg.actionPollTimeoutMs).toBe(45_000);
    expect(cfg.httpMaxRetryDelayMs).toBe(10_000);
    expect(cfg.paginationMaxItems).toBe(500);
    expect(cfg.actionPollIntervalMs).toBe(2_000);
    expect(cfg.paginationMaxPages).toBe(10);
    expect(cfg.paginationTimeoutMs).toBe(45_000);
    expect(cfg.maxOutputBytes).toBe(8 * 1024 * 1024);
    expect(cfg.readOnly).toBe(false);
    expect(cfg.denyTools).toEqual([]);
    expect(cfg.serveModernProtocol).toBe(false);
  });

  it("reads MCP_SERVE_MODERN_PROTOCOL (B-023)", () => {
    expect(loadConfig({ HETZNER_API_TOKEN: "x", MCP_SERVE_MODERN_PROTOCOL: "true" }).serveModernProtocol).toBe(true);
    expect(loadConfig({ HETZNER_API_TOKEN: "x", MCP_SERVE_MODERN_PROTOCOL: "0" }).serveModernProtocol).toBe(false);
    // An unknown value keeps today's behaviour.
    expect(loadConfig({ HETZNER_API_TOKEN: "x", MCP_SERVE_MODERN_PROTOCOL: "maybe" }).serveModernProtocol).toBe(false);
  });

  it("reads HETZNER_READ_ONLY and refuses an unknown value (B-016)", () => {
    expect(loadConfig({ HETZNER_API_TOKEN: "x", HETZNER_READ_ONLY: "true" }).readOnly).toBe(true);
    expect(loadConfig({ HETZNER_API_TOKEN: "x", HETZNER_READ_ONLY: "1" }).readOnly).toBe(true);
    expect(loadConfig({ HETZNER_API_TOKEN: "x", HETZNER_READ_ONLY: "no" }).readOnly).toBe(false);
    expect(loadConfig({ HETZNER_API_TOKEN: "x", HETZNER_READ_ONLY: "" }).readOnly).toBe(false);
    // A typo in a safety switch must not silently leave writes open.
    expect(() => loadConfig({ HETZNER_API_TOKEN: "x", HETZNER_READ_ONLY: "on" })).toThrow(/HETZNER_READ_ONLY/);
  });

  it("reads HETZNER_DENY_TOOLS as a comma-separated list (B-016)", () => {
    expect(
      loadConfig({ HETZNER_API_TOKEN: "x", HETZNER_DENY_TOOLS: " hcloud_delete_* ,,hcloud_raw_request, " }).denyTools,
    ).toEqual(["hcloud_delete_*", "hcloud_raw_request"]);
  });

  it("reads MAX_OUTPUT_BYTES and never goes above the default", () => {
    expect(loadConfig({ HETZNER_API_TOKEN: "x", MAX_OUTPUT_BYTES: "100000" }).maxOutputBytes).toBe(100_000);
    expect(loadConfig({ HETZNER_API_TOKEN: "x", MAX_OUTPUT_BYTES: "nope" }).maxOutputBytes).toBe(8 * 1024 * 1024);
    // Above 8 MiB the stdio line limit (10 MiB) of the reader could be hit.
    expect(loadConfig({ HETZNER_API_TOKEN: "x", MAX_OUTPUT_BYTES: "52428800" }).maxOutputBytes).toBe(8 * 1024 * 1024);
  });

  it("reads PAGINATION_TIMEOUT_MS", () => {
    expect(loadConfig({ HETZNER_API_TOKEN: "x", PAGINATION_TIMEOUT_MS: "20000" }).paginationTimeoutMs).toBe(20_000);
    expect(loadConfig({ HETZNER_API_TOKEN: "x", PAGINATION_TIMEOUT_MS: "0" }).paginationTimeoutMs).toBe(45_000);
  });

  it("with defaults, one tool call fits inside the 60 s gateway call timeout", () => {
    // ACTION_POLL_TIMEOUT_MS is a wall-clock budget from the start of the tool
    // call (write request, poll requests and their retry delays included), and
    // HTTP_TIMEOUT_MS bounds one request including its retries. So the worst
    // case is the larger of the two; tests/call-budget.test.ts measures it.
    const cfg = loadConfig({ HETZNER_API_TOKEN: "abc" });
    const GATEWAY_CALL_TIMEOUT_MS = 60_000;
    expect(cfg.httpMaxRetryDelayMs).toBeLessThan(cfg.httpTimeoutMs);
    expect(Math.max(cfg.httpTimeoutMs, cfg.actionPollTimeoutMs, cfg.paginationTimeoutMs)).toBeLessThan(GATEWAY_CALL_TIMEOUT_MS);
  });

  it("reads HTTP_MAX_RETRY_DELAY_MS", () => {
    expect(loadConfig({ HETZNER_API_TOKEN: "x", HTTP_MAX_RETRY_DELAY_MS: "2500" }).httpMaxRetryDelayMs).toBe(2500);
    expect(loadConfig({ HETZNER_API_TOKEN: "x", HTTP_MAX_RETRY_DELAY_MS: "nope" }).httpMaxRetryDelayMs).toBe(10_000);
  });

  it("accepts an https base URL and http only on a loopback host (B-021)", () => {
    for (const base of [
      "https://api.hetzner.cloud/v1",
      "https://example/v1",
      "http://127.0.0.1:1/v1",
      "http://localhost:8787/v1",
      "http://[::1]:9/v1",
    ]) {
      expect(loadConfig({ HETZNER_API_TOKEN: "x", HETZNER_API_BASE: base }).baseUrl).toBe(base);
    }
  });

  it("refuses any other base URL at startup (B-021)", () => {
    for (const base of [
      "http://api.hetzner.cloud/v1",
      "http://10.0.0.1/v1",
      "http://localhost.example.com/v1",
      "ftp://api.hetzner.cloud/v1",
      "file:///etc/passwd",
      "api.hetzner.cloud/v1",
      "",
    ]) {
      expect(() => loadConfig({ HETZNER_API_TOKEN: "x", HETZNER_API_BASE: base }), base).toThrow(
        /HETZNER_API_BASE/,
      );
    }
  });

  it("does not echo credentials from a refused base URL (B-021)", () => {
    expect(() =>
      loadConfig({ HETZNER_API_TOKEN: "x", HETZNER_API_BASE: "http://user:s3cret@example.com/v1" }),
    ).toThrow(/^(?!.*s3cret)/s);
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
