import { describe, it, expect, vi } from "vitest";
import { makeRawRequestTool } from "../src/tools/raw_request.js";

describe("hcloud_raw_request", () => {
  it("forwards method, path, query, body verbatim", async () => {
    const request = vi.fn(async () => ({
      status: 200,
      headers: new Headers(),
      body: { ok: true },
    }));
    const tool = makeRawRequestTool({
      client: { request } as any,
      confirmWrites: false,
    });
    await tool.handler({
      method: "POST",
      path: "/networks",
      query: { foo: "bar" },
      body: { name: "test" },
    });
    expect(request).toHaveBeenCalledWith("POST", "/networks", {
      query: { foo: "bar" },
      body: { name: "test" },
    });
  });

  it("rejects unsupported methods", async () => {
    const tool = makeRawRequestTool({
      client: { request: vi.fn() } as any,
      confirmWrites: false,
    });
    const res = await tool.handler({ method: "OPTIONS", path: "/x" });
    expect(res.isError).toBe(true);
  });

  it("rejects paths that do not start with '/'", async () => {
    const tool = makeRawRequestTool({
      client: { request: vi.fn() } as any,
      confirmWrites: false,
    });
    const res = await tool.handler({ method: "GET", path: "servers" });
    expect(res.isError).toBe(true);
  });

  it("returns the raw response body and status", async () => {
    const request = vi.fn(async () => ({
      status: 201,
      headers: new Headers({ "x-foo": "bar" }),
      body: { created: 1 },
    }));
    const tool = makeRawRequestTool({
      client: { request } as any,
      confirmWrites: false,
    });
    const res = await tool.handler({ method: "POST", path: "/x", body: {} });
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed).toMatchObject({ status: 201, body: { created: 1 } });
  });

  it("declares openWorld and destructive=true (caller controls method)", () => {
    const tool = makeRawRequestTool({
      client: { request: vi.fn() } as any,
      confirmWrites: false,
    });
    expect(tool.annotations.destructiveHint).toBe(true);
    expect(tool.annotations.openWorldHint).toBe(true);
  });

  describe("confirm-mode (self-guarded per spec §16)", () => {
    it("passes GET through even when confirmWrites=true and no confirm provided", async () => {
      const request = vi.fn(async () => ({
        status: 200,
        headers: new Headers(),
        body: { servers: [] },
      }));
      const tool = makeRawRequestTool({
        client: { request } as any,
        confirmWrites: true,
      });
      const res = await tool.handler({ method: "GET", path: "/servers" });
      expect(request).toHaveBeenCalledWith("GET", "/servers", {
        query: undefined,
        body: undefined,
      });
      expect((res.content[0] as { text: string }).text).not.toMatch(/PREVIEW/i);
    });

    it("returns PREVIEW for POST when confirmWrites=true and confirm missing", async () => {
      const request = vi.fn();
      const tool = makeRawRequestTool({
        client: { request } as any,
        confirmWrites: true,
      });
      const res = await tool.handler({
        method: "POST",
        path: "/networks",
        body: { name: "n" },
      });
      expect(request).not.toHaveBeenCalled();
      expect((res.content[0] as { text: string }).text).toMatch(/PREVIEW/i);
      expect((res.content[0] as { text: string }).text).toMatch(/hcloud_raw_request/);
      expect(res.isError).toBeFalsy();
    });

    it("executes POST when confirmWrites=true and confirm='YES'", async () => {
      const request = vi.fn(async () => ({
        status: 201,
        headers: new Headers(),
        body: { id: 7 },
      }));
      const tool = makeRawRequestTool({
        client: { request } as any,
        confirmWrites: true,
      });
      const res = await tool.handler({
        method: "POST",
        path: "/networks",
        body: { name: "n" },
        confirm: "YES",
      });
      expect(request).toHaveBeenCalledWith("POST", "/networks", {
        query: undefined,
        body: { name: "n" },
      });
      expect((res.content[0] as { text: string }).text).not.toMatch(/PREVIEW/i);
    });

    it("guards PUT/PATCH/DELETE like POST when confirmWrites=true", async () => {
      for (const method of ["PUT", "PATCH", "DELETE"] as const) {
        const request = vi.fn();
        const tool = makeRawRequestTool({
          client: { request } as any,
          confirmWrites: true,
        });
        const res = await tool.handler({ method, path: "/x" });
        expect(request, `${method} should preview`).not.toHaveBeenCalled();
        expect(
          (res.content[0] as { text: string }).text,
          `${method} should produce PREVIEW`,
        ).toMatch(/PREVIEW/i);
      }
    });

    it("ignores confirm and passes through all methods when confirmWrites=false", async () => {
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
        const request = vi.fn(async () => ({
          status: 200,
          headers: new Headers(),
          body: null,
        }));
        const tool = makeRawRequestTool({
          client: { request } as any,
          confirmWrites: false,
        });
        await tool.handler({ method, path: "/x" });
        expect(request, `${method} should pass through`).toHaveBeenCalled();
      }
    });

    it("does not require confirm for GET when confirmWrites=true even if confirm is provided", async () => {
      const request = vi.fn(async () => ({
        status: 200,
        headers: new Headers(),
        body: null,
      }));
      const tool = makeRawRequestTool({
        client: { request } as any,
        confirmWrites: true,
      });
      await tool.handler({ method: "GET", path: "/servers", confirm: "YES" });
      expect(request).toHaveBeenCalled();
    });
  });

  describe("body schema", () => {
    it("declares an explicit type array for body in inputSchema", () => {
      const tool = makeRawRequestTool({
        client: { request: vi.fn() } as any,
        confirmWrites: false,
      });
      const props = (tool.inputSchema as any).properties;
      expect(props.body.type).toEqual([
        "object",
        "array",
        "string",
        "number",
        "boolean",
        "null",
      ]);
    });

    it("forwards non-object body values (e.g. string) to the client unchanged", async () => {
      const request = vi.fn(async () => ({
        status: 200,
        headers: new Headers(),
        body: null,
      }));
      const tool = makeRawRequestTool({
        client: { request } as any,
        confirmWrites: false,
      });
      await tool.handler({ method: "POST", path: "/x", body: "string body" });
      expect(request).toHaveBeenCalledWith("POST", "/x", {
        query: undefined,
        body: "string body",
      });
    });

    it("declares confirm in inputSchema (always present, even when guard inactive)", () => {
      const tool = makeRawRequestTool({
        client: { request: vi.fn() } as any,
        confirmWrites: false,
      });
      const props = (tool.inputSchema as any).properties;
      expect(props.confirm).toBeDefined();
      expect(props.confirm.enum).toEqual(["YES"]);
    });
  });
});
