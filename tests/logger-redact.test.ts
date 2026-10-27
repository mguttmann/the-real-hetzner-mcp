import { describe, it, expect } from "vitest";
import { createLogger } from "../src/logger.js";

// The redact paths are a safety net: nothing should log a token, but if a
// header object or an env object reaches the logger, these keys must not be
// written. Pinned here because pino 10 replaced the redaction library.
function capture(): { lines: () => Record<string, unknown>[]; stream: { write: (s: string) => void } } {
  const out: string[] = [];
  return {
    stream: { write: (s: string) => void out.push(s) },
    lines: () => out.join("").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

const SECRET = "hz-secret-token-value";

describe("logger redaction", () => {
  it("drops headers.authorization", () => {
    const c = capture();
    createLogger("info", c.stream).info({ headers: { authorization: `Bearer ${SECRET}`, accept: "x" } }, "m");
    const line = c.lines()[0]!;
    expect(line.headers).toEqual({ accept: "x" });
  });

  it("drops authorization one level deep under any key", () => {
    const c = capture();
    createLogger("info", c.stream).info({ req: { authorization: `Bearer ${SECRET}`, method: "GET" } }, "m");
    const line = c.lines()[0]!;
    expect(line.req).toEqual({ method: "GET" });
  });

  it("drops HETZNER_API_TOKEN one level deep under any key", () => {
    const c = capture();
    createLogger("info", c.stream).info({ env: { HETZNER_API_TOKEN: SECRET, LOG_LEVEL: "info" } }, "m");
    const line = c.lines()[0]!;
    expect(line.env).toEqual({ LOG_LEVEL: "info" });
  });

  it("writes the secret nowhere in the output", () => {
    const c = capture();
    const logger = createLogger("debug", c.stream);
    logger.warn({ headers: { authorization: SECRET } }, "a");
    logger.warn({ config: { HETZNER_API_TOKEN: SECRET } }, "b");
    logger.warn({ upstream: { authorization: SECRET } }, "c");
    expect(c.lines()).toHaveLength(3);
    expect(JSON.stringify(c.lines())).not.toContain(SECRET);
  });
});
