import { describe, it, expect } from "vitest";
import { HetznerApiError, mapErrorResponse, UPSTREAM_TEXT_MAX_CHARS } from "../src/http/errors.js";
import { describeError } from "../src/tools/_error.js";
import { HetznerHttpClient } from "../src/http/client.js";
import { createServer } from "node:net";

describe("mapErrorResponse", () => {
  it("returns null for 2xx responses", () => {
    expect(mapErrorResponse(200, { ok: true })).toBeNull();
  });

  it("extracts the Hetzner-shaped error envelope", () => {
    const err = mapErrorResponse(404, {
      error: { code: "not_found", message: "Server not found", details: { id: 42 } },
    });
    expect(err).toBeInstanceOf(HetznerApiError);
    expect(err!.status).toBe(404);
    expect(err!.code).toBe("not_found");
    expect(err!.message).toBe("Server not found");
    expect(err!.details).toEqual({ id: 42 });
  });

  it("falls back when body is not a Hetzner error envelope", () => {
    const err = mapErrorResponse(502, "Bad gateway");
    expect(err).toBeInstanceOf(HetznerApiError);
    expect(err!.code).toBe("upstream_error");
    expect(err!.message).toContain("Bad gateway");
  });

  it("marks a non-JSON body as upstream text and keeps the status", () => {
    const err = mapErrorResponse(502, "Bad gateway")!;
    expect(err.status).toBe(502);
    expect(err.message).toBe('upstream text (non-JSON body): "Bad gateway"');
    expect(String(err)).toBe('HetznerApiError[502 upstream_error]: upstream text (non-JSON body): "Bad gateway"');
  });

  it("caps a long non-JSON body and says how much was cut", () => {
    const body = "x".repeat(UPSTREAM_TEXT_MAX_CHARS + 5000);
    const err = mapErrorResponse(503, body)!;
    expect(err.status).toBe(503);
    expect(err.message.length).toBeLessThan(UPSTREAM_TEXT_MAX_CHARS + 200);
    expect(err.message).toContain(`[truncated, 5000 more characters]`);
    expect(err.message.startsWith('upstream text (non-JSON body): "xxx')).toBe(true);
  });

  it("falls back when body is undefined", () => {
    const err = mapErrorResponse(500, undefined);
    expect(err).toBeInstanceOf(HetznerApiError);
    expect(err!.status).toBe(500);
    expect(err!.code).toBe("upstream_error");
  });

  it("error instance message includes status and code", () => {
    const err = mapErrorResponse(409, {
      error: { code: "conflict", message: "already exists" },
    })!;
    expect(err.message).toBe("already exists");
    expect(String(err)).toContain("conflict");
    expect(String(err)).toContain("409");
  });
});

describe("describeError", () => {
  it("adds the cause code of a network failure", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
    const err = new TypeError("fetch failed", { cause });
    expect(describeError(err)).toBe("fetch failed (ECONNREFUSED)");
  });

  it("falls back to a short cause message when the cause has no code", () => {
    const err = new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
    expect(describeError(err)).toBe("fetch failed (unexpected redirect)");
    const long = new TypeError("fetch failed", { cause: new Error("y".repeat(1000)) });
    expect(describeError(long).length).toBeLessThan(250);
  });

  it("names ECONNREFUSED for a real refused connection through the client", async () => {
    // Bind a free port on loopback, close it again, then connect to it.
    const port = await new Promise<number>((resolve) => {
      const srv = createServer();
      srv.listen(0, "127.0.0.1", () => {
        const p = (srv.address() as { port: number }).port;
        srv.close(() => resolve(p));
      });
    });
    const client = new HetznerHttpClient({ baseUrl: `http://127.0.0.1:${port}/v1`, token: "t" });
    const err = await client.request("GET", "/servers").catch((e: unknown) => e);
    expect(describeError(err)).toBe("fetch failed (ECONNREFUSED)");
  });

  it("keeps errors without a cause unchanged", () => {
    expect(describeError(new Error("request timeout"))).toBe("request timeout");
    expect(describeError("plain")).toBe("plain");
  });
});
