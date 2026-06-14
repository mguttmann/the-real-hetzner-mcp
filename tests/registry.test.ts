import { describe, it, expect } from "vitest";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ToolDef } from "../src/types.js";

function makeTool(name: string): ToolDef {
  return {
    name,
    description: "test tool",
    inputSchema: { type: "object", properties: {}, required: [] },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
  };
}

describe("ToolRegistry", () => {
  it("starts empty", () => {
    const r = new ToolRegistry();
    expect(r.getAll()).toEqual([]);
    expect(r.size()).toBe(0);
  });

  it("registers and retrieves a tool", () => {
    const r = new ToolRegistry();
    const t = makeTool("hcloud_a");
    r.register(t);
    expect(r.size()).toBe(1);
    expect(r.getByName("hcloud_a")).toBe(t);
  });

  it("returns tools sorted by name", () => {
    const r = new ToolRegistry();
    r.register(makeTool("hcloud_z"));
    r.register(makeTool("hcloud_a"));
    r.register(makeTool("hcloud_m"));
    expect(r.getAll().map((t) => t.name)).toEqual([
      "hcloud_a",
      "hcloud_m",
      "hcloud_z",
    ]);
  });

  it("throws on duplicate names", () => {
    const r = new ToolRegistry();
    r.register(makeTool("hcloud_x"));
    expect(() => r.register(makeTool("hcloud_x"))).toThrow(/already registered/);
  });

  it("returns undefined for unknown names", () => {
    const r = new ToolRegistry();
    expect(r.getByName("nope")).toBeUndefined();
  });
});
