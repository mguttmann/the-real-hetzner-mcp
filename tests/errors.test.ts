import { describe, it, expect } from "vitest";
import { HetznerApiError, mapErrorResponse } from "../src/http/errors.js";

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
